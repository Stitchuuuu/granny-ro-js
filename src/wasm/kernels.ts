// kernels.ts — AssemblyScript IGC decode kernels, compiled to kernels.wasm.
//
// Linear-memory ABI (the contract the rest of the granny-igc-wasm rollout
// extends). Compiled `--runtime stub` : there is NO in-wasm allocation — the
// JS caller owns every pointer. `scratchBase()` returns the first byte free of
// AS static data ; JS grows `memory`, writes inputs from that base, calls a
// kernel, reads outputs back. `grow` detaches the ArrayBuffer, so JS recreates
// its typed-array views per call.
//
// Session 1 ships `yuvToRGB` (the walking skeleton). Session 2 adds the arith
// range-coder + adaptive model (below) against this same base + memory ;
// sessions 3-4 add planeDecode / iDWT.

/** First linear-memory byte free of AS static data — the JS scratch base. */
export function scratchBase(): usize {
  return __heap_base;
}

/**
 * YUV-ish → RGBA8888 plane inversion. Byte-exact port of the JS `yuvToRGB`
 * (asm cite `granny2.dll @ 0x10009a30`).
 *
 * @param planesPtr - base of 4 contiguous S16 planes, each `count` elements :
 *   Y @ planesPtr, U @ +2*count, V @ +4*count, A @ +6*count (bytes).
 * @param count - width * height (pixel count).
 * @param rgbaPtr - output RGBA8888, `count * 4` bytes.
 */
export function yuvToRGB(planesPtr: usize, count: i32, rgbaPtr: usize): void {
  const c = <usize>count;
  const yP = planesPtr;
  const uP = planesPtr + (c << 1);
  const vP = planesPtr + (c << 2);
  const aP = planesPtr + c * 6;
  for (let i = 0; i < count; i++) {
    const off = (<usize>i) << 1;
    // load<i16> sign-extends the S16 plane value to i32 (PLANE_VALUE_OFFSET = 0).
    let r: i32 = <i32>load<i16>(uP + off);
    let g: i32 = <i32>load<i16>(yP + off);
    let b: i32 = <i32>load<i16>(vP + off);
    let a: i32 = <i32>load<i16>(aP + off);

    // i32 `/` is div_s = truncate-toward-zero = `(x/4)|0`, NOT an arith shift.
    g -= (r + b) / 4;
    r += g;
    b += g;

    r = r < 0 ? 0 : (r > 255 ? 255 : r);
    g = g < 0 ? 0 : (g > 255 ? 255 : g);
    b = b < 0 ? 0 : (b > 255 ? 255 : b);
    a = a < 0 ? 0 : (a > 255 ? 255 : a);

    const o: usize = rgbaPtr + ((<usize>i) << 2);
    store<u8>(o, <u8>r);
    store<u8>(o + 1, <u8>g);
    store<u8>(o + 2, <u8>b);
    store<u8>(o + 3, <u8>a);
  }
}

// ============================================================================
// Arith — range-coder + adaptive model. Byte-exact port of src/igc-arith.js
// (the JS oracle). State lives in JS-owned linear memory ; JS bump-allocates
// the coder (`ab`) + model (`a`) blocks + the compressed `buf` from
// `scratchBase()` and passes pointers in. The oracle's f64 mul-div becomes i64
// here — provably exact (`range ≤ 2^31`, `scale < 0x4000`, product `< 2^45`).
//
// Polymorphic return : `arithDecompress` returns the symbol value (0..65535)
// or, on escape, `-(slot + 1)` (no collision — symbols are u16 ≥ 0). The JS
// seam decodes the escape slot as `-ret - 1`.
// ============================================================================

// Bit-reverse LUTs (DLL 0x1002a4b4 / 0x1002a4c4 / precomputed BR8). Embedded as
// static data — no runtime allocation (matches `--runtime stub`).
const BR4_PTR: usize = memory.data<u8>([0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15]);
const BR3_PTR: usize = memory.data<u8>([0, 4, 2, 6, 1, 5, 3, 7]);
const BR8_PTR: usize = memory.data<u8>([
  0, 128, 64, 192, 32, 160, 96, 224, 16, 144, 80, 208, 48, 176, 112, 240,
  8, 136, 72, 200, 40, 168, 104, 232, 24, 152, 88, 216, 56, 184, 120, 248,
  4, 132, 68, 196, 36, 164, 100, 228, 20, 148, 84, 212, 52, 180, 116, 244,
  12, 140, 76, 204, 44, 172, 108, 236, 28, 156, 92, 220, 60, 188, 124, 252,
  2, 130, 66, 194, 34, 162, 98, 226, 18, 146, 82, 210, 50, 178, 114, 242,
  10, 138, 74, 202, 42, 170, 106, 234, 26, 154, 90, 218, 58, 186, 122, 250,
  6, 134, 70, 198, 38, 166, 102, 230, 22, 150, 86, 214, 54, 182, 118, 246,
  14, 142, 78, 206, 46, 174, 110, 238, 30, 158, 94, 222, 62, 190, 126, 254,
  1, 129, 65, 193, 33, 161, 97, 225, 17, 145, 81, 209, 49, 177, 113, 241,
  9, 137, 73, 201, 41, 169, 105, 233, 25, 153, 89, 217, 57, 185, 121, 249,
  5, 133, 69, 197, 37, 165, 101, 229, 21, 149, 85, 213, 53, 181, 117, 245,
  13, 141, 77, 205, 45, 173, 109, 237, 29, 157, 93, 221, 61, 189, 125, 253,
  3, 131, 67, 195, 35, 163, 99, 227, 19, 147, 83, 211, 51, 179, 115, 243,
  11, 139, 75, 203, 43, 171, 107, 235, 27, 155, 91, 219, 59, 187, 123, 251,
  7, 135, 71, 199, 39, 167, 103, 231, 23, 151, 87, 215, 55, 183, 119, 247,
  15, 143, 79, 207, 47, 175, 111, 239, 31, 159, 95, 223, 63, 191, 127, 255,
]);

// Rescale scratch — 16 × u32. Non-reentrant (single-threaded wasm).
const SCRATCH_PTR: usize = memory.data(64);

// `arithSearch` out-param (slotLo). Single-threaded — no reentrancy.
let g_slotLo: i32 = 0;

// Coder (`ab`) block field byte-offsets — 28 bytes total.
// @inline
const AB_BUF: usize = 0;       // bufPtr (usize)
// @inline
const AB_PTR: usize = 4;       // byte index into buf (u32)
// @inline
const AB_ACCUM: usize = 8;     // bit accumulator (u32)
// @inline
const AB_BITSLEFT: usize = 12; // bits buffered in accum (i32)
// @inline
const AB_HIGH: usize = 16;     // range high (u32)
// @inline
const AB_LOW: usize = 20;      // range low (u32)
// @inline
const AB_TARGET: usize = 24;   // encoded target (u32)

// Model (`a`) block field byte-offsets.
// @inline
const A_CUM: usize = 0;   // cumCounts[16] (u16 each — 32 bytes)
// @inline
const A_SL: usize = 32;   // singlesLength (u16)
// @inline
const A_BB: usize = 34;   // bandBoundary (u16)
// @inline
const A_SD: usize = 36;   // shiftDepth (u16)
// @inline
const A_BS: usize = 38;   // bucketSize (u16)
// @inline
const A_UC: usize = 40;   // uniqueCount (u16) ; +42 pad
// @inline
const A_SC: usize = 44;   // singleCounts[countsSize] (u16), then values[countsSize] (u16)

// values[] base — after the inline singleCounts. countsSize derives from the
// stored uniqueCount (= original uniqueValues), matching the JS oracle.
// @inline
function aValuesBase(a: usize): usize {
  const cs: i32 = ((<i32>load<u16>(a + A_UC)) + 5) & ~3;
  return a + A_SC + (<usize>cs) * 2;
}

// --- Range coder (the `arithBit*` layer) ------------------------------------

function arithPullBits(ab: usize, n: i32): i32 {
  let bitsLeft: i32 = load<i32>(ab + AB_BITSLEFT);
  const accum: u32 = load<u32>(ab + AB_ACCUM);
  let raw: u32;
  if (bitsLeft < n) {
    const bufp: usize = load<usize>(ab + AB_BUF);
    const p: u32 = load<u32>(ab + AB_PTR);
    const refill: u32 = load<u32>(bufp + <usize>p);
    // eax = (DWORD << bitsLeft) | accum ; new_accum = DWORD >> (n - bitsLeft).
    const eax: u32 = (bitsLeft == 0) ? refill : ((refill << bitsLeft) | accum);
    store<u32>(ab + AB_ACCUM, refill >>> <u32>(n - bitsLeft));
    store<i32>(ab + AB_BITSLEFT, bitsLeft + 32 - n);
    store<u32>(ab + AB_PTR, p + 4);
    raw = eax & ((<u32>1 << n) - 1);
  } else {
    raw = accum & ((<u32>1 << n) - 1);
    store<u32>(ab + AB_ACCUM, accum >>> n);
    store<i32>(ab + AB_BITSLEFT, bitsLeft - n);
  }
  if (n == 8) return <i32>load<u8>(BR8_PTR + <usize>raw);
  if (n == 4) return <i32>load<u8>(BR4_PTR + <usize>raw);
  return <i32>raw;
}

function arithRenorm(ab: usize): void {
  let h: u32 = load<u32>(ab + AB_HIGH);
  let l: u32 = load<u32>(ab + AB_LOW);
  let t: u32 = load<u32>(ab + AB_TARGET);
  let xh: u32 = l ^ h;

  if ((xh & 0x40000000) == 0) {
    if ((xh & 0x7F800000) == 0) {
      do {
        h = ((h << 8) | 0xff) & 0x7FFFFFFF;
        l = (l << 8) & 0x7FFFFFFF;
        const b: u32 = <u32>arithPullBits(ab, 8);
        t = ((t << 8) | b) & 0x7FFFFFFF;
        xh = l ^ h;
      } while ((xh & 0x7F800000) == 0);
    }
    if ((xh & 0x78000000) == 0) {
      h = ((h << 4) | 0xf) & 0x7FFFFFFF;
      l = (l << 4) & 0x7FFFFFFF;
      const nn: u32 = <u32>arithPullBits(ab, 4);
      t = ((t << 4) | nn) & 0x7FFFFFFF;
      xh = l ^ h;
    }
    if ((xh & 0x40000000) == 0) {
      do {
        h = ((h << 1) | 1) & 0x7FFFFFFF;
        l = (l << 1) & 0x7FFFFFFF;
        const bit: u32 = <u32>arithPullBits(ab, 1);
        t = ((t << 1) | bit) & 0x7FFFFFFF;
        xh = l ^ h;
      } while ((xh & 0x40000000) == 0);
    }
  }

  // E3 (underflow) carry.
  if ((l & 0x20000000) != 0) {
    while (true) {
      if ((h & 0x20000000) != 0) break;
      l = ((l & 0x1FFFFFFF) << 1) & 0x7FFFFFFF;
      h = ((h << 1) | 0x40000001) & 0x7FFFFFFF;
      t = t ^ 0x20000000;
      const bit: u32 = <u32>arithPullBits(ab, 1);
      t = ((t << 1) | bit) & 0x7FFFFFFF;
      if ((l & 0x20000000) == 0) break;
    }
  }

  store<u32>(ab + AB_HIGH, h);
  store<u32>(ab + AB_LOW, l);
  store<u32>(ab + AB_TARGET, t);
}

