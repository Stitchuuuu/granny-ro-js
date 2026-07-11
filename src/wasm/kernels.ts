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
