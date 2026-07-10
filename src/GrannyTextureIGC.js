// GrannyTextureIGC.js — IGC (RAD BinkTC) texture-bitstream decoder.
//
// Clean-room port of the codec exposed as `_GrannyDecompressIGCTexture@12`
// in granny2.dll (iRO ver12), spec'd in
// `iRO_ver12.0-full-client-data/RE/granny2/IGC-FORMAT.md` and validated
// byte-exact against the parity-bake golden data in
// `tests/fixtures/baked/textures/*.rgba` (produced by S2's Wine shim).
//
// Pipeline per IGC-FORMAT.md § 7 :
//
//   1. `planeDecode(src)` — adaptive arithmetic coder + 4-level sub-band
//      traversal, produces a wavelet-transformed S16 plane (Y, U, V, A).
//      Asm cite : `granny2.dll @ 0x100045b0` (`FromBinkTC`), leaked-SDK
//      `encode.c:1884` (`plane_decode`).
//   2. `iDWT2D(plane)` — 4 passes of RAD's reversible-integer lifting-
//      scheme wavelet at increasing resolution (1/8 → 1/4 → 1/2 → full).
//      Asm cite : `granny2.dll @ 0x10009700`, leaked-SDK
//      `wavelet.c:1328` (`iDWT2D` dispatcher).
//   3. `yuvToRGB(yp, up, vp, ap)` — custom integer-reversible YUV-ish
//      colorspace inversion, writes RGBA8888 in dest. Asm cite :
//      `granny2.dll @ 0x10009a30`, leaked-SDK `granny_bink.cpp:165`.
//
// All kernels are private (file-local). Public exports : `decodeIGCTexture`,
// `yuvToRGB`, `PLANE_VALUE_OFFSET`.

const PLANE_VALUE_OFFSET = 0;

// The arithBits multiply sites use plain f64 math instead of BigInt. This is
// provably exact : `range ≤ 2^31` (31-bit coder) and `scale < 0x4000`
// (ARITH_RESCALE_TRIGGER), so every product `range·scale < 2^45 < 2^53` is
// representable exactly ; the floor is exact because the nearest-integer
// distance of the quotient (≥ 1/scale ≥ 2^-14) dwarfs the f64 rounding error
// (≤ 2^-22). Set IGC_ARITH_VERIFY=1 to cross-check every f64 result against
// the BigInt reference call-by-call (see scripts/replay-arith-selfcheck.mjs).
// The flag is a module const : when off, the guarded branches are a single
// correctly-predicted no-op per call.
const IGC_ARITH_VERIFY =
    typeof process !== 'undefined' && !!process.env && process.env.IGC_ARITH_VERIFY === '1';

let __arithCall = 0;
function __arithVerify(site, fast, ref) {
    __arithCall++;
    if (ref !== fast) {
        throw new Error(
            `[IGC_ARITH_VERIFY] ${site} divergence at call #${__arithCall}: ` +
            `f64=${fast} bigint=${ref}`);
    }
}

const SMALLEST_DWT_ROW = 16;
const SMALLEST_DWT_COL = 16;
const FLIPSIZE = 8;

// ============================================================================
// ArithBit — RAD ArithBits range coder (DLL-faithful, 31-bit precision).
//
// State : { buf, ptr, accum, bitsLeft, high, low, target }
//
// Three independent 31-bit fields — high (upper bound), low (lower bound),
// target (encoded value, always in [low, high]). This matches the DLL ab
// struct layout exactly (offsets +0x10/+0x14/+0x18). `accum` + `bitsLeft`
// buffer the next bits to be pulled from `buf` during renorm.
//
// Asm cite — init : `granny2.dll @ 0x10006650` (= fcn.10006650).
//            primitives : `fcn.1000e020` (GetValue), `fcn.1000ddc0` (Remove +
//            renorm). Confirmed S3.14 via direct disasm + manual computation
//            against kg7-tex0 trace (`abT = 0x08BF0093` for input bytes
//            `88 7E 80 64` — bit-reverse of bottom 31 bits of LE DWORD).
//
// Bytes are bit-reversed when shifted into target. The DLL uses two lookup
// tables : a 4-bit reverse at `0x1002a4b4` and a 3-bit reverse at
// `0x1002a4c4`. We materialize BR4 (16 entries) inline and a BR8 (256
// entries) precomputed for byte-mode renorm.

const BR4 = new Uint8Array([0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15]);
const BR3 = new Uint8Array([0, 4, 2, 6, 1, 5, 3, 7]);
const BR8 = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        t[i] = (BR4[i & 0xF] << 4) | BR4[(i >>> 4) & 0xF];
    }
    return t;
})();

function arithBitOpen(buf, offset) {
    // fcn.10006650 @ 0x10006683-0x10006746 — read first LE DWORD, strip top
    // bit into accumulator (bitsLeft = 1), bit-reverse bottom 31 bits into
    // target. Initial high = 0x7FFFFFFF, low = 0.
    const b0 = buf[offset] | 0, b1 = buf[offset + 1] | 0,
          b2 = buf[offset + 2] | 0, b3 = buf[offset + 3] | 0;
    const dword = ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0);
    const topBit = (dword >>> 31) & 1;
    const lo31 = dword & 0x7FFFFFFF;

    // Bit-reverse via 7 BR4 lookups + 1 BR3 lookup (asm @ 0x100066b5-0x10006746).
    // Order from LSB up : BR4[bits 0-3], BR4[bits 4-7], ..., BR4[bits 24-27],
    // BR3[bits 28-30] — each placed at the top of the accumulating result.
    let t = BR4[(lo31 >>> 4) & 0xF];
    t |= BR4[lo31 & 0xF] << 4;
    t = ((t << 4) >>> 0) | BR4[(lo31 >>> 8) & 0xF];
    t = ((t << 4) >>> 0) | BR4[(lo31 >>> 12) & 0xF];
    t = ((t << 4) >>> 0) | BR4[(lo31 >>> 16) & 0xF];
    t = ((t << 4) >>> 0) | BR4[(lo31 >>> 20) & 0xF];
    t = ((t << 4) >>> 0) | BR4[(lo31 >>> 24) & 0xF];
    t = ((t << 3) >>> 0) | BR3[(lo31 >>> 28) & 7];

    return {
        buf,
        ptr: (offset + 4) | 0,
        accum: topBit,
        bitsLeft: 1,
        high: 0x7FFFFFFF,
        low: 0,
        target: t >>> 0,
    };
}