export function arithBitsGet(ab: usize, scale: i32): i32 {
  const high: u32 = load<u32>(ab + AB_HIGH);
  const low: u32 = load<u32>(ab + AB_LOW);
  const target: u32 = load<u32>(ab + AB_TARGET);
  const range: u32 = high - low + 1;
  const tNorm: u32 = target - low + 1;
  const v: i32 = <i32>((<i64>tNorm * <i64>scale - 1) / <i64>range);
  return (v >= scale) ? (scale - 1) : v;
}

export function arithBitsRemove(ab: usize, lo: i32, count: i32, scale: i32): void {
  const high: u32 = load<u32>(ab + AB_HIGH);
  const low: u32 = load<u32>(ab + AB_LOW);
  const range: u32 = high - low + 1;
  const num1: u32 = <u32>((<i64>range * <i64>(lo + count)) / <i64>scale);
  const num2: u32 = <u32>((<i64>range * <i64>lo) / <i64>scale);
  store<u32>(ab + AB_HIGH, low + num1 - 1);
  store<u32>(ab + AB_LOW, low + num2);
  arithRenorm(ab);
}

export function arithBitsGetValue(ab: usize, scale: i32): i32 {
  const high: u32 = load<u32>(ab + AB_HIGH);
  const low: u32 = load<u32>(ab + AB_LOW);
  const target: u32 = load<u32>(ab + AB_TARGET);
  const range: u32 = high - low + 1;
  const tNorm: u32 = target - low + 1;
  let v: i32 = <i32>((<i64>tNorm * <i64>scale - 1) / <i64>range);
  if (v >= scale) v = scale - 1;
  arithBitsRemove(ab, v, 1, scale);
  return v;
}

export function arithBitOpen(ab: usize, bufPtr: usize, offset: i32): void {
  const dword: u32 = load<u32>(bufPtr + <usize>offset);
  const topBit: u32 = (dword >>> 31) & 1;
  const lo31: u32 = dword & 0x7FFFFFFF;

  let t: u32 = <u32>load<u8>(BR4_PTR + <usize>((lo31 >>> 4) & 0xF));
  t |= <u32>load<u8>(BR4_PTR + <usize>(lo31 & 0xF)) << 4;
  t = (t << 4) | <u32>load<u8>(BR4_PTR + <usize>((lo31 >>> 8) & 0xF));
  t = (t << 4) | <u32>load<u8>(BR4_PTR + <usize>((lo31 >>> 12) & 0xF));
  t = (t << 4) | <u32>load<u8>(BR4_PTR + <usize>((lo31 >>> 16) & 0xF));
  t = (t << 4) | <u32>load<u8>(BR4_PTR + <usize>((lo31 >>> 20) & 0xF));
  t = (t << 4) | <u32>load<u8>(BR4_PTR + <usize>((lo31 >>> 24) & 0xF));
  t = (t << 3) | <u32>load<u8>(BR3_PTR + <usize>((lo31 >>> 28) & 7));

  store<usize>(ab + AB_BUF, bufPtr);
  store<u32>(ab + AB_PTR, <u32>(offset + 4));
  store<u32>(ab + AB_ACCUM, topBit);
  store<i32>(ab + AB_BITSLEFT, 1);
  store<u32>(ab + AB_HIGH, 0x7FFFFFFF);
  store<u32>(ab + AB_LOW, 0);
  store<u32>(ab + AB_TARGET, t);
}

// --- Adaptive model (the `arith*` layer) ------------------------------------

function arithInitBands(a: usize, uniqueValuesPlus1: i32): void {
  if (uniqueValuesPlus1 < 6) {
    store<u16>(a + A_BS, 0);
    store<u16>(a + A_SD, 15);
    store<u16>(a + A_BB, 0);
    return;
  }
  let bestShift: i32 = 0;
  let bestLeftover: u32 = 0xffffffff;
  for (let cl: i32 = 0; cl < 16; cl++) {
    const bucketSize: i32 = 1 << cl;
    let nbBuckets: u32 = <u32>((bucketSize + uniqueValuesPlus1 - 1) / bucketSize);
    if (nbBuckets > 16) nbBuckets = 16;
    let leftover: u32 = <u32>(uniqueValuesPlus1 - (<i32>(nbBuckets - 1)) * bucketSize);
    if (leftover < <u32>bucketSize) leftover = <u32>bucketSize;
    if (leftover < bestLeftover) {
      bestShift = cl;
      bestLeftover = leftover;
    }
    if (bucketSize > uniqueValuesPlus1) break;
  }
  const bs: i32 = 1 << bestShift;
  store<u16>(a + A_BS, <u16>bs);
  store<u16>(a + A_SD, <u16>bestShift);
  store<u16>(a + A_BB, <u16>(15 * bs));
}

function arithUpdate(a: usize, idx: i32, magic: u32): void {
  const lo: u32 = magic & 0xffff;
  const cum: usize = a + A_CUM;
  const bandBoundary: i32 = <i32>load<u16>(a + A_BB);

  if (idx >= bandBoundary) {
    store<u16>(cum + 30, <u16>(<u32>load<u16>(cum + 30) + lo)); // cumCounts[15]
    const scp: usize = a + A_SC + (<usize>idx) * 2;
    store<u16>(scp, <u16>(<u32>load<u16>(scp) + lo));
    return;
  }

  const shiftDepth: i32 = <i32>load<u16>(a + A_SD);
  let d: i32 = idx >>> shiftDepth;
  if (d & 1) {
    const cdp: usize = cum + (<usize>d) * 2;
    store<u16>(cdp, <u16>(<u32>load<u16>(cdp) + lo));
    d++;
  }
  d >>>= 1;
  if (d <= 7) {
    // DWORD pair-add : cumCounts[2k]/[2k+1] are contiguous LE u16, so a single
    // u32 load/add/store carries the low-half overflow into the high half.
    for (let k: i32 = d; k <= 7; k++) {
      const off: usize = cum + (<usize>k) * 4;
      store<u32>(off, load<u32>(off) + magic);
    }
  }
  const scp2: usize = a + A_SC + (<usize>idx) * 2;
  store<u16>(scp2, <u16>(<u32>load<u16>(scp2) + lo));
}

function arithSearch(a: usize, offset: i32): i32 {
  const cum: usize = a + A_CUM;
  let bucket: i32 = 0;
  let lo: i32 = 0;

  const c7: i32 = <i32>load<u16>(cum + 14); // cumCounts[7]
  if (offset >= c7) { lo = c7; bucket = 8; }
  const p1: i32 = <i32>load<u16>(cum + (<usize>(bucket + 3)) * 2);
  if (offset >= p1) { lo = p1; bucket += 4; }
  const p2: i32 = <i32>load<u16>(cum + (<usize>(bucket + 1)) * 2);
  if (offset >= p2) { lo = p2; bucket += 2; }
  const p3: i32 = <i32>load<u16>(cum + (<usize>bucket) * 2);
  if (offset >= p3) { lo = p3; bucket += 1; }

  // cumCounts[bucket..15] += 1.
  for (let i: i32 = bucket; i < 16; i++) {
    const cp: usize = cum + (<usize>i) * 2;
    store<u16>(cp, <u16>(<u32>load<u16>(cp) + 1));
  }

  const bucketSize: i32 = <i32>load<u16>(a + A_BS);
  const uniqueCount: i32 = <i32>load<u16>(a + A_UC);
  const countsSize: i32 = (uniqueCount + 5) & ~3;
  let end: i32 = uniqueCount + 1;
  if (countsSize < end) end = countsSize;

  const sc: usize = a + A_SC;
  let idx: i32 = bucket * bucketSize;
  let cumLo: i32 = lo;
  while (idx < end) {
    const high: i32 = (cumLo + <i32>load<u16>(sc + (<usize>idx) * 2)) & 0xffff;
    if (offset < high) {
      g_slotLo = cumLo;
      return idx;
    }
    cumLo = high;
    idx++;
  }

  let fb: i32 = idx - 1;
  if (fb < 0) fb = 0;
  if (fb > uniqueCount) fb = uniqueCount;
  g_slotLo = cumLo;
  return fb;
}

function arithReEmitCumFromScratch(a: usize, scratch: usize): void {
  const bandBoundary: i32 = <i32>load<u16>(a + A_BB);
  const uniqueCount: i32 = <i32>load<u16>(a + A_UC);
  const singlesLength: i32 = <i32>load<u16>(a + A_SL);
  const sc: usize = a + A_SC;

  if (singlesLength != uniqueCount && load<u16>(sc) == 0) {
    store<u16>(sc, 2); // singleCounts[0] = 2
    const bucket0: i32 = (0 >= bandBoundary) ? 15 : 0;
    const sp: usize = scratch + (<usize>bucket0) * 4;
    store<u32>(sp, load<u32>(sp) + 2);
  }

  const cum: usize = a + A_CUM;
  let cumv: u32 = 0;
  for (let k: i32 = 0; k < 16; k++) {
    cumv = (cumv + load<u32>(scratch + (<usize>k) * 4)) & 0xffff;
    store<u16>(cum + (<usize>k) * 2, <u16>cumv);
  }
}

