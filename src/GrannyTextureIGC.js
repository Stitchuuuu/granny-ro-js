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
// Most kernels are private (file-local). `yuvToRGB` lives behind a swappable
// seam (./igc-kernels.js) so the opt-in WASM build can dispatch it to a
// WebAssembly module ; the pure-JS implementation stays in ./igc-yuv.js as the
// mandatory fallback + byte-exact oracle. Public exports : `decodeIGCTexture`,
// `yuvToRGB` (re-exported from the seam).
import {
    yuvToRGB,
    arithBitOpen,
    arithOpen,
    arithDecompress,
    arithWasEscaped,
    arithSetDecompressed,
    arithBitsGetValue,
    arithBitsGet,
    arithBitsRemove,
} from './igc-kernels.js';

const SMALLEST_DWT_ROW = 16;
const SMALLEST_DWT_COL = 16;
const FLIPSIZE = 8;

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
//
// These types are internal to the codec : `decodeIGCTexture` / `yuvToRGB` are
// not re-exported from the package's main entry. External callers use
// `extractTextures` from `./GrannyTexture.js`, which calls `decodeIGCTexture`.

/**
 * Input to {@link decodeIGCTexture}.
 *
 * @typedef {object} IGCImage
 * @property {number} Width — image width in pixels (from the `GrannyIGCTexture` reflection struct).
 * @property {number} Height — image height in pixels.
 * @property {0 | 1} Alpha — alpha flag (`1` = `BinkEncodeAlpha`, `0` = no A plane in the bitstream).
 * @property {Uint8Array} ImageData — the IGC bitstream as stored in the .gr2 `Pixels` array (see IGC-FORMAT.md § 3).
 */

/**
 * Decode one IGC texture (RAD BinkTC : wavelet + arithmetic + YUV→RGB) to
 * RGBA8888. Clean-room port of `_GrannyDecompressIGCTexture@12`.
 *
 * Images with `Width * Height <= 256` take the small-image passthrough
 * (granny2.dll bypasses BinkTC and copies the RGBA bytes through unchanged) ;
 * larger images run the full plane-decode → 4-level inverse DWT → YUV→RGB
 * pipeline. Non-16-aligned dimensions are rejected — the iRO corpus walker
 * filters those out upstream.
 *
 * @param {IGCImage} igcImage
 * @returns {Uint8Array} RGBA8888 bytes, length = `Width * Height * 4`.
 * @throws {Error} when a small-image input carries fewer than `Width*Height*4`
 *   bytes, or when the dimensions are not 16-aligned (unsupported fallback).
 */
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

// `yuvToRGB` is re-exported from the kernel seam (default = ./igc-yuv.js pure
// JS ; the WASM build swaps the seam for ./igc-kernels.wasm.js). The unit
// suite imports it from here to validate the kernel on synthetic planes.
export { yuvToRGB };