// Pull `n` bits from input (n in {1, 4, 8}) and return them as an int,
// already bit-reversed (matching the DLL's BR4/BR8 lookup pattern).
// Refills `accum` from `buf[ptr..ptr+4]` when bitsLeft drops below n.
function arithPullBits(ab, n) {
    let bitsLeft = ab.bitsLeft | 0;
    let accum = ab.accum >>> 0;
    let raw;
    if (bitsLeft < n) {
        const buf = ab.buf;
        const p = ab.ptr | 0;
        const refill = ((buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>> 0);
        // asm fcn.1000ddc0 @ 0x1000de61-67 : eax = (DWORD << bitsLeft) | accum ;
        //                                    new_accum = DWORD >> (n - bitsLeft).
        // (n - bitsLeft) is always in [1, n] here ; no JS shift-by-32 edge case.
        const eax = (bitsLeft === 0) ? refill : (((refill << bitsLeft) | accum) >>> 0);
        ab.accum = (refill >>> (n - bitsLeft)) >>> 0;
        ab.bitsLeft = bitsLeft + 32 - n;
        ab.ptr = (p + 4) | 0;
        raw = eax & ((1 << n) - 1);
    } else {
        raw = accum & ((1 << n) - 1);
        ab.accum = (accum >>> n) >>> 0;
        ab.bitsLeft = bitsLeft - n;
    }
    return (n === 8) ? BR8[raw] : (n === 4) ? BR4[raw] : raw;
}

// Renorm — fcn.1000ddc0 @ 0x1000de15-0x1000dff5. Runs after every state
// update in arithBitsRemove. Three loops (byte / nibble / bit) shift out
// matched prefix bits, plus an E3 (underflow) carry loop. All three of
// (high, low, target) get shifted in lock-step ; target gets new bits from
// the input stream (bit-reversed via BR4/BR8).
function arithRenorm(ab) {
    let h = ab.high >>> 0;
    let l = ab.low >>> 0;
    let t = ab.target >>> 0;

    // Renorm structure mirrors fcn.1000ddc0 @ 0x1000de15-0x1000df8b. Sequential
    // mode checks — NOT an outer loop. The asm doesn't go back to byte mode
    // after nibble mode ; it tests bit 30 once at the end of nibble mode and
    // either enters bit mode or jumps to E3.
    let xh = (l ^ h) >>> 0;

    if ((xh & 0x40000000) === 0) {
        if ((xh & 0x7F800000) === 0) {
            do {
                h = (((h << 8) | 0xff) >>> 0) & 0x7FFFFFFF;
                l = ((l << 8) >>> 0) & 0x7FFFFFFF;
                const b = arithPullBits(ab, 8);
                t = (((t << 8) | b) >>> 0) & 0x7FFFFFFF;
                xh = (l ^ h) >>> 0;
            } while ((xh & 0x7F800000) === 0);
        }
        if ((xh & 0x78000000) === 0) {
            h = (((h << 4) | 0xf) >>> 0) & 0x7FFFFFFF;
            l = ((l << 4) >>> 0) & 0x7FFFFFFF;
            const n = arithPullBits(ab, 4);
            t = (((t << 4) | n) >>> 0) & 0x7FFFFFFF;
            xh = (l ^ h) >>> 0;
        }
        if ((xh & 0x40000000) === 0) {
            do {
                h = (((h << 1) | 1) >>> 0) & 0x7FFFFFFF;
                l = ((l << 1) >>> 0) & 0x7FFFFFFF;
                const bit = arithPullBits(ab, 1);
                t = (((t << 1) | bit) >>> 0) & 0x7FFFFFFF;
                xh = (l ^ h) >>> 0;
            } while ((xh & 0x40000000) === 0);
        }
    }

    // E3 (underflow) carry — fcn.1000ddc0 @ 0x1000df8d-0x1000dff5.
    //   Entry condition (L168-169) : low<29>=1   (else skip to clamp).
    //   Loop top (L170-171, 0x1000df95) : exit when high<29>=1.
    //   Body (L172+, 0x1000df9d) : clear bits 29-30 of LOW, shift LOW left, shift
    //   HIGH left then OR 0x40000001, flip bit 29 of TARGET, pull 1 bit into TARGET.
    //   Bottom check (L201-202, 0x1000dfed) : loop again iff new low<29>=1.
    if ((l & 0x20000000) !== 0) {
        while (true) {
            if ((h & 0x20000000) !== 0) break;
            l = (((l & 0x1FFFFFFF) << 1) >>> 0) & 0x7FFFFFFF;
            h = (((h << 1) | 0x40000001) >>> 0) & 0x7FFFFFFF;
            t = (t ^ 0x20000000) >>> 0;
            const bit = arithPullBits(ab, 1);
            t = (((t << 1) | bit) >>> 0) & 0x7FFFFFFF;
            if ((l & 0x20000000) === 0) break;
        }
    }

    ab.high = h;
    ab.low = l;
    ab.target = t;
}

function arithBitsGet(ab, scale) {
    // fcn.1000e6f0 @ 0x1000e730-0x1000e744 — used by arithDecompress for the
    // offset-into-cumCounts compute.
    //   offset = ((target - low + 1) * scale - 1) / (high - low + 1)
    // The asm at 0x1000e73a-3d does `sub eax, 1 ; sbb edx, 0` on the 64-bit
    // product (tNorm * scale) before dividing by range — same -1 pattern as
    // arithBitsGetValue. The previous comment claimed "without the trailing
    // -1 from GetValue" but the asm shows the -1 IS present (S3.17 fix).
    const range = (ab.high - ab.low + 1) >>> 0;
    const tNorm = (ab.target - ab.low + 1) >>> 0;
    // f64-exact : tNorm·scale < 2^45, quotient floored via `| 0` (positive,
    // < 2^31). See the note at IGC_ARITH_VERIFY.
    const v = ((tNorm * scale - 1) / range) | 0;
    if (IGC_ARITH_VERIFY) __arithVerify('Get', v, Number((BigInt(tNorm) * BigInt(scale) - 1n) / BigInt(range)) | 0);
    return (v >= scale) ? (scale - 1) : v;
}

function arithBitsRemove(ab, lo, count, scale) {
    // fcn.1000ddc0 @ 0x1000ddff-0x1000de15 — adjust (high, low) then renorm.
    //   new_low_offset  = floor(range * lo / scale)
    //   new_high_offset = floor(range * (lo+count) / scale) - 1
    //   new_low_dll  = low + new_low_offset
    //   new_high_dll = low + new_high_offset
    const range = (ab.high - ab.low + 1) >>> 0;
    // f64-exact : range·(lo+count) < 2^45 ; quotient can reach ~2^31 so we
    // floor with Math.floor (not `| 0`, which would wrap past int32).
    const num1 = Math.floor((range * (lo + count)) / scale);
    const num2 = Math.floor((range * lo) / scale);
    if (IGC_ARITH_VERIFY) {
        const sBig = BigInt(scale);
        __arithVerify('Remove.num1', num1, Number((BigInt(range) * BigInt(lo + count)) / sBig));
        __arithVerify('Remove.num2', num2, Number((BigInt(range) * BigInt(lo)) / sBig));
    }
    const oldLow = ab.low >>> 0;
    ab.high = (oldLow + num1 - 1) >>> 0;
    ab.low = (oldLow + num2) >>> 0;
    arithRenorm(ab);
}

function arithBitsGetValue(ab, scale) {
    // fcn.1000e020 — value = ((target - low + 1) * scale - 1) / (high - low + 1)
    // then arithBitsRemove(ab, value, 1, scale).
    const range = (ab.high - ab.low + 1) >>> 0;
    const tNorm = (ab.target - ab.low + 1) >>> 0;
    // f64-exact — see the note at IGC_ARITH_VERIFY.
    let v = ((tNorm * scale - 1) / range) | 0;
    if (IGC_ARITH_VERIFY) __arithVerify('GetValue', v, Number((BigInt(tNorm) * BigInt(scale) - 1n) / BigInt(range)) | 0);
    if (v >= scale) v = scale - 1;
    arithBitsRemove(ab, v, 1, scale);
    return v;
}

function arithBitsGetBits(ab, bits, scale) {
    // Same as Get with scale = 2^bits ; the actual returned offset is
    // truncated to `scale` (caller may pass scale != 2^bits).
    const range = (ab.high - ab.low + 1) >>> 0;
    const tNorm = (ab.target - ab.low + 1) >>> 0;
    const num = BigInt(tNorm) << BigInt(bits);
    const v = Number(num / BigInt(range)) | 0;
    return (v >= scale) ? (scale - 1) : v;
}

function arithBitsGetBitsValue(ab, bits, scale) {
    // Same as GetValue with scale = 2^bits.
    const range = (ab.high - ab.low + 1) >>> 0;
    const tNorm = (ab.target - ab.low + 1) >>> 0;
    const num = (BigInt(tNorm) << BigInt(bits)) - 1n;
    let v = Number(num / BigInt(range)) | 0;
    if (v >= scale) v = scale - 1;
    arithBitsRemove(ab, v, 1, scale);
    return v;
}

// Legacy compat — `arithDecRenorm` was a no-op-able SDK construct ; the DLL
// renorms inside `arithBitsRemove`. Stubbed so call sites don't crash if any
// linger from earlier ports.
function arithDecRenorm(_ab) {}

// ============================================================================
// VarBits — 32-bit LE bit reader, used for the "uncompressed" stream
// (sign bits, length escapes, raw 16-bit values).
// Leaked-SDK ref : `varbits.h` macros `VarBitsOpen`, `VarBitsGet1LE`,
// `VarBitsGetLE`.
//
// State : { buf, cur, bits, bitlen }
// - `buf` : Uint8Array source
// - `cur` : byte index into buf for next U32 read
// - `bits` : U32 cache of bits read but not yet consumed (low end has the
//            unconsumed bits)
// - `bitlen` : number of valid bits remaining in `bits`

function varBitsOpen(buf, offset) {
    return { buf, cur: offset | 0, bits: 0, bitlen: 0 };
}

function varBitsReadU32LE(buf, offset) {
    // Read a 32-bit little-endian unsigned int from buf at offset.
    return (
        (buf[offset]) |
        (buf[offset + 1] << 8) |
        (buf[offset + 2] << 16) |
        (buf[offset + 3] << 24)
    ) >>> 0;
}

function varBitsGet1(vb) {
    // varbits.h — VarBitsGet1LE. Reads one bit.
    let bitlen = vb.bitlen;
    let bits;
    if (bitlen === 0) {
        const i = varBitsReadU32LE(vb.buf, vb.cur);
        vb.cur = (vb.cur + 4) | 0;
        bits = i >>> 1;
        bitlen = 31;
        // The "i" value's bit 0 is the bit being returned.
        vb.bits = bits;
        vb.bitlen = bitlen;
        return i & 1;
    }
    bits = vb.bits;
    vb.bits = bits >>> 1;
    vb.bitlen = bitlen - 1;
    return bits & 1;
}

function varBitsGet(vb, len) {
    // varbits.h — VarBitsGetLE. Reads `len` bits.
    const mask = (len === 32) ? 0xffffffff : ((1 << len) - 1) >>> 0;
    if (vb.bitlen < len) {
        const nb = varBitsReadU32LE(vb.buf, vb.cur);
        vb.cur = (vb.cur + 4) | 0;
        // result = (vb.bits | (nb << vb.bitlen)) & mask
        const merged = ((vb.bits | (nb << vb.bitlen)) >>> 0) & mask;
        vb.bits = (nb >>> (len - vb.bitlen)) >>> 0;
        vb.bitlen = vb.bitlen + 32 - len;
        return merged >>> 0;
    }
    const result = vb.bits & mask;
    vb.bits = (vb.bits >>> len) >>> 0;
    vb.bitlen -= len;
    return result >>> 0;
}

// Sign-extend a 16-bit value to signed.
function s16(v) {
    return (v & 0x8000) ? (v | 0xffff0000) | 0 : v | 0;
}

// ============================================================================
// Arith — DLL-faithful adaptive arithmetic modeller (decode side).
//
// Port of granny2.dll Arith family — NOT the leaked SDK `radarith.c`. The
// two diverge structurally :
//
//   - SDK uses a linear `summed_counts[]` (cumulative sum normalized to
//     NORM_COUNT) + a `table_walks[]` of pre-computed binary-search steps.
//     update_counts() rebuilds summed_counts only periodically (every
//     update_tot bytes), so the model "forgets" recent symbols between
//     rebuilds. Escape handling has a "previously sent index" branch when
//     `singlesLength != summedLength`.
//
//   - DLL uses an inline 16-bucket `cumCounts[16]` cumulative-sum table
//     stored at struct +0x00..+0x1f, maintained ACTIVELY during a 4-level
//     binary search through the buckets (each level's `add dword [edx+N],
//     0x10001` bumps two adjacent cumCount entries by 1). No table_walks,
//     no update_tot, no summed/singles distinction. Escape always means
//     "new symbol" — there's no "previously sent" branch.
//
// Cumulative-sum invariant : `cumCounts[k]` = running cumulative count of
// single_counts entries up to slot `(k+1)*bucketSize - 1` (or
// uniqueValues-1 for k=15). Rescale triggers when cumCounts[15] >= 0x4000.
//
// Functions ported here :
//
//   - `arithInitBands`     (fcn.1000e130) — picks shiftDepth / bucketSize /
//     bandBoundary that minimize the leftover of a 16-bucket split of
//     `uniqueValues + 1` slots.
//   - `arithUpdate`        (fcn.1000e1c0) — leaf path (idx >= bandBoundary :
//     bump cumCounts[15] + single_counts[idx]) and cached path (cumCounts
//     pair-bumps via 8-case fallthrough switch).
//   - `arithSearch`        (fcn.1000e7f0) — 4-level binary search through
//     cumCounts[0..15] with inline `cumCounts[bucket..15] += 1` maintenance,
//     followed by a linear scan through single_counts within the bucket.
//   - `arithBitsGetOffsetDLL` / `arithBitsRemoveDLL` — bitstream offset /
//     remove primitives matching the asm formula
//     `offset = ((low + 1) * total - 1) / range` (fcn.1000e6f0 @
//     0x1000e734-0x1000e744) and the (range * lo / total) → low/range
//     update (fcn.1000ddc0). BigInt arithmetic — `low * total` overflows
//     U32 when total approaches NORM_COUNT and range stays > 0x800000.
//   - `arithRescale`       (fcn.1000ec30) — halves single_counts, drops
//     count<=1 slots via swap-with-last, halves single_counts[0] separately,
//     accumulates per-bucket scratch, then re-emits cumCounts via cumulative
//     sum. Reorder step places max at start of bucket containing
//     singlesLength.
//   - `arithReEmitCumFromScratch` (fcn.1000e690) — escape-adjust
//     (if singlesLength != uniqueCount AND single_counts[0] == 0,
//     restore escape = 2) + cumulative-sum emit.
//   - `arithOpen`          (fcn.1000e0c0) — Arith_open. The DLL's init
//     prime call `fcn.1000e1c0(ctx, 0, 0x30003)` is reproduced via
//     `arithUpdate(a, 0, 0x30003)` — net effect on init :
//       cumCounts[0..15] = 3 (all entries equal, satisfies cum-sum
//       invariant for {single_counts[0]=3, rest=0})
//       single_counts[0] = 3
//
// Plane-0 byte-exact-vs-DLL preservation : the `arithBit` range coder
// (L48-148 above) is structurally identical between SDK and DLL — we
// keep that. Only the model layer is replaced.
//
// Reference : /tmp/igc-probe/dll-arith-struct.md + /tmp/igc-probe/fcn-*.disasm.

const ARITH_RESCALE_TRIGGER = 0x4000;

// (S3.14) `arithBitsGetOffsetDLL` + `arithBitsRemoveDLL` removed. The DLL
// formulas now live in `arithBitsGet` and `arithBitsRemove` directly (using
// the 3-field {high, low, target} ab struct). arithDecompress consumes them
// the same way the DLL does.

// fcn.1000e130(ctx, uniqueValues + 1) — picks shiftDepth that minimizes
// leftover of 16-bucket split. Sets bucketSize = 1<<shiftDepth ;
// bandBoundary = 15 * bucketSize.

function arithInitBands(a, uniqueValuesPlus1) {
    if (uniqueValuesPlus1 < 6) {
        // Tiny case (asm @ 0x1000e138 jae fallback) : all updates take
        // the leaf path because bandBoundary = 0.
        a.bucketSize = 0;
        a.shiftDepth = 15;
        a.bandBoundary = 0;
        return;
    }
    let bestShift = 0;
    let bestLeftover = 0xffffffff >>> 0;
    for (let cl = 0; cl < 16; cl++) {
        const bucketSize = 1 << cl;
        // nbBuckets = ceil(uniqueValuesPlus1 / bucketSize), clamped to 16
        // (asm @ 0x1000e169-179).
        let nbBuckets = (((bucketSize + uniqueValuesPlus1 - 1) / bucketSize) | 0) >>> 0;
        if (nbBuckets > 16) nbBuckets = 16;
        // leftover = uniqueValuesPlus1 - (nbBuckets - 1) * bucketSize
        // (asm @ 0x1000e17c-183). When `leftover < bucketSize` (last bucket is
        // partial), saturate the score UP to bucketSize. The loop minimizes
        // score, so a small partial-bucket counts as "bad" (bucketSize-sized
        // penalty). Asm @ 0x1000e183 : `cmp eax,esi ; jae skip ; mov eax,esi`
        // — jae taken when leftover >= bucketSize means SKIP the mov, keeping
        // leftover ; the mov only fires when leftover < bucketSize.
        let leftover = (uniqueValuesPlus1 - (nbBuckets - 1) * bucketSize) >>> 0;
        if (leftover < bucketSize) leftover = bucketSize >>> 0;
        if (leftover < bestLeftover) {
            bestShift = cl;
            bestLeftover = leftover;
        }
        if (bucketSize > uniqueValuesPlus1) break;  // asm @ 0x1000e191
    }
    a.bucketSize = (1 << bestShift) & 0xffff;
    a.shiftDepth = bestShift & 0xff;
    a.bandBoundary = (15 * a.bucketSize) & 0xffff;
}

// fcn.1000e1c0(ctx, idx, magic) — cumCounts/single_counts updater.
//
//   Leaf path (idx >= bandBoundary, asm @ 0x1000e1d3-1e1) :
//     cumCounts[15]     += magic_lo  (cx)
//     single_counts[idx] += magic_lo  (cx)
//
//   Cached path (idx < bandBoundary, asm @ 0x1000e1e2-222) :
//     d = idx >> shiftDepth
//     if (d & 1) { cumCounts[d] += magic_lo ; d++ }   (asm @ 0x1000e1ed-1f6)
//     d >>= 1
//     if (d > 7) goto default                          (asm @ 0x1000e1f9-1fc)
//     ; switch cases d..7 FALL THROUGH (no break statements — compiler
//     ; emitted consecutive `add dword [eax+N], ecx` with NO jumps between
//     ; them, so case d's body runs case d, then case d+1's body, etc.) :
//     for k in d..7 :
//       cumCounts[2k]     += magic_lo  (low U16 of DWORD add)
//       cumCounts[2k+1]   += magic_hi  (high U16 of DWORD add)
//     ; default fallthrough (asm @ 0x1000e21c) :
//     single_counts[idx]  += magic_lo

function arithUpdate(a, idx, magic) {
    const lo = magic & 0xffff;
    const hi = (magic >>> 16) & 0xffff;
    if (idx >= a.bandBoundary) {
        a.cumCounts[15]      = (a.cumCounts[15]      + lo) & 0xffff;
        a.singleCounts[idx]  = (a.singleCounts[idx]  + lo) & 0xffff;
        return;
    }
    let d = idx >>> a.shiftDepth;
    if (d & 1) {
        a.cumCounts[d] = (a.cumCounts[d] + lo) & 0xffff;
        d++;
    }
    d >>>= 1;
    if (d <= 7) {
        // DWORD-level pair add — the asm fall-through chain is
        //   case k: add dword [ctx + 4k], magic
        // which adds magic as a 32-bit unsigned word, so a low-half overflow
        // carries +1 into the high half. Independent 16-bit adds miss that
        // carry and end up with cum[odd] one short whenever (cum[even] + lo16)
        // crosses 0x10000 — the exact pattern that escape-remove magic
        // (lo16 = -sc0, hi16 = -sc0 - 1) triggers when cum[0] >= sc0.
        const umagic = magic >>> 0;
        for (let k = d; k <= 7; k++) {
            const j = (k * 2) | 0;
            const oldDword = (a.cumCounts[j + 1] * 0x10000 + a.cumCounts[j]) >>> 0;
            const newDword = (oldDword + umagic) >>> 0;
            a.cumCounts[j]     = newDword & 0xffff;
            a.cumCounts[j + 1] = (newDword >>> 16) & 0xffff;
        }
    }
    a.singleCounts[idx] = (a.singleCounts[idx] + lo) & 0xffff;
}

// fcn.1000e7f0(ctx, offset, *outLo) — 4-level binary search through
// cumCounts[0..15], with inline cumulative-sum bumps. After narrowing to
// a bucket, linear refinement through single_counts within the bucket.
//
// Cumulative-sum maintenance : for ALL leaf paths, the asm's various
// `add dword [edx+N], 0x10001` chains net out to "cumCounts[bucket..15]
// each += 1". The descent COMPARISONS read OLD cumCounts (no bumps applied
// during descent), so my JS port reads cc[] for the 4 levels BEFORE doing
// the trailing bump loop.
//
// Returns [refinedIdx, slotLo]. The caller (arithDecompress) then calls
// `arithBitsRemoveDLL(ab, slotLo, single_counts[refinedIdx], oldTotal)`.

function arithSearch(a, offset) {
    const cc = a.cumCounts;
    let bucket = 0;
    let lo = 0;

    // Level 0 : pivot = cumCounts[7] (asm @ 0x1000e7fa-e805)
    if (offset >= cc[7]) { lo = cc[7]; bucket = 8; }
    // Level 1 : pivot = cumCounts[bucket + 3]    (cc[3] or cc[11])
    if (offset >= cc[bucket + 3]) { lo = cc[bucket + 3]; bucket += 4; }
    // Level 2 : pivot = cumCounts[bucket + 1]    (cc[1], cc[5], cc[9], cc[13])
    if (offset >= cc[bucket + 1]) { lo = cc[bucket + 1]; bucket += 2; }
    // Level 3 : pivot = cumCounts[bucket]        (cc[0], cc[2], ..., cc[14])
    if (offset >= cc[bucket]) { lo = cc[bucket]; bucket += 1; }

    // Inline cumulative-sum bumps : cumCounts[bucket..15] each += 1.
    // (Each asm leaf path executes a different sequence of DWORD adds that
    //  all net out to this. Verified by tracing buckets 0, 1, 4, 8, 15.)
    for (let i = bucket; i < 16; i++) {
        cc[i] = (cc[i] + 1) & 0xffff;
    }

    // Linear refinement within bucket. baseIdx = bucket * bucketSize ;
    // for bucket 15 (or shiftDepth=15 degenerate), the range extends up
    // to uniqueCount. The slot is found when `offset < lo + sc[idx]`.
    // Bound by uniqueCount + 1 — bucket 15 with uniqueCount < bandBoundary
    // would otherwise step beyond the allocated single_counts buffer.
    // Use bucketSize directly — for the tiny case (uC < 5) shiftDepth=15
    // but bucketSize=0, so `bucket << shiftDepth` would overflow into the
    // millions ; the asm uses the stored bucketSize from ctx[+0x28].
    const baseIdx = (bucket * a.bucketSize) | 0;
    let idx = baseIdx;
    let cumLo = lo;
    const sc = a.singleCounts;
    const end = Math.min(sc.length, (a.uniqueCount + 1) | 0);
    while (idx < end) {
        const high = (cumLo + sc[idx]) & 0xffff;
        if (offset < high) {
            return [idx, cumLo];
        }
        cumLo = high;
        idx++;
    }
    // Fallback (shouldn't occur in valid bitstream). Clamp idx to within
    // single_counts AND uniqueCount so callers see a usable slot index.
    const fallback = Math.min(Math.max(idx - 1, 0), Math.max(a.uniqueCount, 0));
    return [fallback, cumLo];
}

// fcn.1000e690(ctx, scratch) — escape-adjust + cumulative-sum re-emit.
// Called from rescale (fcn.1000ec30 @ 0x1000ee16).

function arithReEmitCumFromScratch(a, scratch) {
    // Escape adjust : if not all symbols seen AND escape count is 0,
    // restore escape = 2 (so subsequent picks can still escape).
    // (asm @ 0x1000e6b1-0x1000e6c8)
    if (a.singlesLength !== a.uniqueCount && a.singleCounts[0] === 0) {
        a.singleCounts[0] = 2;
        const bucket0 = (0 >= a.bandBoundary) ? 15 : 0;
        scratch[bucket0] = (scratch[bucket0] + 2) >>> 0;
    }
    // Cumulative-sum emit : cumCounts[0] = scratch[0] ;
    //                       cumCounts[k] = cumCounts[k-1] + scratch[k]
    // (asm @ 0x1000e6cd-0x1000e6e7, U16 arithmetic).
    let cum = 0;
    for (let k = 0; k < 16; k++) {
        cum = (cum + scratch[k]) & 0xffff;
        a.cumCounts[k] = cum;
    }
}

// fcn.1000ec30 — rescale. Triggered when cumCounts[15] >= 0x4000.
//
// Steps :
//   1. Re-init band layout : arithInitBands(a, singlesLength + 1).
//   2. scratch[16] = 0  (asm @ 0x1000ec51-5a, 64-byte memset).
//   3. single_counts[0] >>= 1 ; scratch[bucket(0)] = single_counts[0].
//   4. Main loop i = 1..singlesLength :
//       a. While single_counts[i] <= 1 :
//          - If i >= singlesLength : single_counts[i] = 0,
//            singlesLength--, break.
//          - Else : swap-with-last (single_counts[i] = sc[singlesLength],
//            zero sc[singlesLength], values[i] = values[singlesLength],
//            singlesLength--), do NOT advance i.
//       b. single_counts[i] >>= 1
//          Track (max, maxPos)
//          scratch[bucket(i)] += single_counts[i]
//       c. i++
//   5. Reorder : if max > 0 AND maxPos != target, swap into target slot.
//      target = (singlesLength >> shiftDepth) << shiftDepth  (= bucket
//      start for singlesLength), or bandBoundary if singlesLength >=
//      bandBoundary. Special case : if target = 0, set target = 1
//      (preserve escape slot at index 0).
//      Update scratch[bucket(target)] += delta,
//             scratch[bucket(maxPos)] -= delta.
//   6. Call arithReEmitCumFromScratch (= fcn.1000e690).

function arithRescale(a) {
    // 1. Re-init bands.
    arithInitBands(a, (a.singlesLength + 1) | 0);

    // 2. Scratch.
    const scratch = new Uint32Array(16);

    // 3. Halve single_counts[0], seed scratch.
    a.singleCounts[0] = (a.singleCounts[0] >>> 1) & 0xffff;
    const bucket0 = (0 >= a.bandBoundary) ? 15 : 0;
    scratch[bucket0] = a.singleCounts[0] >>> 0;

    // 4. Main loop.
    let max = 0;
    let maxPos = 0;
    let i = 1;
    while (i <= a.singlesLength) {
        // 4a. Swap-with-last loop.
        while (a.singleCounts[i] <= 1) {
            if (i >= a.singlesLength) {
                // At last position (asm @ 0x1000ed37-3e).
                a.singleCounts[i] = 0;
                a.singlesLength = (a.singlesLength - 1) | 0;
                // Exit both loops — the outer `while (i <= singlesLength)`
                // will also break since i > new singlesLength.
                break;
            }
            // Standard swap (asm @ 0x1000ecb4-d2).
            a.singleCounts[i] = a.singleCounts[a.singlesLength];
            a.singleCounts[a.singlesLength] = 0;
            a.values[i] = a.values[a.singlesLength];
            a.singlesLength = (a.singlesLength - 1) | 0;
        }
        if (i > a.singlesLength) break;
        // 4b. Halve + accumulate.
        a.singleCounts[i] = (a.singleCounts[i] >>> 1) & 0xffff;
        const sc = a.singleCounts[i];
        if (sc > max) {
            max = sc;
            maxPos = i;
        }
        const bucket = (i >= a.bandBoundary) ? 15 : (i >>> a.shiftDepth);
        scratch[bucket] = (scratch[bucket] + sc) >>> 0;
        i++;
    }

    // 5. Reorder max into bucket-start of singlesLength's bucket.
    if (max > 0) {
        let target;
        if (a.singlesLength >= a.bandBoundary) {
            target = a.bandBoundary;
        } else {
            target = (a.singlesLength >>> a.shiftDepth) << a.shiftDepth;
        }
        // Special case (asm @ 0x1000ed7c-7e) : if target = 0, set to 1 to
        // preserve the escape slot at index 0.
        if (target === 0) target = 1;

        if (maxPos !== target) {
            const oldScTarget = a.singleCounts[target] >>> 0;
            const scMaxPos = a.singleCounts[maxPos] >>> 0;
            // Signed delta (one of these can be < the other).
            const delta = (scMaxPos - oldScTarget) | 0;

            const bucketTarget = (target >= a.bandBoundary) ? 15 : (target >>> a.shiftDepth);
            const bucketMaxPos = (maxPos >= a.bandBoundary) ? 15 : (maxPos >>> a.shiftDepth);

            // U32 wrap-around for the scratch updates — the asm uses
            // 32-bit `add dword [ecx], edi` / `add dword [ecx], edx` with
            // signed delta (asm @ 0x1000edcc, 0x1000edf1).
            scratch[bucketTarget] = (scratch[bucketTarget] + delta) >>> 0;
            scratch[bucketMaxPos] = (scratch[bucketMaxPos] - delta) >>> 0;

            // Swap single_counts + values.
            a.singleCounts[target] = scMaxPos;
            a.singleCounts[maxPos] = oldScTarget;
            const valTarget = a.values[target];
            a.values[target] = a.values[maxPos];
            a.values[maxPos] = valTarget;
        }
    }

    // 6. Re-emit cumCounts.
    arithReEmitCumFromScratch(a, scratch);
}

// fcn.1000e0c0(ptr, NULL, uniqueValues, maxValue) — Arith_open (decode side).
//
// Layout :
//   ptr[+0x00..+0x1f] : cumCounts[16] (U16 each)
//   ptr[+0x20]        : singlesLength (U16)
//   ptr[+0x24]        : bandBoundary (U16)
//   ptr[+0x26]        : shiftDepth (byte)
//   ptr[+0x28]        : bucketSize (U16)
//   ptr[+0x2c]        : uniqueCount (U16)
//   ptr[+0x30]        : values* (after inline single_counts)
//   ptr[+0x34]        : compress_temp_buf* (NULL for decompress)
//   ptr[+0x38..]      : inline single_counts[countsSize], then values[countsSize]
//
// JS port splits inline tables into two typed arrays.
//
// `maxValue` is unused on decompress (no compress_temp_buf allocation
// needed) — kept in the signature for backward compat with planeDecode
// callers L1274+.

function arithOpen(_maxValue, uniqueValues) {
    const countsSize = ((uniqueValues + 5) & ~3) | 0;
    const a = {
        cumCounts: new Uint16Array(16),
        singleCounts: new Uint16Array(countsSize),
        values: new Uint16Array(countsSize),
        singlesLength: 0,
        bandBoundary: 0,
        shiftDepth: 0,
        bucketSize: 0,
        uniqueCount: uniqueValues,
    };
    arithInitBands(a, (uniqueValues + 1) | 0);
    // Init prime call : fcn.1000e1c0(ctx, 0, 0x30003)  (asm @ 0x1000e11c).
    // Net effect with idx=0 in cached path : cumCounts[0..15] = 3 each
    // (case 0 fall-through bumps all 16 by lo=hi=3 via DWORD adds), and
    // single_counts[0] = 3.
    arithUpdate(a, 0, 0x30003);
    return a;
}

// Sentinel for escape returns. Symbol values in the decoder are 16-bit
// (max_value < 65536) so the DLL's escape return (a pointer to values[idx])
// would fall outside the U16 raw-value range. In JS we tag escapes with an
// object so `typeof return === 'object'` means "escape, write me a value".

function arithMakeEscape(slot) {
    return { __escape: true, slot };
}

function arithWasEscaped(ret) {
    return typeof ret === 'object';
}

function arithSetDecompressed(escapeRet, value, a) {
    a.values[escapeRet.slot] = value;
}

// fcn.1000e6f0(ctx, ab) — Arith_decompress.
//
//   1. If cumCounts[15] >= 0x4000 : rescale (asm @ 0x1000e6f8-e702).
//   2. Compute offset = ((low + 1) * total - 1) / range
//      (asm @ 0x1000e734-744 ; total = OLD cumCounts[15] read at 0x1000e71a).
//   3. Search : [refinedIdx, slotLo] = arithSearch(a, offset).
//      Side-effect : cumCounts[bucket(refinedIdx)..15] each += 1 (so after
//      this, cumCounts[15] = total + 1).
//   4. arithBitsRemoveDLL(ab, slotLo, single_counts[refinedIdx], total)
//      (asm @ 0x1000e75a-76f ; scale = cumCounts[15] - 1 = total since
//       cumCounts[15] was just bumped to total + 1).
//   5. single_counts[refinedIdx] += 1  (asm @ 0x1000e772).
//   6. If refinedIdx > 0 : return values[refinedIdx] (asm @ 0x1000e7d7-e2).
//   7. Else (escape) :
//      a. singlesLength += 1   (asm @ 0x1000e77c).
//      b. arithUpdate(a, singlesLength, 0x20002)  (asm @ 0x1000e792).
//      c. If singlesLength == uniqueCount : remove escape from cumCounts[0]
//         via arithUpdate(a, 0, ((-sc0 - 1) << 16) | (-sc0 & 0xffff))
//         (asm @ 0x1000e7a4-bd).
//      d. Return arithMakeEscape(singlesLength) — caller writes the new
//         symbol via arithSetDecompressed.

function arithDecompress(a, ab) {
    if (a.cumCounts[15] >= ARITH_RESCALE_TRIGGER) {
        arithRescale(a);
    }

    // Trace replay assertion — gated on globalThis.__igcTrace. Set
    // globalThis.__igcStrictThrow=true to throw on first divergence ;
    // otherwise collects into __igcDivergences and continues. Used by
    // /tmp/igc-replay.mjs to validate against the macOS-wine ARITH trace.
    if (globalThis.__igcTrace) {
        const idx = globalThis.__igcTraceIdx | 0;
        const exp = globalThis.__igcTrace[idx];
        if (exp) {
            const errs = [];
            const actH = ab.high >>> 0, actL = ab.low >>> 0, actT = ab.target >>> 0;
            const expH = parseInt(exp.abH, 16), expL = parseInt(exp.abL, 16), expT = parseInt(exp.abT, 16);
            if (actH !== expH) errs.push(`abH 0x${actH.toString(16)} vs 0x${expH.toString(16)}`);
            if (actL !== expL) errs.push(`abL 0x${actL.toString(16)} vs 0x${expL.toString(16)}`);
            if (actT !== expT) errs.push(`abT 0x${actT.toString(16)} vs 0x${expT.toString(16)}`);
            for (let k = 0; k < 16; k++) {
                if (a.cumCounts[k] !== exp.cum[k]) {
                    errs.push(`cum[${k}] ${a.cumCounts[k]} vs ${exp.cum[k]}`);
                }
            }
            if (a.singlesLength !== exp.sL) errs.push(`sL ${a.singlesLength} vs ${exp.sL}`);
            if (a.bandBoundary !== exp.bB) errs.push(`bB ${a.bandBoundary} vs ${exp.bB}`);
            if (a.shiftDepth !== exp.sD) errs.push(`sD ${a.shiftDepth} vs ${exp.sD}`);
            if (a.uniqueCount !== exp.uC) errs.push(`uC ${a.uniqueCount} vs ${exp.uC}`);
            if (errs.length > 0) {
                if (!globalThis.__igcDivergences) globalThis.__igcDivergences = [];
                globalThis.__igcDivergences.push({ call: exp.call, errs });
                if (globalThis.__igcDivergences.length === 1 || globalThis.__igcStrictThrow) {
                    const e = new Error(`__igcTrace: call ${exp.call} divergence:\n  ${errs.join('\n  ')}`);
                    e.callIdx = exp.call;
                    if (globalThis.__igcStrictThrow) throw e;
                    process.stderr.write(`!! First divergence at call ${exp.call}:\n  ${errs.join('\n  ')}\n`);
                }
            }
        }
        globalThis.__igcTraceIdx = idx + 1;
    }

    const total = a.cumCounts[15];
    const offset = arithBitsGet(ab, total);
    const [refinedIdx, slotLo] = arithSearch(a, offset);
    const slotCount = a.singleCounts[refinedIdx];

    arithBitsRemove(ab, slotLo, slotCount, total);
    a.singleCounts[refinedIdx] = (a.singleCounts[refinedIdx] + 1) & 0xffff;

    if (refinedIdx !== 0) {
        return a.values[refinedIdx];
    }

    // Escape : new symbol.
    a.singlesLength = (a.singlesLength + 1) & 0xffff;
    arithUpdate(a, a.singlesLength, 0x20002);

    if (a.singlesLength === a.uniqueCount) {
        // Remove escape contribution from cumCounts[0]. The magic =
        //   ((-sc0 - 1) << 16) | (-sc0 & 0xffff)
        // matches the asm at 0x1000e7a4-b7 exactly. With sc0 = current
        // single_counts[0], the DWORD add of magic to cumCounts[0..1]
        // subtracts (sc0+1) from cumCounts[1] and sc0 from cumCounts[0],
        // effectively zeroing the escape weight.
        const sc0 = a.singleCounts[0] | 0;
        const negSc0 = (-sc0) & 0xffff;
        const magicHi = ((-sc0 - 1) & 0xffff) << 16;
        const magic = (magicHi | negSc0) >>> 0;
        arithUpdate(a, 0, magic);
    }

    return arithMakeEscape(a.singlesLength);
}

// ============================================================================
// Inverse wavelet kernels.
// Leaked-SDK ref : `wavelet.c:467-1170` (iDWTrow + iDWTcol),
//                  `wavelet.c:1175-1325` (iHarrrow + iHarrcol),
//                  `wavelet.c:1328-1363` (iDWT2D dispatcher).
// Asm cite : `granny2.dll @ 0x10009700`.
//
// All buffers are Int16Array. The SDK uses byte pitches throughout (pointers
// are char*) ; we pre-divide by 2 so all pitch / offset arithmetic in this
// section is in S16 indices (not bytes).
//
// The 9 lifting coefficients (51674, 2667, 1563, 24733, 27400, 4230, 55882,
// 2479, 7250) are the RAD reversible-integer DWT (granny_bink0). Off-by-one
// in any addend = wrong output.
//
// The round-to-S16 trick `(x + (32767 ^ (x >> 31))) / 65536` = signed
// round-half-away-from-zero.

function roundS16(x) {
    // (x + (32767 ^ (x >> 31))) / 65536, truncated.
    const sign = x >> 31;
    return ((x + (32767 ^ sign)) / 65536) | 0;
}

// iDWT ring buffers hoisted out of the per-row / per-4-col-group loops.
// `iDWTcol` re-allocated `lp`/`hp` on every 4-col group (the hottest IGC
// function) ; pooling kills that allocation churn on the hottest path.
//
// Two invariants make reuse byte-exact (verified by the content manifest
// across all 17 IGC textures) :
//   1. Each kernel fully (re)initialises every slot it reads before reading
//      it — the initial-fill block seeds the first window, then the
//      just-in-time refill writes entry (k+3) one iteration before it is
//      read. Stale values from a prior group/row are always overwritten
//      first, so no per-iteration `.fill(0)` is needed.
//   2. The `iDWTcol` recenter intentionally reads one entry PAST the end
//      (OOB → undefined → coerced to 0 on store). Sizes must stay EXACTLY
//      the original per-iteration allocation sizes — oversizing would turn
//      that 0 into a stale value and change decoded bytes.
// The kernels are non-reentrant leaves (they never call each other, and
// decode is sequential), so module-scoped pools are safe.
const _rowLp = new Int32Array(8);
const _rowHp = new Int32Array(8);
const _colLp = new Int32Array((16 + 4) * 4);
const _colHp = new Int32Array((16 + 5) * 4);
const _remLp = new Int32Array(4);
const _remHp = new Int32Array(5);

function iDWTrow(dest, destPitch, src, srcPitch, width, height, rowMask, startY, subHeight) {
    // wavelet.c:467 — iDWTrow. Combines `halfwidth` low + `halfwidth` high
    // S16s per row into a full-width S16 row.
    // - dest, src : Int16Array
    // - destPitch, srcPitch : S16 index pitch (row stride in S16 elements)
    // - width : output width in S16 elements (= 2 * halfwidth)
    // - rowMask : Uint8Array | null (null → process every row as non-zero)
    // - startY, subHeight : row range to process
    const halfwidth = width >> 1;

    let outBase = startY * destPitch;
    let linBase = startY * srcPitch;
    let hinBase = startY * srcPitch + halfwidth; // hin starts at low-end + halfwidth (in S16 units)
    let maskIdx = startY;

    // ringbuffer-like state for the row : lp[ 8 ] + hp[ 8 ] with -base
    // offsets. We pack into Int32Array indexed 0..7 (lp) and 0..7 (hp), using
    // offset +1 (lp) and +2 (hp) as the "center" of the kernel window.
    // Pooled — fully re-seeded per row by the initial-fill below.
    const lp = _rowLp;
    const hp = _rowHp;

    for (let y = 0; y < subHeight; y++) {
        let next = 1; // S16-element step (was 2 bytes in SDK)

        let xoutIdx = outBase;
        let xlinIdx = linBase;
        let xhinIdx = hinBase;
        const linEnd = linBase + halfwidth; // boundary for clamp (was lin+width bytes = lin+halfwidth S16)

        // Initial population : 6 lp + 6 hp values.
        // SDK reads 6 low pixels into lp[0..5] (with offset +1) :
        //   lp[0+1] = lin[0]
        //   lp[-1+1] = lp[1+1] = lin[1]   (boundary mirror)
        //   lp[2+1] = lin[2]
        //   lp[2+1+1] = lin[3]
        //   lp[2+1+2] = lin[4]
        //   lp[2+1+3] = lin[5]
        //   xlin += 12 bytes = 6 S16
        lp[0 + 1] = src[xlinIdx + 0];
        lp[-1 + 1] = lp[1 + 1] = src[xlinIdx + 1];
        lp[2 + 1] = src[xlinIdx + 2];
        lp[2 + 1 + 1] = src[xlinIdx + 3];
        lp[2 + 1 + 2] = src[xlinIdx + 4];
        lp[2 + 1 + 3] = src[xlinIdx + 5];
        xlinIdx += 6;

        // 6 hp values with boundary mirror :
        //   hp[0+2] = hin[0], hp[1+2] = hin[1], hp[2+2] = hin[2],
        //   hp[2+2+1] = hin[3], hp[2+2+2] = hin[4], hp[2+2+3] = hin[5]
        //   hp[-2+2] = hp[1+2]   (boundary)
        //   hp[-1+2] = hp[0+2]
        //   xhin += 12 bytes = 6 S16
        hp[0 + 2] = src[xhinIdx + 0];
        hp[1 + 2] = src[xhinIdx + 1];
        hp[2 + 2] = src[xhinIdx + 2];
        hp[2 + 2 + 1] = src[xhinIdx + 3];
        hp[2 + 2 + 2] = src[xhinIdx + 4];
        hp[2 + 2 + 3] = src[xhinIdx + 5];
        hp[-2 + 2] = hp[1 + 2];
        hp[-1 + 2] = hp[0 + 2];
        xhinIdx += 6;

        // We've consumed 6 of the halfwidth S16 from lin + 6 from hin.
        // Remaining iterations : halfwidth - 6 of them, in groups of 4 + tail.
        // SDK : x = (halfwidth < 8) ? 0 : (halfwidth - 8) / 4. The "8" is
        // because the unrolled body reads 2 ahead (initial 6 + 2 ahead).

        const isNonZero = (rowMask === null) || rowMask[maskIdx];

        let x = (halfwidth < 8) ? 0 : ((halfwidth - 8) / 4) | 0;

        if (isNonZero) {
            // groups-of-4 unrolled
            while (x-- > 0) {
                // 4 pixel pairs (e1/o1, e2/o2, e3/o3, e4/o4) using lp[k+1+i]
                // and hp[k+2+i] with i=0..3
                let e1, o1, e2, o2, e3, o3, e4, o4;

                e1 = (lp[0 + 1] * 51674)
                    - (((lp[-1 + 1] + lp[1 + 1]) * 2667) | 0)
                    - (((hp[-2 + 2] + hp[1 + 2]) * 1563) | 0)
                    + (((hp[-1 + 2] + hp[0 + 2]) * 24733) | 0);
                o1 = (((lp[0 + 1] + lp[1 + 1]) * 27400) | 0)
                    - (((lp[-1 + 1] + lp[2 + 1]) * 4230) | 0)
                    - ((hp[0 + 2] * 55882) | 0)
                    - (((hp[-2 + 2] + hp[2 + 2]) * 2479) | 0)
                    + (((hp[-1 + 2] + hp[1 + 2]) * 7250) | 0);

                e2 = (lp[0 + 1 + 1] * 51674)
                    - (((lp[-1 + 1 + 1] + lp[1 + 1 + 1]) * 2667) | 0)
                    - (((hp[-2 + 2 + 1] + hp[1 + 2 + 1]) * 1563) | 0)
                    + (((hp[-1 + 2 + 1] + hp[0 + 2 + 1]) * 24733) | 0);
                o2 = (((lp[0 + 1 + 1] + lp[1 + 1 + 1]) * 27400) | 0)
                    - (((lp[-1 + 1 + 1] + lp[2 + 1 + 1]) * 4230) | 0)
                    - ((hp[0 + 2 + 1] * 55882) | 0)
                    - (((hp[-2 + 2 + 1] + hp[2 + 2 + 1]) * 2479) | 0)
                    + (((hp[-1 + 2 + 1] + hp[1 + 2 + 1]) * 7250) | 0);

                e3 = (lp[0 + 1 + 2] * 51674)
                    - (((lp[-1 + 1 + 2] + lp[1 + 1 + 2]) * 2667) | 0)
                    - (((hp[-2 + 2 + 2] + hp[1 + 2 + 2]) * 1563) | 0)
                    + (((hp[-1 + 2 + 2] + hp[0 + 2 + 2]) * 24733) | 0);
                o3 = (((lp[0 + 1 + 2] + lp[1 + 1 + 2]) * 27400) | 0)
                    - (((lp[-1 + 1 + 2] + lp[2 + 1 + 2]) * 4230) | 0)
                    - ((hp[0 + 2 + 2] * 55882) | 0)
                    - (((hp[-2 + 2 + 2] + hp[2 + 2 + 2]) * 2479) | 0)
                    + (((hp[-1 + 2 + 2] + hp[1 + 2 + 2]) * 7250) | 0);

                e4 = (lp[0 + 1 + 3] * 51674)
                    - (((lp[-1 + 1 + 3] + lp[1 + 1 + 3]) * 2667) | 0)
                    - (((hp[-2 + 2 + 3] + hp[1 + 2 + 3]) * 1563) | 0)
                    + (((hp[-1 + 2 + 3] + hp[0 + 2 + 3]) * 24733) | 0);
                o4 = (((lp[0 + 1 + 3] + lp[1 + 1 + 3]) * 27400) | 0)
                    - (((lp[-1 + 1 + 3] + lp[2 + 1 + 3]) * 4230) | 0)
                    - ((hp[0 + 2 + 3] * 55882) | 0)
                    - (((hp[-2 + 2 + 3] + hp[2 + 2 + 3]) * 2479) | 0)
                    + (((hp[-1 + 2 + 3] + hp[1 + 2 + 3]) * 7250) | 0);

                e1 = roundS16(e1); o1 = roundS16(o1);
                e2 = roundS16(e2); o2 = roundS16(o2);
                e3 = roundS16(e3); o3 = roundS16(o3);
                e4 = roundS16(e4); o4 = roundS16(o4);

                // Write 8 S16 (e1, o1, e2, o2, e3, o3, e4, o4) packed LE.
                dest[xoutIdx + 0] = e1;
                dest[xoutIdx + 1] = o1;
                dest[xoutIdx + 2] = e2;
                dest[xoutIdx + 3] = o2;
                dest[xoutIdx + 4] = e3;
                dest[xoutIdx + 5] = o3;
                dest[xoutIdx + 6] = e4;
                dest[xoutIdx + 7] = o4;
                xoutIdx += 8;

                // Shift lp/hp ring buffer 4 positions left and refill.
                lp[0] = lp[4]; lp[1] = lp[5]; lp[2] = lp[6];
                lp[3] = src[xlinIdx + 0];
                lp[4] = src[xlinIdx + 1];
                lp[5] = src[xlinIdx + 2];
                lp[6] = src[xlinIdx + 3];

                hp[0] = hp[4]; hp[1] = hp[5]; hp[2] = hp[6]; hp[3] = hp[7];
                hp[4] = src[xhinIdx + 0];
                hp[5] = src[xhinIdx + 1];
                hp[6] = src[xhinIdx + 2];
                hp[7] = src[xhinIdx + 3];

                xlinIdx += 4;
                xhinIdx += 4;
            }

            // Remnants : (halfwidth & 3) + 8 single pixels (or all of
            // halfwidth if halfwidth < 8).
            let xRem = (halfwidth < 8) ? halfwidth : ((halfwidth & 3) + 8);

            while (xRem-- > 0) {
                // Boundary check : xlinIdx === hinBase means we've reached
                // the end of the low band ; mirror.
                if (xlinIdx === linEnd) {
                    xlinIdx -= next;
                    xhinIdx -= next + next;
                    next = -next;
                }

                let e = (lp[0 + 1] * 51674)
                    - (((lp[-1 + 1] + lp[1 + 1]) * 2667) | 0)
                    - (((hp[-2 + 2] + hp[1 + 2]) * 1563) | 0)
                    + (((hp[-1 + 2] + hp[0 + 2]) * 24733) | 0);
                let o = (((lp[0 + 1] + lp[1 + 1]) * 27400) | 0)
                    - (((lp[-1 + 1] + lp[2 + 1]) * 4230) | 0)
                    - ((hp[0 + 2] * 55882) | 0)
                    - (((hp[-2 + 2] + hp[2 + 2]) * 2479) | 0)
                    + (((hp[-1 + 2] + hp[1 + 2]) * 7250) | 0);

                e = roundS16(e);
                o = roundS16(o);

                dest[xoutIdx + 0] = e;
                dest[xoutIdx + 1] = o;
                xoutIdx += 2;

                lp[0] = lp[1]; lp[1] = lp[2]; lp[2] = lp[3];
                lp[3] = lp[4]; lp[4] = lp[5]; lp[5] = lp[6];
                lp[6] = src[xlinIdx];

                hp[0] = hp[1]; hp[1] = hp[2]; hp[2] = hp[3];
                hp[3] = hp[4]; hp[4] = hp[5]; hp[5] = hp[6]; hp[6] = hp[7];
                hp[7] = src[xhinIdx];

                xlinIdx += next;
                xhinIdx += next;
            }
        } else {
            // zero row : H-plane terms dropped
            while (x-- > 0) {
                let e1, o1, e2, o2, e3, o3, e4, o4;
                e1 = (lp[0 + 1] * 51674) - (((lp[-1 + 1] + lp[1 + 1]) * 2667) | 0);
                o1 = (((lp[0 + 1] + lp[1 + 1]) * 27400) | 0) - (((lp[-1 + 1] + lp[2 + 1]) * 4230) | 0);
                e2 = (lp[0 + 1 + 1] * 51674) - (((lp[-1 + 1 + 1] + lp[1 + 1 + 1]) * 2667) | 0);
                o2 = (((lp[0 + 1 + 1] + lp[1 + 1 + 1]) * 27400) | 0) - (((lp[-1 + 1 + 1] + lp[2 + 1 + 1]) * 4230) | 0);
                e3 = (lp[0 + 1 + 2] * 51674) - (((lp[-1 + 1 + 2] + lp[1 + 1 + 2]) * 2667) | 0);
                o3 = (((lp[0 + 1 + 2] + lp[1 + 1 + 2]) * 27400) | 0) - (((lp[-1 + 1 + 2] + lp[2 + 1 + 2]) * 4230) | 0);
                e4 = (lp[0 + 1 + 3] * 51674) - (((lp[-1 + 1 + 3] + lp[1 + 1 + 3]) * 2667) | 0);
                o4 = (((lp[0 + 1 + 3] + lp[1 + 1 + 3]) * 27400) | 0) - (((lp[-1 + 1 + 3] + lp[2 + 1 + 3]) * 4230) | 0);

                e1 = roundS16(e1); o1 = roundS16(o1);
                e2 = roundS16(e2); o2 = roundS16(o2);
                e3 = roundS16(e3); o3 = roundS16(o3);
                e4 = roundS16(e4); o4 = roundS16(o4);

                dest[xoutIdx + 0] = e1;
                dest[xoutIdx + 1] = o1;
                dest[xoutIdx + 2] = e2;
                dest[xoutIdx + 3] = o2;
                dest[xoutIdx + 4] = e3;
                dest[xoutIdx + 5] = o3;
                dest[xoutIdx + 6] = e4;
                dest[xoutIdx + 7] = o4;
                xoutIdx += 8;

                lp[0] = lp[4]; lp[1] = lp[5]; lp[2] = lp[6];
                lp[3] = src[xlinIdx + 0];
                lp[4] = src[xlinIdx + 1];
                lp[5] = src[xlinIdx + 2];
                lp[6] = src[xlinIdx + 3];

                xlinIdx += 4;
            }

            let xRem = (halfwidth < 8) ? halfwidth : ((halfwidth & 3) + 8);
            while (xRem-- > 0) {
                if (xlinIdx === linEnd) {
                    xlinIdx -= 1;
                    next = -1;
                }

                let e = (lp[0 + 1] * 51674) - (((lp[-1 + 1] + lp[1 + 1]) * 2667) | 0);
                let o = (((lp[0 + 1] + lp[1 + 1]) * 27400) | 0) - (((lp[-1 + 1] + lp[2 + 1]) * 4230) | 0);

                e = roundS16(e);
                o = roundS16(o);

                dest[xoutIdx + 0] = e;
                dest[xoutIdx + 1] = o;
                xoutIdx += 2;

                lp[0] = lp[1]; lp[1] = lp[2]; lp[2] = lp[3];
                lp[3] = lp[4]; lp[4] = lp[5]; lp[5] = lp[6];
                lp[6] = src[xlinIdx];

                xlinIdx += next;
            }
        }

        outBase += destPitch;
        linBase += srcPitch;
        hinBase += srcPitch;
        ++maskIdx;
    }
}

function iDWTcol(dest, destPitch, src, srcPitch, width, height, startY, subHeight) {
    // wavelet.c:836 — iDWTcol. Inverse-DWT along columns. Inner loop
    // unrolled to 4 cols at a time.
    const halfheight = subHeight >> 1;

    let outBase = startY * destPitch;
    let linBase = 0;          // S16 index, low band starts at col 0
    let hinBase = srcPitch;   // high band starts at col 0 of row 1 (since each "L" row alternates with "H" row in input layout)
    // `lendCol0` = col-0 end-of-buffer marker. Per-column boundary marker is
    // `lendCol0 + colsBase` (asm cite : granny2.dll @ 0x10008981 sets
    // [var_1a4h], 0x1000949a advances by 2 bytes = 1 S16 per col-iteration).
    // Without the +colsBase term, the strict-equality check at 0x100092f6
    // misses for any group beyond colsBase=0 and the reflect never fires.
    const lendCol0 = srcPitch * height;
    const ppitch2 = srcPitch * 2;   // we increment by 2 srcPitch per pair (one L row + one H row)

    if (startY) {
        linBase += ((startY / 2 | 0) - 1) * ppitch2;
        hinBase += ((startY / 2 | 0) - 2) * ppitch2;
    }

    // Process 4-col groups
    let colsBase = 0;
    const groupCount = (width / 4) | 0;

    // Ring buffer : lp[(16+4)][4], hp[(16+5)][4]. Each entry is a 4-tuple of
    // S16 columns. In JS we flatten to Int32Array of size 20*4 / 21*4.

    for (let g = 0; g < groupCount; g++) {
        let next = ppitch2;
        let youtBase = outBase + colsBase;
        let ylinBase = linBase + colsBase;
        let yhinBase = hinBase + colsBase;
        const lend = lendCol0 + colsBase;

        const lp = _colLp;   // pooled — see notes above iDWTrow
        const hp = _colHp;

        // Initial fill — startY ? 4L+5H : 3L+3H with boundary mirror
        if (startY) {
            // lp[-1+1..2+1] from ylin (4 rows)
            for (let k = 0; k < 4; k++) lp[(-1 + 1) * 4 + k] = src[ylinBase + k];
            ylinBase += next;
            for (let k = 0; k < 4; k++) lp[(0 + 1) * 4 + k] = src[ylinBase + k];
            ylinBase += next;
            for (let k = 0; k < 4; k++) lp[(1 + 1) * 4 + k] = src[ylinBase + k];
            ylinBase += next;
            for (let k = 0; k < 4; k++) lp[(2 + 1) * 4 + k] = src[ylinBase + k];
            ylinBase += next;

            for (let k = 0; k < 4; k++) hp[(-2 + 2) * 4 + k] = src[yhinBase + k];
            yhinBase += next;
            for (let k = 0; k < 4; k++) hp[(-1 + 2) * 4 + k] = src[yhinBase + k];
            yhinBase += next;
            for (let k = 0; k < 4; k++) hp[(0 + 2) * 4 + k] = src[yhinBase + k];
            yhinBase += next;
            for (let k = 0; k < 4; k++) hp[(1 + 2) * 4 + k] = src[yhinBase + k];
            yhinBase += next;
            for (let k = 0; k < 4; k++) hp[(2 + 2) * 4 + k] = src[yhinBase + k];
            yhinBase += next;
        } else {
            for (let k = 0; k < 4; k++) lp[(0 + 1) * 4 + k] = src[ylinBase + k];
            ylinBase += next;
            for (let k = 0; k < 4; k++) {
                const v = src[ylinBase + k];
                lp[(-1 + 1) * 4 + k] = v;
                lp[(1 + 1) * 4 + k] = v;
            }
            ylinBase += next;
            for (let k = 0; k < 4; k++) lp[(2 + 1) * 4 + k] = src[ylinBase + k];
            ylinBase += next;

            for (let k = 0; k < 4; k++) {
                const v = src[yhinBase + k];
                hp[(-1 + 2) * 4 + k] = v;
                hp[(0 + 2) * 4 + k] = v;
            }
            yhinBase += next;
            for (let k = 0; k < 4; k++) {
                const v = src[yhinBase + k];
                hp[(-2 + 2) * 4 + k] = v;
                hp[(1 + 2) * 4 + k] = v;
            }
            yhinBase += next;
            for (let k = 0; k < 4; k++) hp[(2 + 2) * 4 + k] = src[yhinBase + k];
            yhinBase += next;
        }

        // lp/hp index into a sliding window. SDK uses `lp` and `hp` pointers
        // that advance through the local array.
        let lpOff = 0; // base index into lp[]
        let hpOff = 0;

        for (let y = 0; y < halfheight; y++) {
            // boundary check
            if (ylinBase === lend) {
                ylinBase -= next;
                yhinBase -= next + next;
                next = -next;
            }

            // 4 columns at once
            const lpC = lpOff;
            const hpC = hpOff;
            let e1, e2, e3, e4, o1, o2, o3, o4;

            for (let k = 0; k < 4; k++) {
                const lpm1 = lp[(lpC + 0) * 4 + k];
                const lp0 = lp[(lpC + 1) * 4 + k];
                const lp1 = lp[(lpC + 2) * 4 + k];
                const lp2 = lp[(lpC + 3) * 4 + k];

                const hpm2 = hp[(hpC + 0) * 4 + k];
                const hpm1 = hp[(hpC + 1) * 4 + k];
                const hp0 = hp[(hpC + 2) * 4 + k];
                const hp1 = hp[(hpC + 3) * 4 + k];
                const hp2 = hp[(hpC + 4) * 4 + k];

                const e = (lp0 * 51674)
                    - (((lpm1 + lp1) * 2667) | 0)
                    - (((hpm2 + hp1) * 1563) | 0)
                    + (((hpm1 + hp0) * 24733) | 0);
                const o = (((lp0 + lp1) * 27400) | 0)
                    - (((lpm1 + lp2) * 4230) | 0)
                    - ((hp0 * 55882) | 0)
                    - (((hpm2 + hp2) * 2479) | 0)
                    + (((hpm1 + hp1) * 7250) | 0);

                const er = roundS16(e);
                const or = roundS16(o);

                if (k === 0) { e1 = er; o1 = or; }
                else if (k === 1) { e2 = er; o2 = or; }
                else if (k === 2) { e3 = er; o3 = or; }
                else { e4 = er; o4 = or; }
            }

            dest[youtBase + 0] = e1;
            dest[youtBase + 1] = e2;
            dest[youtBase + 2] = e3;
            dest[youtBase + 3] = e4;
            dest[youtBase + destPitch + 0] = o1;
            dest[youtBase + destPitch + 1] = o2;
            dest[youtBase + destPitch + 2] = o3;
            dest[youtBase + destPitch + 3] = o4;

            youtBase += destPitch + destPitch;

            ++lpOff;
            ++hpOff;

            // re-center if we've hit the end of the local buffers
            // SDK : if (&lp[3][0] == &a.hp[0][0]) → since lp is [16+4][4] = 20 entries, hp follows immediately at offset 20. So when lpOff = 17, lp[3] = entry 20 = hp[0].
            if (lpOff + 3 === 16 + 4) {
                for (let k = 0; k < 4; k++) lp[0 * 4 + k] = lp[(lpOff + 1) * 4 + k];
                for (let k = 0; k < 4; k++) lp[1 * 4 + k] = lp[(lpOff + 2) * 4 + k];
                for (let k = 0; k < 4; k++) lp[2 * 4 + k] = lp[(lpOff + 3) * 4 + k];
                for (let k = 0; k < 4; k++) hp[0 * 4 + k] = hp[(hpOff + 1) * 4 + k];
                for (let k = 0; k < 4; k++) hp[1 * 4 + k] = hp[(hpOff + 2) * 4 + k];
                for (let k = 0; k < 4; k++) hp[2 * 4 + k] = hp[(hpOff + 3) * 4 + k];
                for (let k = 0; k < 4; k++) hp[3 * 4 + k] = hp[(hpOff + 4) * 4 + k];
                lpOff = 0;
                hpOff = 0;
            }

            // refill : lp[3][...] = ylin, hp[4][...] = yhin
            for (let k = 0; k < 4; k++) lp[(lpOff + 3) * 4 + k] = src[ylinBase + k];
            for (let k = 0; k < 4; k++) hp[(hpOff + 4) * 4 + k] = src[yhinBase + k];

            ylinBase += next;
            yhinBase += next;
        }

        colsBase += 4;
    }

    // Remaining columns (width & 3)
    const remCols = width & 3;
    for (let g = 0; g < remCols; g++) {
        let next = ppitch2;
        let youtBase = outBase + colsBase;
        let ylinBase = linBase + colsBase;
        let yhinBase = hinBase + colsBase;
        const lend = lendCol0 + colsBase;

        const lp = _remLp;   // pooled — re-seeded per remainder col below
        const hp = _remHp;

        if (startY) {
            lp[-1 + 1] = src[ylinBase]; ylinBase += next;
            lp[0 + 1] = src[ylinBase]; ylinBase += next;
            lp[1 + 1] = src[ylinBase]; ylinBase += next;
            lp[2 + 1] = src[ylinBase]; ylinBase += next;
            hp[-2 + 2] = src[yhinBase]; yhinBase += next;
            hp[-1 + 2] = src[yhinBase]; yhinBase += next;
            hp[0 + 2] = src[yhinBase]; yhinBase += next;
            hp[1 + 2] = src[yhinBase]; yhinBase += next;
            hp[2 + 2] = src[yhinBase]; yhinBase += next;
        } else {
            lp[0 + 1] = src[ylinBase]; ylinBase += next;
            lp[-1 + 1] = lp[1 + 1] = src[ylinBase]; ylinBase += next;
            lp[2 + 1] = src[ylinBase]; ylinBase += next;
            hp[-1 + 2] = hp[0 + 2] = src[yhinBase]; yhinBase += next;
            hp[-2 + 2] = hp[1 + 2] = src[yhinBase]; yhinBase += next;
            hp[2 + 2] = src[yhinBase]; yhinBase += next;
        }

        for (let y = 0; y < halfheight; y++) {
            if (ylinBase === lend) {
                ylinBase -= next;
                yhinBase -= next + next;
                next = -next;
            }

            const e = (lp[0 + 1] * 51674)
                - (((lp[-1 + 1] + lp[1 + 1]) * 2667) | 0)
                - (((hp[-2 + 2] + hp[1 + 2]) * 1563) | 0)
                + (((hp[-1 + 2] + hp[0 + 2]) * 24733) | 0);
            const o = (((lp[0 + 1] + lp[1 + 1]) * 27400) | 0)
                - (((lp[-1 + 1] + lp[2 + 1]) * 4230) | 0)
                - ((hp[0 + 2] * 55882) | 0)
                - (((hp[-2 + 2] + hp[2 + 2]) * 2479) | 0)
                + (((hp[-1 + 2] + hp[1 + 2]) * 7250) | 0);

            dest[youtBase] = roundS16(e);
            dest[youtBase + destPitch] = roundS16(o);

            youtBase += destPitch + destPitch;

            lp[0] = lp[1]; lp[1] = lp[2]; lp[2] = lp[3];
            lp[3] = src[ylinBase];

            hp[0] = hp[1]; hp[1] = hp[2]; hp[2] = hp[3]; hp[3] = hp[4];
            hp[4] = src[yhinBase];

            ylinBase += next;
            yhinBase += next;
        }

        colsBase += 1;
    }
}

function iHarrrow(dest, destPitch, src, srcPitch, width, height, rowMask, startY, subHeight) {
    // wavelet.c:1175 — iHarrrow. Haar inverse row (small-width fallback).
    const halfwidth = width >> 1;

    let outBase = startY * destPitch;
    let linBase = startY * srcPitch;
    let hinBase = startY * srcPitch + halfwidth;
    let maskIdx = startY;

    for (let y = 0; y < subHeight; y++) {
        let xoutIdx = outBase;
        let xlinIdx = linBase;
        let xhinIdx = hinBase;

        const isNonZero = (rowMask === null) || rowMask[maskIdx];

        if (isNonZero) {
            for (let x = 0; x < halfwidth; x++) {
                const lv = src[xlinIdx];
                const hv = src[xhinIdx];
                let e = (lv * 2 + hv) | 0;
                let o = (lv * 2 - hv) | 0;
                e = ((e + (1 ^ (e >> 31))) / 2) | 0;
                o = ((o + (1 ^ (o >> 31))) / 2) | 0;
                dest[xoutIdx + 0] = e;
                dest[xoutIdx + 1] = o;
                xoutIdx += 2;
                xlinIdx += 1;
                xhinIdx += 1;
            }
        } else {
            for (let x = 0; x < halfwidth; x++) {
                const e = src[xlinIdx];
                dest[xoutIdx + 0] = e;
                dest[xoutIdx + 1] = e;
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

function iHarrcol(dest, destPitch, src, srcPitch, width, height, startY, subHeight) {
    // wavelet.c:1261 — iHarrcol.
    const halfheight = subHeight >> 1;

    let outBase = startY * destPitch;
    let linBase = 0;
    let hinBase = srcPitch;
    const ppitch2 = srcPitch * 2;

    if (startY) {
        linBase += (startY / 2 | 0) * ppitch2;
        hinBase += (startY / 2 | 0) * ppitch2;
    }

    for (let x = 0; x < width; x++) {
        let youtBase = outBase + x;
        let ylinBase = linBase + x;
        let yhinBase = hinBase + x;

        for (let y = 0; y < halfheight; y++) {
            const lv = src[ylinBase];
            const hv = src[yhinBase];
            let e = (lv * 2 + hv) | 0;
            let o = (lv * 2 - hv) | 0;
            e = ((e + (1 ^ (e >> 31))) / 2) | 0;
            o = ((o + (1 ^ (o >> 31))) / 2) | 0;
            dest[youtBase] = e;
            dest[youtBase + destPitch] = o;
            youtBase += destPitch + destPitch;
            ylinBase += ppitch2;
            yhinBase += ppitch2;
        }
    }
}

function iDWT2D(output, pitch, width, height, rowMask, temp) {
    // wavelet.c:1328 — iDWT2D dispatcher.
    // - output, temp : Int16Array, same length as the plane
    // - pitch : S16-index pitch
    const rowFn = (width >= SMALLEST_DWT_ROW) ? iDWTrow : iHarrrow;
    const colFn = (height >= SMALLEST_DWT_COL) ? iDWTcol : iHarrcol;

    let ry = (height <= (FLIPSIZE + 4 + 4)) ? height : (FLIPSIZE + 4);
    let rh = height - ry;
    let cy = 0;
    let ch = height;

    rowFn(temp, pitch, output, pitch, width, height, rowMask, 0, ry);

    do {
        let next = (ch <= (FLIPSIZE + 4)) ? ch : FLIPSIZE;
        colFn(output, pitch, temp, pitch, width, height, cy, next);
        cy += next;
        ch -= next;

        if (rh) {
            next = (rh <= (FLIPSIZE + 4)) ? rh : FLIPSIZE;
            rowFn(temp, pitch, output, pitch, width, height, rowMask, ry, next);
            ry += next;
            rh -= next;
        }
    } while (ch);
}

// ============================================================================
// Plane decoders.
// Leaked-SDK ref : `encode.c:532` (read_escapes),
//                  `encode.c:1416` (fill_rect),
//                  `encode.c:1440` (decode_low),
//                  `encode.c:1576` (create_decomp_contexts),
//                  `encode.c:1611` (decode_high_1),
//                  `encode.c:1884` (plane_decode).
// Asm cite : `granny2.dll @ 0x100045b0` (`FromBinkTC`).

const MIN_ZERO_LENGTH = 3;
const LIT_LENGTH_BITS = 6;
const ZERO_LENGTH_BITS = 8;
const LIT_LENGTH_LIMIT = (1 << LIT_LENGTH_BITS) - 1;
const ZERO_LENGTH_LIMIT = (1 << ZERO_LENGTH_BITS) - 1;
const EXTRA_LENGTHS = 4;
const EXTRA_LIT_LENGTHS = [128, 256, 512, 1024];
const EXTRA_ZERO_LENGTHS = [512, 1024, 2048, 3072];

function getBitLevel(value) {
    // varbits.h — getbitlevel. SDK caps at 15 for value >= 16384, and
    // operates on U32 (so wraparound on large values must keep the value
    // unsigned, not flip to negative). Use `>>> 0` to coerce to U32.
    let n = value >>> 0;
    if (n === 0) return 0;
    if (n >= 16384) return 15;
    let r = 0;
    while (n > 0) {
        r++;
        n >>>= 1;
    }
    return r;
}

function fillRect(outp, outOffset, pitch, width, height, val) {
    // encode.c:1416 — fill_rect
    const yadj = pitch - width;
    let o = outOffset;
    for (let h = 0; h < height; h++) {
        for (let w = 0; w < width; w++) {
            outp[o++] = val;
        }
        o += yadj;
    }
}

function readEscapes(ab, mask, count) {
    // encode.c:532 — read_escapes. Decodes a length-`count` byte array
    // (0 or 1 per slot) representing zero-row RLE.
    const zeros = arithBitsGetValue(ab, count + 1);

    for (let i = 0; i < count; i++) {
        if (arithBitsGet(ab, count) >= zeros) {
            mask[i] = 1;
            arithBitsRemove(ab, zeros, count - zeros, count);
        } else {
            mask[i] = 0;
            arithBitsRemove(ab, 0, zeros, count);
        }
    }
}

function decodeLow(ab, vb, outp, outOffset, pixelPitch, encWidth, encHeight) {
    // encode.c:1440 — decode_low. Low-pass plane, no per-plane prediction
    // (just pixel-to-left/above prediction within this plane).
    // Returns nothing ; populates outp at outOffset.

    // See if all bytes are a single value
    if (varBitsGet1(vb)) {
        const v = varBitsGet(vb, 16);
        fillRect(outp, outOffset, pixelPitch, encWidth, encHeight, s16(v));
        return;
    }

    const max = varBitsGet(vb, 16);
    const num = max + 1;

    const a = arithOpen(max, num);

    const yadj = pixelPitch - encWidth;

    // First pixel raw
    let prev = varBitsGet(vb, 16);
    outp[outOffset++] = s16(prev);
    prev = s16(prev);

    // First row : predict from left pixel
    for (let w = 0; w < encWidth - 1; w++) {
        let cur = arithDecompress(a, ab);

        if (arithWasEscaped(cur)) {
            const escaped = arithBitsGetValue(ab, num);
            arithSetDecompressed(cur, escaped, a);
            cur = escaped;
        }

        if (cur) {
            // sign bit
            const v = -varBitsGet1(vb) | 0;
            cur = (cur ^ v) - v;
        }

        prev = (cur + prev) | 0;
        outp[outOffset++] = prev;
    }

    // Rest of rows : predict from average of left + top
    for (let h = 0; h < encHeight - 1; h++) {
        outOffset += yadj;
        let from = outOffset - pixelPitch;

        // First pixel of row : predict from top
        let cur = arithDecompress(a, ab);
        if (arithWasEscaped(cur)) {
            const escaped = arithBitsGetValue(ab, num);
            arithSetDecompressed(cur, escaped, a);
            cur = escaped;
        }
        if (cur) {
            const v = -varBitsGet1(vb) | 0;
            cur = (cur ^ v) - v;
        }

        prev = (cur + outp[from]) | 0;
        outp[outOffset++] = prev;
        ++from;

        for (let w = 0; w < encWidth - 1; w++) {
            cur = arithDecompress(a, ab);
            if (arithWasEscaped(cur)) {
                const escaped = arithBitsGetValue(ab, num);
                arithSetDecompressed(cur, escaped, a);
                cur = escaped;
            }
            if (cur) {
                const v = -varBitsGet1(vb) | 0;
                cur = (cur ^ v) - v;
            }
            prev = (cur + (((prev + outp[from]) / 2) | 0)) | 0;
            outp[outOffset++] = prev;
            ++from;
        }
    }
}

function createDecompContexts(max, num, numl) {
    // encode.c:1576 — create_decomp_contexts. Allocate per-context arith
    // tables. Returns { contexts: Array<arith>, lits: arith, zeros: arith }.
    const contexts = new Array(numl);
    for (let i = 0; i < numl; i++) {
        contexts[i] = arithOpen(max, num);
    }
    const lits = arithOpen(LIT_LENGTH_LIMIT, LIT_LENGTH_LIMIT + 1);
    const zeros = arithOpen(ZERO_LENGTH_LIMIT, ZERO_LENGTH_LIMIT + 1);
    return { contexts, lits, zeros };
}

function radabs(v) { return v < 0 ? -v : v; }

function decodeHigh1(ab, vb, outp, outOffset, pixelPitch, encWidth, encHeight) {
    // encode.c:1611 — decode_high_1. High-pass plane with order-1
    // prediction.
    const qlevel = varBitsGet(vb, 16);

    if (varBitsGet1(vb)) {
        const v = s16(varBitsGet(vb, 16));
        fillRect(outp, outOffset, pixelPitch, encWidth, encHeight, (v * qlevel) | 0);
        return;
    }

    const max = varBitsGet(vb, 16);
    const num = max + 1;
    let numl = max * qlevel;
    numl = getBitLevel(numl) + 1;

    const { contexts: a, lits, zeros } = createDecompContexts(max, num, numl);

    const yadj = pixelPitch - encWidth;
    let h = encHeight;

    // First pixel raw
    let above = arithBitsGetValue(ab, num);
    if (above) {
        const v = -varBitsGet1(vb) | 0;
        above = (above ^ v) - v;
        above = (above * qlevel) | 0;
    }

    outp[outOffset] = above;
    let aboveLeft = above;
    let prev = above;
    let fromOffset = outOffset;
    ++outOffset;

    if (encWidth === 1) {
        // jump to after_first ; mirror via labeled-block trick
        return decodeHigh1AfterFirst(ab, vb, outp, outOffset, pixelPitch, encWidth, encHeight,
            a, lits, zeros, num, numl, qlevel, yadj, h, above, aboveLeft, prev, fromOffset);
    }

    let w = encWidth - 1;
    let litLen = 0;
    let zeroLen = 0;
    let idleIter = 0;

    outer: for (;;) {
        // Read lit_len
        let litLenRet = arithDecompress(lits, ab);
        if (arithWasEscaped(litLenRet)) {
            const escaped = varBitsGet(vb, LIT_LENGTH_BITS);
            arithSetDecompressed(litLenRet, escaped, lits);
            litLen = escaped;
        } else {
            litLen = litLenRet;
        }
        if (litLen >= (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
            litLen = EXTRA_LIT_LENGTHS[litLen - (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)];
        }

        // Read zero_len
        let zeroLenRet = arithDecompress(zeros, ab);
        if (arithWasEscaped(zeroLenRet)) {
            const escaped = varBitsGet(vb, ZERO_LENGTH_BITS);
            arithSetDecompressed(zeroLenRet, escaped, zeros);
            zeroLen = escaped;
        } else {
            zeroLen = zeroLenRet;
        }

        if (zeroLen >= (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
            zeroLen = EXTRA_ZERO_LENGTHS[zeroLen - (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)] + MIN_ZERO_LENGTH - 1;
        } else if (zeroLen) {
            zeroLen += MIN_ZERO_LENGTH - 1;
        }

        // Anti-hang : both lengths zero = neither inner while progresses h.
        // granny2.dll itself spins on the same off-corpus bitstream
        // (`1_attack.gr2` textures). 64 consecutive idle iters = throw.
        if (litLen === 0 && zeroLen === 0) {
            if (++idleIter > 64) {
                throw new Error(`decodeHigh1: stuck at h=${h} w=${w} after ${idleIter} consecutive arith reads with litLen=0/zeroLen=0 — bitstream likely off-corpus (granny2.dll hangs on the same input). Encoding=${encWidth}x${encHeight}.`);
            }
        } else {
            idleIter = 0;
        }

        // Decode literals
        while (litLen > 0) {
            if (w <= 1) {
                if (w) {
                    // Predict from prev + above_left + above (weighted).
                    // SDK computes `prev * 2` as S32 with wraparound on
                    // overflow (encode.c:1746) ; Math.imul mirrors that.
                    const __sum3 = (radabs(Math.imul(prev, 2)) + radabs(aboveLeft) + radabs(above)) >>> 0;
                    let context = (__sum3 / 4) >>> 0;
                    context = getBitLevel(context);
                    let cur = arithDecompress(a[context], ab);
                    if (arithWasEscaped(cur)) {
                        const escaped = arithBitsGetValue(ab, num);
                        arithSetDecompressed(cur, escaped, a[context]);
                        cur = escaped;
                    }
                    if (cur) {
                        const v = -varBitsGet1(vb) | 0;
                        cur = (cur ^ v) - v;
                        cur = (cur * qlevel) | 0;
                    }
                    outp[outOffset++] = cur;
                    --litLen;
                }

                // after_first label
                if (--h === 0) return;
                w = encWidth;
                outOffset += yadj;
                fromOffset = outOffset - pixelPitch;
                above = outp[fromOffset++];
                aboveLeft = above;
                prev = above;
            } else {
                const aboveRight = outp[fromOffset];
                const __sum4 = (radabs(prev) + radabs(aboveLeft) + radabs(above) + radabs(aboveRight)) >>> 0;
                let context = (__sum4 / 4) >>> 0;
                context = getBitLevel(context);
                let cur = arithDecompress(a[context], ab);
                if (arithWasEscaped(cur)) {
                    const escaped = arithBitsGetValue(ab, num);
                    arithSetDecompressed(cur, escaped, a[context]);
                    cur = escaped;
                }
                if (cur) {
                    const v = -varBitsGet1(vb) | 0;
                    cur = (cur ^ v) - v;
                    cur = (cur * qlevel) | 0;
                }
                outp[outOffset] = cur;

                aboveLeft = above;
                above = aboveRight;
                prev = cur;

                ++outOffset;
                ++fromOffset;
                --w;
                --litLen;
            }
        }

        // Decode zero runs
        while (zeroLen > 0) {
            if (zeroLen >= w) {
                zeroLen -= w;
                fromOffset += w;
                while (w-- > 0) {
                    outp[outOffset++] = 0;
                }
                if (--h === 0) return;
                w = encWidth;
                outOffset += yadj;
                fromOffset = outOffset - pixelPitch;
                above = outp[fromOffset++];
                aboveLeft = above;
                prev = above;
            } else {
                w -= zeroLen;
                fromOffset += zeroLen;
                do {
                    outp[outOffset++] = 0;
                } while (--zeroLen > 0);
                prev = 0;
                above = outp[fromOffset - 1];
                aboveLeft = outp[fromOffset - 2];
            }
        }
    }
}

function decodeHigh1AfterFirst(ab, vb, outp, outOffset, pixelPitch, encWidth, encHeight,
    a, lits, zeros, num, numl, qlevel, yadj, hIn, aboveIn, aboveLeftIn, prevIn, fromOffsetIn) {
    // Continuation when encWidth === 1 — start at the "after_first" label.
    let h = hIn;
    let above = aboveIn;
    let aboveLeft = aboveLeftIn;
    let prev = prevIn;
    let fromOffset = fromOffsetIn;

    // after_first label
    if (--h === 0) return;
    let w = encWidth;
    outOffset += yadj;
    fromOffset = outOffset - pixelPitch;
    above = outp[fromOffset++];
    aboveLeft = above;
    prev = above;

    let litLen = 0;
    let zeroLen = 0;
    let idleIter = 0;

    for (;;) {
        let litLenRet = arithDecompress(lits, ab);
        if (arithWasEscaped(litLenRet)) {
            const escaped = varBitsGet(vb, LIT_LENGTH_BITS);
            arithSetDecompressed(litLenRet, escaped, lits);
            litLen = escaped;
        } else {
            litLen = litLenRet;
        }
        if (litLen >= (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
            litLen = EXTRA_LIT_LENGTHS[litLen - (LIT_LENGTH_LIMIT - EXTRA_LENGTHS + 1)];
        }

        let zeroLenRet = arithDecompress(zeros, ab);
        if (arithWasEscaped(zeroLenRet)) {
            const escaped = varBitsGet(vb, ZERO_LENGTH_BITS);
            arithSetDecompressed(zeroLenRet, escaped, zeros);
            zeroLen = escaped;
        } else {
            zeroLen = zeroLenRet;
        }
        if (zeroLen >= (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)) {
            zeroLen = EXTRA_ZERO_LENGTHS[zeroLen - (ZERO_LENGTH_LIMIT - EXTRA_LENGTHS + 1)] + MIN_ZERO_LENGTH - 1;
        } else if (zeroLen) {
            zeroLen += MIN_ZERO_LENGTH - 1;
        }

        if (litLen === 0 && zeroLen === 0) {
            if (++idleIter > 64) {
                throw new Error(`decodeHigh1AfterFirst: stuck at h=${h} w=${w} after ${idleIter} consecutive arith reads with litLen=0/zeroLen=0 — bitstream likely off-corpus. Encoding=${encWidth}x${encHeight}.`);
            }
        } else {
            idleIter = 0;
        }

        while (litLen > 0) {
            if (w <= 1) {
                if (w) {
                    let context = ((radabs(prev * 2) + radabs(aboveLeft) + radabs(above)) | 0) / 4 | 0;
                    context = getBitLevel(context);
                    let cur = arithDecompress(a[context], ab);
                    if (arithWasEscaped(cur)) {
                        const escaped = arithBitsGetValue(ab, num);
                        arithSetDecompressed(cur, escaped, a[context]);
                        cur = escaped;
                    }
                    if (cur) {
                        const v = -varBitsGet1(vb) | 0;
                        cur = (cur ^ v) - v;
                        cur = (cur * qlevel) | 0;
                    }
                    outp[outOffset++] = cur;
                    --litLen;
                }
                if (--h === 0) return;
                w = encWidth;
                outOffset += yadj;
                fromOffset = outOffset - pixelPitch;
                above = outp[fromOffset++];
                aboveLeft = above;
                prev = above;
            } else {
                const aboveRight = outp[fromOffset];
                const __sum4 = (radabs(prev) + radabs(aboveLeft) + radabs(above) + radabs(aboveRight)) >>> 0;
                let context = (__sum4 / 4) >>> 0;
                context = getBitLevel(context);
                let cur = arithDecompress(a[context], ab);
                if (arithWasEscaped(cur)) {
                    const escaped = arithBitsGetValue(ab, num);
                    arithSetDecompressed(cur, escaped, a[context]);
                    cur = escaped;
                }
                if (cur) {
                    const v = -varBitsGet1(vb) | 0;
                    cur = (cur ^ v) - v;
                    cur = (cur * qlevel) | 0;
                }
                outp[outOffset] = cur;
                aboveLeft = above;
                above = aboveRight;
                prev = cur;
                ++outOffset;
                ++fromOffset;
                --w;
                --litLen;
            }
        }

        while (zeroLen > 0) {
            if (zeroLen >= w) {
                zeroLen -= w;
                fromOffset += w;
                while (w-- > 0) outp[outOffset++] = 0;
                if (--h === 0) return;
                w = encWidth;
                outOffset += yadj;
                fromOffset = outOffset - pixelPitch;
                above = outp[fromOffset++];
                aboveLeft = above;
                prev = above;
            } else {
                w -= zeroLen;
                fromOffset += zeroLen;
                do {
                    outp[outOffset++] = 0;
                } while (--zeroLen > 0);
                prev = 0;
                above = outp[fromOffset - 1];
                aboveLeft = outp[fromOffset - 2];
            }
        }
    }
}

function planeDecode(buf, srcOffset, output, outOffset, width, height, rowMask) {
    // encode.c:1884 — plane_decode. Decodes the variable-length encoded
    // sub-band representation into the S16 `output` plane.
    // Layout per IGC-FORMAT.md § 3 :
    //   buf[srcOffset..+4]   : arith stream length (U32 LE)
    //   buf[srcOffset+4..+8] : varbits stream length (U32 LE)
    //   buf[srcOffset+8..]   : arith stream (length = arith_len)
    //   buf[after that..]    : varbits stream (length = varbits_len)
    // Returns bytes consumed from buf.

    const arithLen = varBitsReadU32LE(buf, srcOffset);
    const varbitsStart = srcOffset + 8 + arithLen;

    const ab = arithBitOpen(buf, srcOffset + 8);
    const vb = varBitsOpen(buf, varbitsStart);

    // 4-level sub-band traversal.
    //
    // SDK signature note : `decode_low`/`decode_high_1` take `pixel_pitch`
    // in **S16 elements** (not bytes). `outp` is `S16 *`, so `outp += yadj`
    // advances by S16 elements. Confirmed by encode.c:1444 :
    //   yadj = pixel_pitch - (S32)enc_width;
    //   outp += yadj;   // outp is S16*, so adds yadj S16 elements
    //
    // SDK calls (encode.c:1908-1924) pass :
    //   level 3 : pitch = width * 16 S16 elements (= 16 buffer-row stride
    //                                                between sub-band rows)
    //   level 2 : pitch = width * 8
    //   level 1 : pitch = width * 4
    //   level 0 : pitch = width * 2
    //
    // Sub-band offsets within the plane (all in S16 elements) :
    //   LL3 : 0
    //   HL3 : W/16          LH3 : W*8           HH3 : W/16 + W*8
    //   HL2 : W/8           LH2 : W*4           HH2 : W/8  + W*4
    //   HL1 : W/4           LH1 : W*2           HH1 : W/4  + W*2
    //   HL0 : W/2           LH0 : W             HH0 : W/2  + W

    // Level 3 (innermost, W/16 x H/16)
    decodeLow  (ab, vb, output, outOffset,                          width * 16, width >> 4, height >> 4);
    decodeHigh1(ab, vb, output, outOffset + (width >> 4),           width * 16, width >> 4, height >> 4);
    decodeHigh1(ab, vb, output, outOffset + (width * 8),            width * 16, width >> 4, height >> 4);
    decodeHigh1(ab, vb, output, outOffset + (width >> 4) + (width * 8), width * 16, width >> 4, height >> 4);

    // Level 2 (W/8 x H/8)
    decodeHigh1(ab, vb, output, outOffset + (width >> 3),           width * 8,  width >> 3, height >> 3);
    decodeHigh1(ab, vb, output, outOffset + (width * 4),            width * 8,  width >> 3, height >> 3);
    decodeHigh1(ab, vb, output, outOffset + (width >> 3) + (width * 4), width * 8, width >> 3, height >> 3);

    // Level 1 (W/4 x H/4)
    decodeHigh1(ab, vb, output, outOffset + (width >> 2),           width * 4,  width >> 2, height >> 2);
    decodeHigh1(ab, vb, output, outOffset + (width * 2),            width * 4,  width >> 2, height >> 2);
    decodeHigh1(ab, vb, output, outOffset + (width >> 2) + (width * 2), width * 4, width >> 2, height >> 2);

    // Level 0 (W/2 x H/2)
    decodeHigh1(ab, vb, output, outOffset + (width >> 1),           width * 2,  width >> 1, height >> 1);
    decodeHigh1(ab, vb, output, outOffset + width,                  width * 2,  width >> 1, height >> 1);
    decodeHigh1(ab, vb, output, outOffset + (width >> 1) + width,   width * 2,  width >> 1, height >> 1);

    if (rowMask) {
        readEscapes(ab, rowMask, height);
    }

    const varbitsLen = varBitsReadU32LE(buf, srcOffset + 4);
    return arithLen + varbitsLen + 8;
}

// ============================================================================
// Public API.

// `_GrannyDecompressIGCTexture@12` clean-room port.
// Asm cite : `granny2.dll @ 0x100045b0` (`FromBinkTC`).
export function decodeIGCTexture(igcImage) {
    const { Width: width, Height: height, Alpha: alpha, ImageData: src } = igcImage;

    // Small-image fallback : granny2.dll @ fcn.10009c30 returns false when
    // `width * height <= 256` (asm `imul edx, ecx, eax ; cmp edx, 0x100 ; jle`).
    // The IGC dispatcher at fcn.10009e50 then bypasses BinkTC and hands the
    // pixelBytes to ConvertPixelFormat — which is the identity for the
    // (source RGBA8888 → dest RGBA8888) layout pair the dispatcher selects
    // here (data.1002a228, alpha=1). Verified : the wine-baked golden for
    // guildflag90_1.gr2:tex[1] (16×16) is byte-identical to its input
    // pixelBytes, so the codec writes them through unchanged.
    if (width * height <= 256) {
        const expected = width * height * 4;
        if (src.byteLength < expected) {
            throw new Error(
                `decodeIGCTexture: small-image fallback expects ${expected} ` +
                `RGBA bytes, got ${src.byteLength} (W=${width}, H=${height})`
            );
        }
        return new Uint8Array(src.buffer, src.byteOffset, expected).slice();
    }

    if (width < SMALLEST_DWT_ROW || height < SMALLEST_DWT_COL ||
        (width & 15) !== 0 || (height & 15) !== 0) {
        throw new Error(
            `decodeIGCTexture: shouldBink fallback not supported (W=${width}, ` +
            `H=${height}). iRO corpus walker should filter these out.`
        );
    }

    const planeCount = alpha ? 4 : 3;
    const planes = new Array(4);
    for (let i = 0; i < 4; i++) planes[i] = new Int16Array(width * height);

    const rowMask = new Uint8Array(height);
    const temp = new Int16Array(width * height);

    let cursor = 4;
    for (let p = 0; p < planeCount; p++) {
        const consumed = planeDecode(src, cursor, planes[p], 0, width, height,
            (p === 0) ? rowMask : null);
        cursor += consumed;

        iDWT2D(planes[p], width * 8, width >> 3, height >> 3, null, temp);
        iDWT2D(planes[p], width * 4, width >> 2, height >> 2, null, temp);
        iDWT2D(planes[p], width * 2, width >> 1, height >> 1, null, temp);
        iDWT2D(planes[p], width, width, height, (p === 0) ? rowMask : null, temp);
    }

    if (!alpha) {
        for (let i = 0; i < width * height; i++) planes[3][i] = 255;
    }

    return yuvToRGB(planes[0], planes[1], planes[2], planes[3], width, height);
}

export function yuvToRGB(yp, up, vp, ap, width, height) {
    const count = width * height;
    const out = new Uint8Array(count * 4);
    let o = 0;
    for (let i = 0; i < count; i++) {
        let r = up[i] + PLANE_VALUE_OFFSET;
        let g = yp[i] + PLANE_VALUE_OFFSET;
        let b = vp[i] + PLANE_VALUE_OFFSET;
        let a = ap[i];

        // Round-toward-zero integer divide by 4. Asm cite :
        // `granny2.dll @ 0x10009aa0-0x10009aac` — `cdq ; and edx,3 ; add eax,edx ;
        // sar eax,2` is the canonical signed-divide-by-4 idiom, NOT a plain
        // `sar` (which would be floor-toward -∞). JS `>>` is arith right shift
        // and diverges by 1 on negative (r+b) that aren't multiples of 4.
        g -= ((r + b) / 4) | 0;
        r += g;
        b += g;

        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;
        if (a < 0) a = 0; else if (a > 255) a = 255;

        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
        o += 4;
    }
    return out;
}