function arithRescale(a: usize): void {
  const singlesLen0: i32 = <i32>load<u16>(a + A_SL);
  arithInitBands(a, singlesLen0 + 1);

  const scratch: usize = SCRATCH_PTR;
  for (let k: i32 = 0; k < 16; k++) store<u32>(scratch + (<usize>k) * 4, 0);

  const sc: usize = a + A_SC;
  const vals: usize = aValuesBase(a);
  const bandBoundary: i32 = <i32>load<u16>(a + A_BB);
  const shiftDepth: i32 = <i32>load<u16>(a + A_SD);

  const sc0v: i32 = (<i32>load<u16>(sc)) >>> 1;
  store<u16>(sc, <u16>sc0v);
  const bucket0: i32 = (0 >= bandBoundary) ? 15 : 0;
  store<u32>(scratch + (<usize>bucket0) * 4, <u32>sc0v);

  let max: i32 = 0;
  let maxPos: i32 = 0;
  let i: i32 = 1;
  let singlesLength: i32 = singlesLen0;
  while (i <= singlesLength) {
    while (<i32>load<u16>(sc + (<usize>i) * 2) <= 1) {
      if (i >= singlesLength) {
        store<u16>(sc + (<usize>i) * 2, 0);
        singlesLength = singlesLength - 1;
        break;
      }
      store<u16>(sc + (<usize>i) * 2, load<u16>(sc + (<usize>singlesLength) * 2));
      store<u16>(sc + (<usize>singlesLength) * 2, 0);
      store<u16>(vals + (<usize>i) * 2, load<u16>(vals + (<usize>singlesLength) * 2));
      singlesLength = singlesLength - 1;
    }
    if (i > singlesLength) break;
    const halved: i32 = (<i32>load<u16>(sc + (<usize>i) * 2)) >>> 1;
    store<u16>(sc + (<usize>i) * 2, <u16>halved);
    if (halved > max) { max = halved; maxPos = i; }
    const bucket: i32 = (i >= bandBoundary) ? 15 : (i >>> shiftDepth);
    const bp: usize = scratch + (<usize>bucket) * 4;
    store<u32>(bp, load<u32>(bp) + <u32>halved);
    i++;
  }
  store<u16>(a + A_SL, <u16>singlesLength);

  if (max > 0) {
    let target: i32;
    if (singlesLength >= bandBoundary) target = bandBoundary;
    else target = (singlesLength >>> shiftDepth) << shiftDepth;
    if (target == 0) target = 1;

    if (maxPos != target) {
      const oldScTarget: i32 = <i32>load<u16>(sc + (<usize>target) * 2);
      const scMaxPos: i32 = <i32>load<u16>(sc + (<usize>maxPos) * 2);
      const delta: i32 = scMaxPos - oldScTarget; // signed

      const bucketTarget: i32 = (target >= bandBoundary) ? 15 : (target >>> shiftDepth);
      const bucketMaxPos: i32 = (maxPos >= bandBoundary) ? 15 : (maxPos >>> shiftDepth);
      const btp: usize = scratch + (<usize>bucketTarget) * 4;
      const bmp: usize = scratch + (<usize>bucketMaxPos) * 4;
      store<u32>(btp, load<u32>(btp) + <u32>delta);
      store<u32>(bmp, load<u32>(bmp) - <u32>delta);

      store<u16>(sc + (<usize>target) * 2, <u16>scMaxPos);
      store<u16>(sc + (<usize>maxPos) * 2, <u16>oldScTarget);
      const vt: u16 = load<u16>(vals + (<usize>target) * 2);
      store<u16>(vals + (<usize>target) * 2, load<u16>(vals + (<usize>maxPos) * 2));
      store<u16>(vals + (<usize>maxPos) * 2, vt);
    }
  }

  arithReEmitCumFromScratch(a, scratch);
}

/**
 * Init an adaptive-model block in place. `a` is a JS-chosen pointer with room
 * for the block ; returns the block byte-size so JS can advance its cursor.
 */
export function arithOpen(a: usize, uniqueValues: i32): i32 {
  const countsSize: i32 = (uniqueValues + 5) & ~3;
  const blockSize: i32 = <i32>A_SC + countsSize * 4; // header + singleCounts + values
  for (let o: usize = 0; o < <usize>blockSize; o += 4) store<u32>(a + o, 0);
  store<u16>(a + A_UC, <u16>uniqueValues);
  store<u16>(a + A_SL, 0);
  arithInitBands(a, uniqueValues + 1);
  arithUpdate(a, 0, 0x30003);
  return blockSize;
}

export function arithSetDecompressed(a: usize, slot: i32, value: i32): void {
  store<u16>(aValuesBase(a) + (<usize>slot) * 2, <u16>value);
}

export function arithDecompress(a: usize, ab: usize): i32 {
  const cum: usize = a + A_CUM;
  if (<i32>load<u16>(cum + 30) >= 0x4000) { // cumCounts[15] >= ARITH_RESCALE_TRIGGER
    arithRescale(a);
  }

  const total: i32 = <i32>load<u16>(cum + 30);
  const offset: i32 = arithBitsGet(ab, total);
  const refinedIdx: i32 = arithSearch(a, offset);
  const slotLo: i32 = g_slotLo;
  const scp: usize = a + A_SC + (<usize>refinedIdx) * 2;
  const slotCount: i32 = <i32>load<u16>(scp);

  arithBitsRemove(ab, slotLo, slotCount, total);
  store<u16>(scp, <u16>(<u32>load<u16>(scp) + 1));

  if (refinedIdx != 0) {
    return <i32>load<u16>(aValuesBase(a) + (<usize>refinedIdx) * 2);
  }

  // Escape : new symbol.
  const newSL: i32 = (<i32>load<u16>(a + A_SL) + 1) & 0xffff;
  store<u16>(a + A_SL, <u16>newSL);
  arithUpdate(a, newSL, 0x20002);

  if (newSL == <i32>load<u16>(a + A_UC)) {
    const sc0: i32 = <i32>load<u16>(a + A_SC);
    const negSc0: u32 = <u32>(-sc0) & 0xffff;
    const magicHi: u32 = (<u32>(-sc0 - 1) & 0xffff) << 16;
    arithUpdate(a, 0, magicHi | negSc0);
  }

  return -(newSL + 1);
}

// ============================================================================
// planeDecode — adaptive-arithmetic + 4-level sub-band traversal. Byte-exact
// port of src/igc-plane.js (the JS oracle). Drives the arith kernel above
// entirely in-wasm : one JS→WASM crossing per plane, zero per-symbol round
// trips. State (coder `ab`, varbits `vb`, N adaptive models) is bump-allocated
// per call from a JS-provided `workPtr`, growing linear memory as needed.
//
// Escape resolution is in-wasm : `arithDecompress` returns `-(slot+1)` on
// escape → the ported code reads `escaped` from the right stream
// (`arithBitsGetValue` for decodeLow / pixel-context ; `varBitsGet` for
// decodeHigh1 lit/zero lengths) and calls `arithSetDecompressed`.
// ============================================================================

// Per-plane bump-allocator cursor (set to workPtr at each planeDecode entry).
let g_pdCursor: usize = 0;

// Allocate `nbytes` from the work region (4-aligned), growing memory to fit.
function pdAlloc(nbytes: i32): usize {
  const p: usize = (g_pdCursor + 3) & ~(<usize>3);
  g_pdCursor = p + <usize>nbytes;
  const have: usize = <usize>memory.size() << 16;
  if (g_pdCursor > have) {
    memory.grow(<i32>(((g_pdCursor - have) + 0xffff) >> 16));
  }
  return p;
}

// --- VarBits — 32-bit LE bit reader (NOT bit-reversed ; separate from `ab`) --
// Block (16 B) : { bufPtr(usize @0), cur(u32 @4), bits(u32 @8), bitlen(i32 @12) }.
// @inline
const VB_BUF: usize = 0;
// @inline
const VB_CUR: usize = 4;
// @inline
const VB_BITS: usize = 8;
// @inline
const VB_BITLEN: usize = 12;

function pdVarBitsOpen(bufPtr: usize, offset: i32): usize {
  const vb: usize = pdAlloc(16);
  store<usize>(vb + VB_BUF, bufPtr);
  store<u32>(vb + VB_CUR, <u32>offset);
  store<u32>(vb + VB_BITS, 0);
  store<i32>(vb + VB_BITLEN, 0);
  return vb;
}

// varbits.h — VarBitsGet1LE. Reads one bit. `load<u32>` is the LE U32 read
// (wasm is LE ; the 32-byte zero-pad after the copied bitstream supplies the
// read-past-end zeros the JS oracle gets from `buf[oob] → undefined → 0`).
function varBitsGet1(vb: usize): i32 {
  const bitlen: i32 = load<i32>(vb + VB_BITLEN);
  if (bitlen == 0) {
    const bufp: usize = load<usize>(vb + VB_BUF);
    const cur: u32 = load<u32>(vb + VB_CUR);
    const i: u32 = load<u32>(bufp + <usize>cur);
    store<u32>(vb + VB_CUR, cur + 4);
    store<u32>(vb + VB_BITS, i >>> 1);
    store<i32>(vb + VB_BITLEN, 31);
    return <i32>(i & 1);
  }
  const bits: u32 = load<u32>(vb + VB_BITS);
  store<u32>(vb + VB_BITS, bits >>> 1);
  store<i32>(vb + VB_BITLEN, bitlen - 1);
  return <i32>(bits & 1);
}

// varbits.h — VarBitsGetLE. Reads `len` bits, returns unsigned (JS `>>> 0`).
function varBitsGet(vb: usize, len: i32): u32 {
  const mask: u32 = (len == 32) ? 0xffffffff : ((<u32>1 << len) - 1);
  const bitlen: i32 = load<i32>(vb + VB_BITLEN);
  const bits: u32 = load<u32>(vb + VB_BITS);
  if (bitlen < len) {
    const bufp: usize = load<usize>(vb + VB_BUF);
    const cur: u32 = load<u32>(vb + VB_CUR);
    const nb: u32 = load<u32>(bufp + <usize>cur);
    store<u32>(vb + VB_CUR, cur + 4);
    const merged: u32 = (bits | (nb << bitlen)) & mask;
    store<u32>(vb + VB_BITS, nb >>> <u32>(len - bitlen));
    store<i32>(vb + VB_BITLEN, bitlen + 32 - len);
    return merged;
  }
  const result: u32 = bits & mask;
  store<u32>(vb + VB_BITS, bits >>> len);
  store<i32>(vb + VB_BITLEN, bitlen - len);
  return result;
}

// --- Helpers -----------------------------------------------------------------

// Sign-extend a 16-bit value to signed (called only on 0..65535 inputs).
// @inline
function s16(v: i32): i32 { return (v << 16) >> 16; }

// @inline
function radabs(v: i32): i32 { return v < 0 ? -v : v; }

// varbits.h — getbitlevel. Caps at 15 for value >= 16384 ; operates on U32.
function getBitLevel(value: u32): i32 {
  let n: u32 = value;
  if (n == 0) return 0;
  if (n >= 16384) return 15;
  let r: i32 = 0;
  while (n > 0) { r++; n >>>= 1; }
  return r;
}

// encode.c:1416 — fill_rect. `outOffset` in S16 elements ; `val` stored as i16.
function fillRect(outPtr: usize, outOffset: i32, pitch: i32, width: i32, height: i32, val: i32): void {
  const yadj: i32 = pitch - width;
  let o: i32 = outOffset;
  for (let h: i32 = 0; h < height; h++) {
    for (let w: i32 = 0; w < width; w++) {
      store<i16>(outPtr + (<usize>o << 1), <i16>val);
      o++;
    }
    o += yadj;
  }
}

// Length-decode tables (encode.c) — static data, no runtime allocation.
const EXTRA_LIT_PTR: usize = memory.data<i32>([128, 256, 512, 1024]);
const EXTRA_ZERO_PTR: usize = memory.data<i32>([512, 1024, 2048, 3072]);

// @inline
const MIN_ZERO_LENGTH: i32 = 3;
// @inline
const LIT_LENGTH_BITS: i32 = 6;
// @inline
const ZERO_LENGTH_BITS: i32 = 8;
// @inline
const LIT_LENGTH_LIMIT: i32 = 63;   // (1 << 6) - 1
// @inline
const ZERO_LENGTH_LIMIT: i32 = 255; // (1 << 8) - 1
// @inline
const EXTRA_LENGTHS: i32 = 4;

// --- Bump-allocating openers -------------------------------------------------

function pdArithBitOpen(bufPtr: usize, offset: i32): usize {
  const ab: usize = pdAlloc(28);
  arithBitOpen(ab, bufPtr, offset);
  return ab;
}

// arithOpen with in-wasm allocation (uniqueValues = JS `num`).
function pdArithOpen(uniqueValues: i32): usize {
  const countsSize: i32 = (uniqueValues + 5) & ~3;
  const blockSize: i32 = <i32>A_SC + countsSize * 4;
  const a: usize = pdAlloc(blockSize);
  arithOpen(a, uniqueValues);
  return a;
}

// --- Plane sub-decoders ------------------------------------------------------

// encode.c:1440 — decode_low. Low-pass plane, pixel-to-left/above prediction.
function decodeLow(ab: usize, vb: usize, outPtr: usize, outOffset: i32, pixelPitch: i32, encWidth: i32, encHeight: i32): void {
  if (varBitsGet1(vb)) {
    const v: i32 = <i32>varBitsGet(vb, 16);
    fillRect(outPtr, outOffset, pixelPitch, encWidth, encHeight, s16(v));
    return;
  }

  const max: i32 = <i32>varBitsGet(vb, 16);
  const num: i32 = max + 1;
  const a: usize = pdArithOpen(num);
  const yadj: i32 = pixelPitch - encWidth;

  let prev: i32 = <i32>varBitsGet(vb, 16);
  store<i16>(outPtr + (<usize>outOffset << 1), <i16>s16(prev));
  outOffset++;
  prev = s16(prev);

  for (let w: i32 = 0; w < encWidth - 1; w++) {
    let cur: i32 = arithDecompress(a, ab);
    if (cur < 0) {
      const escaped: i32 = arithBitsGetValue(ab, num);
      arithSetDecompressed(a, -cur - 1, escaped);
      cur = escaped;
    }
    if (cur) {
      const v: i32 = -varBitsGet1(vb);
      cur = (cur ^ v) - v;
    }
    prev = cur + prev;
    store<i16>(outPtr + (<usize>outOffset << 1), <i16>prev);
    outOffset++;
  }

  for (let h: i32 = 0; h < encHeight - 1; h++) {
    outOffset += yadj;
    let from: i32 = outOffset - pixelPitch;

    let cur: i32 = arithDecompress(a, ab);
    if (cur < 0) {
      const escaped: i32 = arithBitsGetValue(ab, num);
      arithSetDecompressed(a, -cur - 1, escaped);
      cur = escaped;
    }
    if (cur) {
      const v: i32 = -varBitsGet1(vb);
      cur = (cur ^ v) - v;
    }
    prev = cur + <i32>load<i16>(outPtr + (<usize>from << 1));
    store<i16>(outPtr + (<usize>outOffset << 1), <i16>prev);
    outOffset++;
    from++;

    for (let w: i32 = 0; w < encWidth - 1; w++) {
      cur = arithDecompress(a, ab);
      if (cur < 0) {
        const escaped: i32 = arithBitsGetValue(ab, num);
        arithSetDecompressed(a, -cur - 1, escaped);
        cur = escaped;
      }
      if (cur) {
        const v: i32 = -varBitsGet1(vb);
        cur = (cur ^ v) - v;
      }
      const avg: i32 = (prev + <i32>load<i16>(outPtr + (<usize>from << 1))) / 2;
      prev = cur + avg;
      store<i16>(outPtr + (<usize>outOffset << 1), <i16>prev);
      outOffset++;
      from++;
    }
  }
}

// encode.c:1611 — decode_high_1. High-pass plane, order-1 prediction.
// Returns 0 on success, 1 on the 64-idle-iter anti-hang (bitstream off-corpus).
function decodeHigh1(ab: usize, vb: usize, outPtr: usize, outOffset: i32, pixelPitch: i32, encWidth: i32, encHeight: i32): i32 {
  const qlevel: i32 = <i32>varBitsGet(vb, 16);

  if (varBitsGet1(vb)) {
    const v: i32 = s16(<i32>varBitsGet(vb, 16));
    fillRect(outPtr, outOffset, pixelPitch, encWidth, encHeight, v * qlevel);
    return 0;
  }

  const max: i32 = <i32>varBitsGet(vb, 16);
  const num: i32 = max + 1;
  let numl: i32 = max * qlevel;
  numl = getBitLevel(<u32>numl) + 1;

  // create_decomp_contexts : numl context models (uniform size), + lits + zeros.
  const countsSize: i32 = (num + 5) & ~3;
  const blockSize: i32 = <i32>A_SC + countsSize * 4;
  let ctxBase: usize = 0;
  for (let i: i32 = 0; i < numl; i++) {
    const p: usize = pdArithOpen(num);
    if (i == 0) ctxBase = p;
  }
  const lits: usize = pdArithOpen(LIT_LENGTH_LIMIT + 1);
  const zeros: usize = pdArithOpen(ZERO_LENGTH_LIMIT + 1);

  const yadj: i32 = pixelPitch - encWidth;
  let h: i32 = encHeight;

  let above: i32 = arithBitsGetValue(ab, num);
  if (above) {
    const v: i32 = -varBitsGet1(vb);
    above = (above ^ v) - v;
    above = above * qlevel;
  }

  store<i16>(outPtr + (<usize>outOffset << 1), <i16>above);
  let aboveLeft: i32 = above;
  let prev: i32 = above;
  let fromOffset: i32 = outOffset;
  outOffset++;

  if (encWidth == 1) {
    return decodeHigh1AfterFirst(ab, vb, outPtr, outOffset, pixelPitch, encWidth, encHeight,
      ctxBase, blockSize, lits, zeros, num, qlevel, yadj, h, above, aboveLeft, prev, fromOffset);
  }

  let w: i32 = encWidth - 1;
  let litLen: i32 = 0;
  let zeroLen: i32 = 0;
  let idleIter: i32 = 0;

  for (;;) {
    // Read lit_len
    const litLenRet: i32 = arithDecompress(lits, ab);
    if (litLenRet < 0) {
      const escaped: i32 = <i32>varBitsGet(vb, LIT_LENGTH_BITS);
      arithSetDecompressed(lits, -litLenRet - 1, escaped);
      litLen = escaped;
    } else {
      litLen = litLenRet;
    }
    if (litLen >= (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
      litLen = load<i32>(EXTRA_LIT_PTR + (<usize>(litLen - (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) << 2));
    }

    // Read zero_len
    const zeroLenRet: i32 = arithDecompress(zeros, ab);
    if (zeroLenRet < 0) {
      const escaped: i32 = <i32>varBitsGet(vb, ZERO_LENGTH_BITS);
      arithSetDecompressed(zeros, -zeroLenRet - 1, escaped);
      zeroLen = escaped;
    } else {
      zeroLen = zeroLenRet;
    }
    if (zeroLen >= (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
      zeroLen = load<i32>(EXTRA_ZERO_PTR + (<usize>(zeroLen - (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) << 2)) + MIN_ZERO_LENGTH - 1;
    } else if (zeroLen) {
      zeroLen += MIN_ZERO_LENGTH - 1;
    }

    // Anti-hang : both lengths zero = neither inner while progresses h.
    if (litLen == 0 && zeroLen == 0) {
      if (++idleIter > 64) return 1;
    } else {
      idleIter = 0;
    }

    // Decode literals
    while (litLen > 0) {
      if (w <= 1) {
        if (w) {
          const sum3: u32 = <u32>(radabs(prev * 2) + radabs(aboveLeft) + radabs(above));
          const context: i32 = getBitLevel(sum3 / 4);
          const a: usize = ctxBase + <usize>(context * blockSize);
          let cur: i32 = arithDecompress(a, ab);
          if (cur < 0) {
            const escaped: i32 = arithBitsGetValue(ab, num);
            arithSetDecompressed(a, -cur - 1, escaped);
            cur = escaped;
          }
          if (cur) {
            const v: i32 = -varBitsGet1(vb);
            cur = (cur ^ v) - v;
            cur = cur * qlevel;
          }
          store<i16>(outPtr + (<usize>outOffset << 1), <i16>cur);
          outOffset++;
          litLen--;
        }

        // after_first label
        h--;
        if (h == 0) return 0;
        w = encWidth;
        outOffset += yadj;
        fromOffset = outOffset - pixelPitch;
        above = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
        fromOffset++;
        aboveLeft = above;
        prev = above;
      } else {
        const aboveRight: i32 = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
        const sum4: u32 = <u32>(radabs(prev) + radabs(aboveLeft) + radabs(above) + radabs(aboveRight));
        const context: i32 = getBitLevel(sum4 / 4);
        const a: usize = ctxBase + <usize>(context * blockSize);
        let cur: i32 = arithDecompress(a, ab);
        if (cur < 0) {
          const escaped: i32 = arithBitsGetValue(ab, num);
          arithSetDecompressed(a, -cur - 1, escaped);
          cur = escaped;
        }
        if (cur) {
          const v: i32 = -varBitsGet1(vb);
          cur = (cur ^ v) - v;
          cur = cur * qlevel;
        }
        store<i16>(outPtr + (<usize>outOffset << 1), <i16>cur);

        aboveLeft = above;
        above = aboveRight;
        prev = cur;

        outOffset++;
        fromOffset++;
        w--;
        litLen--;
      }
    }

    // Decode zero runs
    while (zeroLen > 0) {
      if (zeroLen >= w) {
        zeroLen -= w;
        fromOffset += w;
        while (w > 0) {
          store<i16>(outPtr + (<usize>outOffset << 1), 0);
          outOffset++;
          w--;
        }
        h--;
        if (h == 0) return 0;
        w = encWidth;
        outOffset += yadj;
        fromOffset = outOffset - pixelPitch;
        above = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
        fromOffset++;
        aboveLeft = above;
        prev = above;
      } else {
        w -= zeroLen;
        fromOffset += zeroLen;
        do {
          store<i16>(outPtr + (<usize>outOffset << 1), 0);
          outOffset++;
        } while (--zeroLen > 0);
        prev = 0;
        above = <i32>load<i16>(outPtr + (<usize>(fromOffset - 1) << 1));
        aboveLeft = <i32>load<i16>(outPtr + (<usize>(fromOffset - 2) << 1));
      }
    }
  }
  return 0; // unreachable — the for(;;) only exits via return.
}

// encode.c:1611 continuation — the `after_first` entry when encWidth === 1.
// NOTE : the w<=1 context uses i32 `/4 |0` (div_s), whereas decodeHigh1's uses
// u32 `/4 >>>0` (div_u) — mirror each literally, they are NOT interchangeable.
function decodeHigh1AfterFirst(ab: usize, vb: usize, outPtr: usize, outOffset: i32, pixelPitch: i32, encWidth: i32, encHeight: i32,
  ctxBase: usize, blockSize: i32, lits: usize, zeros: usize, num: i32, qlevel: i32, yadj: i32,
  hIn: i32, aboveIn: i32, aboveLeftIn: i32, prevIn: i32, fromOffsetIn: i32): i32 {
  let h: i32 = hIn;
  let above: i32 = aboveIn;
  let aboveLeft: i32 = aboveLeftIn;
  let prev: i32 = prevIn;
  let fromOffset: i32 = fromOffsetIn;

  // after_first label
  h--;
  if (h == 0) return 0;
  let w: i32 = encWidth;
  outOffset += yadj;
  fromOffset = outOffset - pixelPitch;
  above = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
  fromOffset++;
  aboveLeft = above;
  prev = above;

  let litLen: i32 = 0;
  let zeroLen: i32 = 0;
  let idleIter: i32 = 0;

  for (;;) {
    const litLenRet: i32 = arithDecompress(lits, ab);
    if (litLenRet < 0) {
      const escaped: i32 = <i32>varBitsGet(vb, LIT_LENGTH_BITS);
      arithSetDecompressed(lits, -litLenRet - 1, escaped);
      litLen = escaped;
    } else {
      litLen = litLenRet;
    }
    if (litLen >= (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
      litLen = load<i32>(EXTRA_LIT_PTR + (<usize>(litLen - (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) << 2));
    }

    const zeroLenRet: i32 = arithDecompress(zeros, ab);
    if (zeroLenRet < 0) {
      const escaped: i32 = <i32>varBitsGet(vb, ZERO_LENGTH_BITS);
      arithSetDecompressed(zeros, -zeroLenRet - 1, escaped);
      zeroLen = escaped;
    } else {
      zeroLen = zeroLenRet;
    }
    if (zeroLen >= (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
      zeroLen = load<i32>(EXTRA_ZERO_PTR + (<usize>(zeroLen - (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) << 2)) + MIN_ZERO_LENGTH - 1;
    } else if (zeroLen) {
      zeroLen += MIN_ZERO_LENGTH - 1;
    }

    if (litLen == 0 && zeroLen == 0) {
      if (++idleIter > 64) return 1;
    } else {
      idleIter = 0;
    }

    while (litLen > 0) {
      if (w <= 1) {
        if (w) {
          const sum3: i32 = radabs(prev * 2) + radabs(aboveLeft) + radabs(above);
          const context: i32 = getBitLevel(<u32>(sum3 / 4));
          const a: usize = ctxBase + <usize>(context * blockSize);
          let cur: i32 = arithDecompress(a, ab);
          if (cur < 0) {
            const escaped: i32 = arithBitsGetValue(ab, num);
            arithSetDecompressed(a, -cur - 1, escaped);
            cur = escaped;
          }
          if (cur) {
            const v: i32 = -varBitsGet1(vb);
            cur = (cur ^ v) - v;
            cur = cur * qlevel;
          }
          store<i16>(outPtr + (<usize>outOffset << 1), <i16>cur);
          outOffset++;
          litLen--;
        }
        h--;
        if (h == 0) return 0;
        w = encWidth;
        outOffset += yadj;
        fromOffset = outOffset - pixelPitch;
        above = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
        fromOffset++;
        aboveLeft = above;
        prev = above;
      } else {
        const aboveRight: i32 = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
        const sum4: u32 = <u32>(radabs(prev) + radabs(aboveLeft) + radabs(above) + radabs(aboveRight));
        const context: i32 = getBitLevel(sum4 / 4);
        const a: usize = ctxBase + <usize>(context * blockSize);
        let cur: i32 = arithDecompress(a, ab);
        if (cur < 0) {
          const escaped: i32 = arithBitsGetValue(ab, num);
          arithSetDecompressed(a, -cur - 1, escaped);
          cur = escaped;
        }
        if (cur) {
          const v: i32 = -varBitsGet1(vb);
          cur = (cur ^ v) - v;
          cur = cur * qlevel;
        }
        store<i16>(outPtr + (<usize>outOffset << 1), <i16>cur);
        aboveLeft = above;
        above = aboveRight;
        prev = cur;
        outOffset++;
        fromOffset++;
        w--;
        litLen--;
      }
    }

    while (zeroLen > 0) {
      if (zeroLen >= w) {
        zeroLen -= w;
        fromOffset += w;
        while (w > 0) {
          store<i16>(outPtr + (<usize>outOffset << 1), 0);
          outOffset++;
          w--;
        }
        h--;
        if (h == 0) return 0;
        w = encWidth;
        outOffset += yadj;
        fromOffset = outOffset - pixelPitch;
        above = <i32>load<i16>(outPtr + (<usize>fromOffset << 1));
        fromOffset++;
        aboveLeft = above;
        prev = above;
      } else {
        w -= zeroLen;
        fromOffset += zeroLen;
        do {
          store<i16>(outPtr + (<usize>outOffset << 1), 0);
          outOffset++;
        } while (--zeroLen > 0);
        prev = 0;
        above = <i32>load<i16>(outPtr + (<usize>(fromOffset - 1) << 1));
        aboveLeft = <i32>load<i16>(outPtr + (<usize>(fromOffset - 2) << 1));
      }
    }
  }
  return 0; // unreachable — the for(;;) only exits via return.
}

// encode.c:532 — read_escapes. Zero-row RLE mask (plane 0) into `maskPtr` (u8/row).
function readEscapes(ab: usize, maskPtr: usize, count: i32): void {
  const zeros: i32 = arithBitsGetValue(ab, count + 1);
  for (let i: i32 = 0; i < count; i++) {
    if (arithBitsGet(ab, count) >= zeros) {
      store<u8>(maskPtr + <usize>i, 1);
      arithBitsRemove(ab, zeros, count - zeros, count);
    } else {
      store<u8>(maskPtr + <usize>i, 0);
      arithBitsRemove(ab, 0, zeros, count);
    }
  }
}

/**
 * Decode one IGC plane bitstream into an S16 plane — the single WASM entry the
 * JS `planeDecode` seam dispatches to (one crossing per plane).
 *
 * @param bufPtr - the copied IGC bitstream (this plane's data + everything after
 *   it in `src`, + 32-byte zero-pad for the coders' read-past-end).
 * @param srcOffset - byte offset of this plane within `bufPtr` (0 from the driver).
 * @param outPtr - destination S16 plane (`width * height` i16).
 * @param width, height - plane dimensions in pixels.
 * @param rowMaskPtr - zero-row mask output (`height` bytes), or 0 for no mask.
 * @param workPtr - base of the per-plane bump-allocation region (coder + models).
 * @returns bytes consumed from the bitstream, or a negative sentinel on the
 *   decodeHigh1 anti-hang (bitstream off-corpus).
 */
export function planeDecode(bufPtr: usize, srcOffset: i32, outPtr: usize, width: i32, height: i32, rowMaskPtr: usize, workPtr: usize): i32 {
  g_pdCursor = workPtr;

  const arithLen: u32 = load<u32>(bufPtr + <usize>srcOffset);
  const varbitsStart: i32 = srcOffset + 8 + <i32>arithLen;

  const ab: usize = pdArithBitOpen(bufPtr, srcOffset + 8);
  const vb: usize = pdVarBitsOpen(bufPtr, varbitsStart);

  // Level 3 (W/16 x H/16)
  decodeLow(ab, vb, outPtr, 0, width * 16, width >> 4, height >> 4);
  if (decodeHigh1(ab, vb, outPtr, width >> 4, width * 16, width >> 4, height >> 4)) return -1;
  if (decodeHigh1(ab, vb, outPtr, width * 8, width * 16, width >> 4, height >> 4)) return -1;
  if (decodeHigh1(ab, vb, outPtr, (width >> 4) + (width * 8), width * 16, width >> 4, height >> 4)) return -1;

  // Level 2 (W/8 x H/8)
  if (decodeHigh1(ab, vb, outPtr, width >> 3, width * 8, width >> 3, height >> 3)) return -1;
  if (decodeHigh1(ab, vb, outPtr, width * 4, width * 8, width >> 3, height >> 3)) return -1;
  if (decodeHigh1(ab, vb, outPtr, (width >> 3) + (width * 4), width * 8, width >> 3, height >> 3)) return -1;

  // Level 1 (W/4 x H/4)
  if (decodeHigh1(ab, vb, outPtr, width >> 2, width * 4, width >> 2, height >> 2)) return -1;
  if (decodeHigh1(ab, vb, outPtr, width * 2, width * 4, width >> 2, height >> 2)) return -1;
  if (decodeHigh1(ab, vb, outPtr, (width >> 2) + (width * 2), width * 4, width >> 2, height >> 2)) return -1;

  // Level 0 (W/2 x H/2)
  if (decodeHigh1(ab, vb, outPtr, width >> 1, width * 2, width >> 1, height >> 1)) return -1;
  if (decodeHigh1(ab, vb, outPtr, width, width * 2, width >> 1, height >> 1)) return -1;
  if (decodeHigh1(ab, vb, outPtr, (width >> 1) + width, width * 2, width >> 1, height >> 1)) return -1;

  if (rowMaskPtr != 0) {
    readEscapes(ab, rowMaskPtr, height);
  }

  const varbitsLen: u32 = load<u32>(bufPtr + <usize>(srcOffset + 4));
  return <i32>arithLen + <i32>varbitsLen + 8;
}

// ============================================================================
// iDWT — inverse wavelet transform. Byte-exact port of src/igc-idwt.js (the JS
// oracle). RAD reversible-integer lifting DWT + Haar fallbacks, run in-place on
// a whole plane (`outPtr`) using a same-length scratch plane (`tempPtr`). The
// JS `decodeIGCTexture` calls the seam `iDWT2D` 4× per plane at increasing
// resolution ; the driver (src/wasm/idwt-driver.js) copies the plane in, calls
// this, copies it back.
//
// Two structural invariants from the oracle (see its comment block) :
//   1. The iDWTcol ring pools are re-seeded before every read (no per-group
//      zeroing needed).
//   2. The iDWTcol recenter deliberately reads ONE entry past the logical pool
//      end — in JS an OOB Int32Array read yields 0. Here the col pools carry a
//      4-i32 zeroed guard (never written) so that read returns 0 and does not
//      alias the next pool. Sizes must stay EXACT.
//
// Arithmetic (mirror each `|0`) : every `(sum * coeff)` term is i32 (== JS
// `|0` ; all products stay < 2^31 for S16 inputs, so no wrap occurs), the first
// term `lp0 * 51674` is un-truncated f64, and the `e`/`o` accumulators are f64
// (sum of exact ints < 2^53). `roundS16` divides by 65536 (a power of two →
// exact in f64) and derives its bias from `ToInt32(x)`'s sign bit.
// Asm cite : `granny2.dll @ 0x10009700`, leaked-SDK `wavelet.c:1328`.
// ============================================================================

// @inline
const SMALLEST_DWT_ROW: i32 = 16;
// @inline
const SMALLEST_DWT_COL: i32 = 16;
// @inline
const FLIPSIZE: i32 = 8;

// Ring pools — static, zero-initialised, non-reentrant (single-threaded wasm).
// Row : lp[8]/hp[8], exactly sized (max index used is 6/7, no past-end read).
// Col : lp[(16+4)*4=80] + 4-i32 guard, hp[(16+5)*4=84] + 4-i32 guard (the
// recenter reads lp[80..83]/hp[84..87] → guard = 0). Rem : lp[4]/hp[5].
const ROWLP_PTR: usize = memory.data(8 * 4);
const ROWHP_PTR: usize = memory.data(8 * 4);
const COLLP_PTR: usize = memory.data((80 + 4) * 4);
const COLHP_PTR: usize = memory.data((84 + 4) * 4);
const REMLP_PTR: usize = memory.data(4 * 4);
const REMHP_PTR: usize = memory.data(5 * 4);

// S16 plane element load (sign-extends) / store (truncates low 16 bits, ==
// Int16Array store). Element index → byte offset ×2.
// @inline
function iwLd(p: usize, i: i32): i32 { return <i32>load<i16>(p + (<usize>i << 1)); }
// @inline
function iwSt(p: usize, i: i32, v: i32): void { store<i16>(p + (<usize>i << 1), <i16>v); }
// i32 ring-pool load / store. Element index → byte offset ×4.
// @inline
function iwPl(base: usize, i: i32): i32 { return load<i32>(base + (<usize>i << 2)); }
// @inline
function iwPs(base: usize, i: i32, v: i32): void { store<i32>(base + (<usize>i << 2), v); }

// (x + (32767 ^ (x >> 31))) / 65536, truncated — signed round-half-away-from
// -zero. `x >> 31` in JS = ToInt32(x) then arithmetic shift ; replicate via
// <i32>(<i64>x) (exact: |x| < 2^53). /65536 is exact in f64 (power of two).
// @inline
function roundS16(x: f64): i32 {
  const sign: i32 = (<i32>(<i64>x)) >> 31;
  return <i32>((x + <f64>(32767 ^ sign)) / 65536.0);
}

function iDWTrow(destPtr: usize, destPitch: i32, srcPtr: usize, srcPitch: i32, width: i32, height: i32, rowMaskPtr: usize, startY: i32, subHeight: i32): void {
  const halfwidth = width >> 1;

  let outBase = startY * destPitch;
  let linBase = startY * srcPitch;
  let hinBase = startY * srcPitch + halfwidth;
  let maskIdx = startY;

  for (let y = 0; y < subHeight; y++) {
    let next = 1;

    let xoutIdx = outBase;
    let xlinIdx = linBase;
    let xhinIdx = hinBase;
    const linEnd = linBase + halfwidth;

    // Initial population : 6 lp + 6 hp values, with boundary mirror.
    iwPs(ROWLP_PTR, 0 + 1, iwLd(srcPtr, xlinIdx + 0));
    { const v = iwLd(srcPtr, xlinIdx + 1); iwPs(ROWLP_PTR, -1 + 1, v); iwPs(ROWLP_PTR, 1 + 1, v); }
    iwPs(ROWLP_PTR, 2 + 1, iwLd(srcPtr, xlinIdx + 2));
    iwPs(ROWLP_PTR, 2 + 1 + 1, iwLd(srcPtr, xlinIdx + 3));
    iwPs(ROWLP_PTR, 2 + 1 + 2, iwLd(srcPtr, xlinIdx + 4));
    iwPs(ROWLP_PTR, 2 + 1 + 3, iwLd(srcPtr, xlinIdx + 5));
    xlinIdx += 6;

    iwPs(ROWHP_PTR, 0 + 2, iwLd(srcPtr, xhinIdx + 0));
    iwPs(ROWHP_PTR, 1 + 2, iwLd(srcPtr, xhinIdx + 1));
    iwPs(ROWHP_PTR, 2 + 2, iwLd(srcPtr, xhinIdx + 2));
    iwPs(ROWHP_PTR, 2 + 2 + 1, iwLd(srcPtr, xhinIdx + 3));
    iwPs(ROWHP_PTR, 2 + 2 + 2, iwLd(srcPtr, xhinIdx + 4));
    iwPs(ROWHP_PTR, 2 + 2 + 3, iwLd(srcPtr, xhinIdx + 5));
    iwPs(ROWHP_PTR, -2 + 2, iwPl(ROWHP_PTR, 1 + 2));
    iwPs(ROWHP_PTR, -1 + 2, iwPl(ROWHP_PTR, 0 + 2));
    xhinIdx += 6;

    const isNonZero = (rowMaskPtr == 0) || (load<u8>(rowMaskPtr + <usize>maskIdx) != 0);

    let x = (halfwidth < 8) ? 0 : (halfwidth - 8) / 4;

    if (isNonZero) {
      while (x-- > 0) {
        // 4 output pairs from a sliding window (lp/hp not mutated until after).
        for (let i = 0; i < 4; i++) {
          const e: f64 = <f64>iwPl(ROWLP_PTR, 0 + 1 + i) * 51674.0
            - <f64>((iwPl(ROWLP_PTR, -1 + 1 + i) + iwPl(ROWLP_PTR, 1 + 1 + i)) * 2667)
            - <f64>((iwPl(ROWHP_PTR, -2 + 2 + i) + iwPl(ROWHP_PTR, 1 + 2 + i)) * 1563)
            + <f64>((iwPl(ROWHP_PTR, -1 + 2 + i) + iwPl(ROWHP_PTR, 0 + 2 + i)) * 24733);
          const o: f64 = <f64>((iwPl(ROWLP_PTR, 0 + 1 + i) + iwPl(ROWLP_PTR, 1 + 1 + i)) * 27400)
            - <f64>((iwPl(ROWLP_PTR, -1 + 1 + i) + iwPl(ROWLP_PTR, 2 + 1 + i)) * 4230)
            - <f64>(iwPl(ROWHP_PTR, 0 + 2 + i) * 55882)
            - <f64>((iwPl(ROWHP_PTR, -2 + 2 + i) + iwPl(ROWHP_PTR, 2 + 2 + i)) * 2479)
            + <f64>((iwPl(ROWHP_PTR, -1 + 2 + i) + iwPl(ROWHP_PTR, 1 + 2 + i)) * 7250);
          iwSt(destPtr, xoutIdx + (i << 1) + 0, roundS16(e));
          iwSt(destPtr, xoutIdx + (i << 1) + 1, roundS16(o));
        }
        xoutIdx += 8;

        iwPs(ROWLP_PTR, 0, iwPl(ROWLP_PTR, 4));
        iwPs(ROWLP_PTR, 1, iwPl(ROWLP_PTR, 5));
        iwPs(ROWLP_PTR, 2, iwPl(ROWLP_PTR, 6));
        iwPs(ROWLP_PTR, 3, iwLd(srcPtr, xlinIdx + 0));
        iwPs(ROWLP_PTR, 4, iwLd(srcPtr, xlinIdx + 1));
        iwPs(ROWLP_PTR, 5, iwLd(srcPtr, xlinIdx + 2));
        iwPs(ROWLP_PTR, 6, iwLd(srcPtr, xlinIdx + 3));

        iwPs(ROWHP_PTR, 0, iwPl(ROWHP_PTR, 4));
        iwPs(ROWHP_PTR, 1, iwPl(ROWHP_PTR, 5));
        iwPs(ROWHP_PTR, 2, iwPl(ROWHP_PTR, 6));
        iwPs(ROWHP_PTR, 3, iwPl(ROWHP_PTR, 7));
        iwPs(ROWHP_PTR, 4, iwLd(srcPtr, xhinIdx + 0));
        iwPs(ROWHP_PTR, 5, iwLd(srcPtr, xhinIdx + 1));
        iwPs(ROWHP_PTR, 6, iwLd(srcPtr, xhinIdx + 2));
        iwPs(ROWHP_PTR, 7, iwLd(srcPtr, xhinIdx + 3));

        xlinIdx += 4;
        xhinIdx += 4;
      }

      let xRem = (halfwidth < 8) ? halfwidth : ((halfwidth & 3) + 8);
      while (xRem-- > 0) {
        if (xlinIdx === linEnd) {
          xlinIdx -= next;
          xhinIdx -= next + next;
          next = -next;
        }

        const e: f64 = <f64>iwPl(ROWLP_PTR, 0 + 1) * 51674.0
          - <f64>((iwPl(ROWLP_PTR, -1 + 1) + iwPl(ROWLP_PTR, 1 + 1)) * 2667)
          - <f64>((iwPl(ROWHP_PTR, -2 + 2) + iwPl(ROWHP_PTR, 1 + 2)) * 1563)
          + <f64>((iwPl(ROWHP_PTR, -1 + 2) + iwPl(ROWHP_PTR, 0 + 2)) * 24733);
        const o: f64 = <f64>((iwPl(ROWLP_PTR, 0 + 1) + iwPl(ROWLP_PTR, 1 + 1)) * 27400)
          - <f64>((iwPl(ROWLP_PTR, -1 + 1) + iwPl(ROWLP_PTR, 2 + 1)) * 4230)
          - <f64>(iwPl(ROWHP_PTR, 0 + 2) * 55882)
          - <f64>((iwPl(ROWHP_PTR, -2 + 2) + iwPl(ROWHP_PTR, 2 + 2)) * 2479)
          + <f64>((iwPl(ROWHP_PTR, -1 + 2) + iwPl(ROWHP_PTR, 1 + 2)) * 7250);

        iwSt(destPtr, xoutIdx + 0, roundS16(e));
        iwSt(destPtr, xoutIdx + 1, roundS16(o));
        xoutIdx += 2;

        iwPs(ROWLP_PTR, 0, iwPl(ROWLP_PTR, 1));
        iwPs(ROWLP_PTR, 1, iwPl(ROWLP_PTR, 2));
        iwPs(ROWLP_PTR, 2, iwPl(ROWLP_PTR, 3));
        iwPs(ROWLP_PTR, 3, iwPl(ROWLP_PTR, 4));
        iwPs(ROWLP_PTR, 4, iwPl(ROWLP_PTR, 5));
        iwPs(ROWLP_PTR, 5, iwPl(ROWLP_PTR, 6));
        iwPs(ROWLP_PTR, 6, iwLd(srcPtr, xlinIdx));

        iwPs(ROWHP_PTR, 0, iwPl(ROWHP_PTR, 1));
        iwPs(ROWHP_PTR, 1, iwPl(ROWHP_PTR, 2));
        iwPs(ROWHP_PTR, 2, iwPl(ROWHP_PTR, 3));
        iwPs(ROWHP_PTR, 3, iwPl(ROWHP_PTR, 4));
        iwPs(ROWHP_PTR, 4, iwPl(ROWHP_PTR, 5));
        iwPs(ROWHP_PTR, 5, iwPl(ROWHP_PTR, 6));
        iwPs(ROWHP_PTR, 6, iwPl(ROWHP_PTR, 7));
        iwPs(ROWHP_PTR, 7, iwLd(srcPtr, xhinIdx));

        xlinIdx += next;
        xhinIdx += next;
      }
    } else {
      while (x-- > 0) {
        for (let i = 0; i < 4; i++) {
          const e: f64 = <f64>iwPl(ROWLP_PTR, 0 + 1 + i) * 51674.0
            - <f64>((iwPl(ROWLP_PTR, -1 + 1 + i) + iwPl(ROWLP_PTR, 1 + 1 + i)) * 2667);
          const o: f64 = <f64>((iwPl(ROWLP_PTR, 0 + 1 + i) + iwPl(ROWLP_PTR, 1 + 1 + i)) * 27400)
            - <f64>((iwPl(ROWLP_PTR, -1 + 1 + i) + iwPl(ROWLP_PTR, 2 + 1 + i)) * 4230);
          iwSt(destPtr, xoutIdx + (i << 1) + 0, roundS16(e));
          iwSt(destPtr, xoutIdx + (i << 1) + 1, roundS16(o));
        }
        xoutIdx += 8;

        iwPs(ROWLP_PTR, 0, iwPl(ROWLP_PTR, 4));
        iwPs(ROWLP_PTR, 1, iwPl(ROWLP_PTR, 5));
        iwPs(ROWLP_PTR, 2, iwPl(ROWLP_PTR, 6));
        iwPs(ROWLP_PTR, 3, iwLd(srcPtr, xlinIdx + 0));
        iwPs(ROWLP_PTR, 4, iwLd(srcPtr, xlinIdx + 1));
        iwPs(ROWLP_PTR, 5, iwLd(srcPtr, xlinIdx + 2));
        iwPs(ROWLP_PTR, 6, iwLd(srcPtr, xlinIdx + 3));

        xlinIdx += 4;
      }

      let xRem = (halfwidth < 8) ? halfwidth : ((halfwidth & 3) + 8);
      while (xRem-- > 0) {
        if (xlinIdx === linEnd) {
          xlinIdx -= 1;
          next = -1;
        }

        const e: f64 = <f64>iwPl(ROWLP_PTR, 0 + 1) * 51674.0
          - <f64>((iwPl(ROWLP_PTR, -1 + 1) + iwPl(ROWLP_PTR, 1 + 1)) * 2667);
        const o: f64 = <f64>((iwPl(ROWLP_PTR, 0 + 1) + iwPl(ROWLP_PTR, 1 + 1)) * 27400)
          - <f64>((iwPl(ROWLP_PTR, -1 + 1) + iwPl(ROWLP_PTR, 2 + 1)) * 4230);

        iwSt(destPtr, xoutIdx + 0, roundS16(e));
        iwSt(destPtr, xoutIdx + 1, roundS16(o));
        xoutIdx += 2;

        iwPs(ROWLP_PTR, 0, iwPl(ROWLP_PTR, 1));
        iwPs(ROWLP_PTR, 1, iwPl(ROWLP_PTR, 2));
        iwPs(ROWLP_PTR, 2, iwPl(ROWLP_PTR, 3));
        iwPs(ROWLP_PTR, 3, iwPl(ROWLP_PTR, 4));
        iwPs(ROWLP_PTR, 4, iwPl(ROWLP_PTR, 5));
        iwPs(ROWLP_PTR, 5, iwPl(ROWLP_PTR, 6));
        iwPs(ROWLP_PTR, 6, iwLd(srcPtr, xlinIdx));

        xlinIdx += next;
      }
    }

    outBase += destPitch;
    linBase += srcPitch;
    hinBase += srcPitch;
    ++maskIdx;
  }
}

function iDWTcol(destPtr: usize, destPitch: i32, srcPtr: usize, srcPitch: i32, width: i32, height: i32, startY: i32, subHeight: i32): void {
  const halfheight = subHeight >> 1;

  let outBase = startY * destPitch;
  let linBase = 0;
  let hinBase = srcPitch;
  const lendCol0 = srcPitch * height;
  const ppitch2 = srcPitch * 2;

  if (startY) {
    linBase += ((startY / 2) - 1) * ppitch2;
    hinBase += ((startY / 2) - 2) * ppitch2;
  }

  let colsBase = 0;
  const groupCount = width / 4;

  for (let g = 0; g < groupCount; g++) {
    let next = ppitch2;
    let youtBase = outBase + colsBase;
    let ylinBase = linBase + colsBase;
    let yhinBase = hinBase + colsBase;
    const lend = lendCol0 + colsBase;

    // Initial fill — startY ? 4L+5H : 3L+3H with boundary mirror.
    if (startY) {
      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (-1 + 1) * 4 + k, iwLd(srcPtr, ylinBase + k));
      ylinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (0 + 1) * 4 + k, iwLd(srcPtr, ylinBase + k));
      ylinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (1 + 1) * 4 + k, iwLd(srcPtr, ylinBase + k));
      ylinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (2 + 1) * 4 + k, iwLd(srcPtr, ylinBase + k));
      ylinBase += next;

      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (-2 + 2) * 4 + k, iwLd(srcPtr, yhinBase + k));
      yhinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (-1 + 2) * 4 + k, iwLd(srcPtr, yhinBase + k));
      yhinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (0 + 2) * 4 + k, iwLd(srcPtr, yhinBase + k));
      yhinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (1 + 2) * 4 + k, iwLd(srcPtr, yhinBase + k));
      yhinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (2 + 2) * 4 + k, iwLd(srcPtr, yhinBase + k));
      yhinBase += next;
    } else {
      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (0 + 1) * 4 + k, iwLd(srcPtr, ylinBase + k));
      ylinBase += next;
      for (let k = 0; k < 4; k++) {
        const v = iwLd(srcPtr, ylinBase + k);
        iwPs(COLLP_PTR, (-1 + 1) * 4 + k, v);
        iwPs(COLLP_PTR, (1 + 1) * 4 + k, v);
      }
      ylinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (2 + 1) * 4 + k, iwLd(srcPtr, ylinBase + k));
      ylinBase += next;

      for (let k = 0; k < 4; k++) {
        const v = iwLd(srcPtr, yhinBase + k);
        iwPs(COLHP_PTR, (-1 + 2) * 4 + k, v);
        iwPs(COLHP_PTR, (0 + 2) * 4 + k, v);
      }
      yhinBase += next;
      for (let k = 0; k < 4; k++) {
        const v = iwLd(srcPtr, yhinBase + k);
        iwPs(COLHP_PTR, (-2 + 2) * 4 + k, v);
        iwPs(COLHP_PTR, (1 + 2) * 4 + k, v);
      }
      yhinBase += next;
      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (2 + 2) * 4 + k, iwLd(srcPtr, yhinBase + k));
      yhinBase += next;
    }

    let lpOff = 0;
    let hpOff = 0;

    for (let y = 0; y < halfheight; y++) {
      if (ylinBase === lend) {
        ylinBase -= next;
        yhinBase -= next + next;
        next = -next;
      }

      const lpC = lpOff;
      const hpC = hpOff;

      for (let k = 0; k < 4; k++) {
        const lpm1 = iwPl(COLLP_PTR, (lpC + 0) * 4 + k);
        const lp0 = iwPl(COLLP_PTR, (lpC + 1) * 4 + k);
        const lp1 = iwPl(COLLP_PTR, (lpC + 2) * 4 + k);
        const lp2 = iwPl(COLLP_PTR, (lpC + 3) * 4 + k);

        const hpm2 = iwPl(COLHP_PTR, (hpC + 0) * 4 + k);
        const hpm1 = iwPl(COLHP_PTR, (hpC + 1) * 4 + k);
        const hp0 = iwPl(COLHP_PTR, (hpC + 2) * 4 + k);
        const hp1 = iwPl(COLHP_PTR, (hpC + 3) * 4 + k);
        const hp2 = iwPl(COLHP_PTR, (hpC + 4) * 4 + k);

        const e: f64 = <f64>lp0 * 51674.0
          - <f64>((lpm1 + lp1) * 2667)
          - <f64>((hpm2 + hp1) * 1563)
          + <f64>((hpm1 + hp0) * 24733);
        const o: f64 = <f64>((lp0 + lp1) * 27400)
          - <f64>((lpm1 + lp2) * 4230)
          - <f64>(hp0 * 55882)
          - <f64>((hpm2 + hp2) * 2479)
          + <f64>((hpm1 + hp1) * 7250);

        iwSt(destPtr, youtBase + k, roundS16(e));
        iwSt(destPtr, youtBase + destPitch + k, roundS16(o));
      }

      youtBase += destPitch + destPitch;

      ++lpOff;
      ++hpOff;

      // Recenter : reads lp[(lpOff+3)*4]=lp[80..83] / hp[(hpOff+4)*4]=hp[84..87]
      // one entry past the logical pool → the zeroed guard (== JS OOB → 0).
      if (lpOff + 3 === 16 + 4) {
        for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, 0 * 4 + k, iwPl(COLLP_PTR, (lpOff + 1) * 4 + k));
        for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, 1 * 4 + k, iwPl(COLLP_PTR, (lpOff + 2) * 4 + k));
        for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, 2 * 4 + k, iwPl(COLLP_PTR, (lpOff + 3) * 4 + k));
        for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, 0 * 4 + k, iwPl(COLHP_PTR, (hpOff + 1) * 4 + k));
        for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, 1 * 4 + k, iwPl(COLHP_PTR, (hpOff + 2) * 4 + k));
        for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, 2 * 4 + k, iwPl(COLHP_PTR, (hpOff + 3) * 4 + k));
        for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, 3 * 4 + k, iwPl(COLHP_PTR, (hpOff + 4) * 4 + k));
        lpOff = 0;
        hpOff = 0;
      }

      for (let k = 0; k < 4; k++) iwPs(COLLP_PTR, (lpOff + 3) * 4 + k, iwLd(srcPtr, ylinBase + k));
      for (let k = 0; k < 4; k++) iwPs(COLHP_PTR, (hpOff + 4) * 4 + k, iwLd(srcPtr, yhinBase + k));

      ylinBase += next;
      yhinBase += next;
    }

    colsBase += 4;
  }

  const remCols = width & 3;
  for (let g = 0; g < remCols; g++) {
    let next = ppitch2;
    let youtBase = outBase + colsBase;
    let ylinBase = linBase + colsBase;
    let yhinBase = hinBase + colsBase;
    const lend = lendCol0 + colsBase;

    if (startY) {
      iwPs(REMLP_PTR, -1 + 1, iwLd(srcPtr, ylinBase)); ylinBase += next;
      iwPs(REMLP_PTR, 0 + 1, iwLd(srcPtr, ylinBase)); ylinBase += next;
      iwPs(REMLP_PTR, 1 + 1, iwLd(srcPtr, ylinBase)); ylinBase += next;
      iwPs(REMLP_PTR, 2 + 1, iwLd(srcPtr, ylinBase)); ylinBase += next;
      iwPs(REMHP_PTR, -2 + 2, iwLd(srcPtr, yhinBase)); yhinBase += next;
      iwPs(REMHP_PTR, -1 + 2, iwLd(srcPtr, yhinBase)); yhinBase += next;
      iwPs(REMHP_PTR, 0 + 2, iwLd(srcPtr, yhinBase)); yhinBase += next;
      iwPs(REMHP_PTR, 1 + 2, iwLd(srcPtr, yhinBase)); yhinBase += next;
      iwPs(REMHP_PTR, 2 + 2, iwLd(srcPtr, yhinBase)); yhinBase += next;
    } else {
      iwPs(REMLP_PTR, 0 + 1, iwLd(srcPtr, ylinBase)); ylinBase += next;
      { const v = iwLd(srcPtr, ylinBase); iwPs(REMLP_PTR, -1 + 1, v); iwPs(REMLP_PTR, 1 + 1, v); ylinBase += next; }
      iwPs(REMLP_PTR, 2 + 1, iwLd(srcPtr, ylinBase)); ylinBase += next;
      { const v = iwLd(srcPtr, yhinBase); iwPs(REMHP_PTR, -1 + 2, v); iwPs(REMHP_PTR, 0 + 2, v); yhinBase += next; }
      { const v = iwLd(srcPtr, yhinBase); iwPs(REMHP_PTR, -2 + 2, v); iwPs(REMHP_PTR, 1 + 2, v); yhinBase += next; }
      iwPs(REMHP_PTR, 2 + 2, iwLd(srcPtr, yhinBase)); yhinBase += next;
    }

    for (let y = 0; y < halfheight; y++) {
      if (ylinBase === lend) {
        ylinBase -= next;
        yhinBase -= next + next;
        next = -next;
      }

      const e: f64 = <f64>iwPl(REMLP_PTR, 0 + 1) * 51674.0
        - <f64>((iwPl(REMLP_PTR, -1 + 1) + iwPl(REMLP_PTR, 1 + 1)) * 2667)
        - <f64>((iwPl(REMHP_PTR, -2 + 2) + iwPl(REMHP_PTR, 1 + 2)) * 1563)
        + <f64>((iwPl(REMHP_PTR, -1 + 2) + iwPl(REMHP_PTR, 0 + 2)) * 24733);
      const o: f64 = <f64>((iwPl(REMLP_PTR, 0 + 1) + iwPl(REMLP_PTR, 1 + 1)) * 27400)
        - <f64>((iwPl(REMLP_PTR, -1 + 1) + iwPl(REMLP_PTR, 2 + 1)) * 4230)
        - <f64>(iwPl(REMHP_PTR, 0 + 2) * 55882)
        - <f64>((iwPl(REMHP_PTR, -2 + 2) + iwPl(REMHP_PTR, 2 + 2)) * 2479)
        + <f64>((iwPl(REMHP_PTR, -1 + 2) + iwPl(REMHP_PTR, 1 + 2)) * 7250);

      iwSt(destPtr, youtBase, roundS16(e));
      iwSt(destPtr, youtBase + destPitch, roundS16(o));

      youtBase += destPitch + destPitch;

      iwPs(REMLP_PTR, 0, iwPl(REMLP_PTR, 1));
      iwPs(REMLP_PTR, 1, iwPl(REMLP_PTR, 2));
      iwPs(REMLP_PTR, 2, iwPl(REMLP_PTR, 3));
      iwPs(REMLP_PTR, 3, iwLd(srcPtr, ylinBase));

      iwPs(REMHP_PTR, 0, iwPl(REMHP_PTR, 1));
      iwPs(REMHP_PTR, 1, iwPl(REMHP_PTR, 2));
      iwPs(REMHP_PTR, 2, iwPl(REMHP_PTR, 3));
      iwPs(REMHP_PTR, 3, iwPl(REMHP_PTR, 4));
      iwPs(REMHP_PTR, 4, iwLd(srcPtr, yhinBase));

      ylinBase += next;
      yhinBase += next;
    }

    colsBase += 1;
  }
}

function iHarrrow(destPtr: usize, destPitch: i32, srcPtr: usize, srcPitch: i32, width: i32, height: i32, rowMaskPtr: usize, startY: i32, subHeight: i32): void {
  const halfwidth = width >> 1;

  let outBase = startY * destPitch;
  let linBase = startY * srcPitch;
  let hinBase = startY * srcPitch + halfwidth;
  let maskIdx = startY;

  for (let y = 0; y < subHeight; y++) {
    let xoutIdx = outBase;
    let xlinIdx = linBase;
    let xhinIdx = hinBase;

    const isNonZero = (rowMaskPtr == 0) || (load<u8>(rowMaskPtr + <usize>maskIdx) != 0);

    if (isNonZero) {
      for (let x = 0; x < halfwidth; x++) {
        const lv = iwLd(srcPtr, xlinIdx);
        const hv = iwLd(srcPtr, xhinIdx);
        let e = lv * 2 + hv;
        let o = lv * 2 - hv;
        e = (e + (1 ^ (e >> 31))) / 2;
        o = (o + (1 ^ (o >> 31))) / 2;
        iwSt(destPtr, xoutIdx + 0, e);
        iwSt(destPtr, xoutIdx + 1, o);
        xoutIdx += 2;
        xlinIdx += 1;
        xhinIdx += 1;
      }
    } else {
      for (let x = 0; x < halfwidth; x++) {
        const e = iwLd(srcPtr, xlinIdx);
        iwSt(destPtr, xoutIdx + 0, e);
        iwSt(destPtr, xoutIdx + 1, e);
        xoutIdx += 2;
        xlinIdx += 1;
      }
    }

    outBase += destPitch;
    linBase += srcPitch;
    hinBase += srcPitch;
    ++maskIdx;
  }
}

function iHarrcol(destPtr: usize, destPitch: i32, srcPtr: usize, srcPitch: i32, width: i32, height: i32, startY: i32, subHeight: i32): void {
  const halfheight = subHeight >> 1;

  let outBase = startY * destPitch;
  let linBase = 0;
  let hinBase = srcPitch;
  const ppitch2 = srcPitch * 2;

  if (startY) {
    linBase += (startY / 2) * ppitch2;
    hinBase += (startY / 2) * ppitch2;
  }

  for (let x = 0; x < width; x++) {
    let youtBase = outBase + x;
    let ylinBase = linBase + x;
    let yhinBase = hinBase + x;

    for (let y = 0; y < halfheight; y++) {
      const lv = iwLd(srcPtr, ylinBase);
      const hv = iwLd(srcPtr, yhinBase);
      let e = lv * 2 + hv;
      let o = lv * 2 - hv;
      e = (e + (1 ^ (e >> 31))) / 2;
      o = (o + (1 ^ (o >> 31))) / 2;
      iwSt(destPtr, youtBase, e);
      iwSt(destPtr, youtBase + destPitch, o);
      youtBase += destPitch + destPitch;
      ylinBase += ppitch2;
      yhinBase += ppitch2;
    }
  }
}

/**
 * Inverse wavelet transform of one plane, in place. Byte-exact port of the JS
 * `iDWT2D` dispatcher : picks DWT vs Haar per axis by size, tiles the plane in
 * `FLIPSIZE` row/col bands, ping-pongs `outPtr` ↔ `tempPtr`.
 *
 * @param outPtr - the plane, S16, read+write (`pitch`-strided sub-band).
 * @param pitch - S16-index row stride.
 * @param width, height - sub-band dimensions.
 * @param rowMaskPtr - zero-row mask (`height` bytes), or 0 for no mask.
 * @param tempPtr - scratch plane, same length as the plane.
 */
export function iDWT2D(outPtr: usize, pitch: i32, width: i32, height: i32, rowMaskPtr: usize, tempPtr: usize): void {
  const useRowDwt = width >= SMALLEST_DWT_ROW;
  const useColDwt = height >= SMALLEST_DWT_COL;

  let ry = (height <= (FLIPSIZE + 4 + 4)) ? height : (FLIPSIZE + 4);
  let rh = height - ry;
  let cy = 0;
  let ch = height;

  if (useRowDwt) iDWTrow(tempPtr, pitch, outPtr, pitch, width, height, rowMaskPtr, 0, ry);
  else iHarrrow(tempPtr, pitch, outPtr, pitch, width, height, rowMaskPtr, 0, ry);

  do {
    let next = (ch <= (FLIPSIZE + 4)) ? ch : FLIPSIZE;
    if (useColDwt) iDWTcol(outPtr, pitch, tempPtr, pitch, width, height, cy, next);
    else iHarrcol(outPtr, pitch, tempPtr, pitch, width, height, cy, next);
    cy += next;
    ch -= next;

    if (rh) {
      next = (rh <= (FLIPSIZE + 4)) ? rh : FLIPSIZE;
      if (useRowDwt) iDWTrow(tempPtr, pitch, outPtr, pitch, width, height, rowMaskPtr, ry, next);
      else iHarrrow(tempPtr, pitch, outPtr, pitch, width, height, rowMaskPtr, ry, next);
      ry += next;
      rh -= next;
    }
  } while (ch);
}
