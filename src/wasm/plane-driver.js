// plane-driver.js — JS-side driver for the WASM planeDecode kernel.
//
// Owns the linear-memory layout for one plane decode (JS owns all pointers per
// the ABI) and invokes the single `planeDecode` wasm entry. Used by two callers:
//   - src/igc-kernels.wasm.js       — the production dual-dispatch seam.
//   - scripts/igc-plane.tee.js      — the WASM-vs-JS plane differential gate.
//
// Layout per call (from `scratchBase()`) :
//   bufPtr    = base                 copy of src[srcOffset..end] + 32-byte pad
//   outPtr    = align4(bufPtr+len+32) the S16 output plane (width*height i16)
//   rowMaskPtr= outPtr + w*h*2        height bytes (0 when no mask)
//   workPtr   = align4(rowMaskPtr+h)  wasm bump-allocates coder + models here,
//                                     growing memory itself past this point.
// The whole src tail is copied (not just this plane) so the arith/varbits coders
// read the same bytes past their stream ends as the JS oracle does.

/** Zero-pad after the copied bitstream : the coders read a few bytes past the
 *  stream end (JS oracle sees `buf[oob] → undefined → 0`). */
const BUF_PAD = 32;

/**
 * @typedef {object} PlaneExports
 * @property {WebAssembly.Memory} memory
 * @property {() => number} scratchBase
 * @property {(bufPtr: number, srcOffset: number, outPtr: number, width: number, height: number, rowMaskPtr: number, workPtr: number) => number} planeDecode
 */

/**
 * Build a plane driver over an instantiated kernels.wasm.
 * @param {WebAssembly.Instance} instance
 */
export function createPlaneDriver(instance) {
    const ex = /** @type {PlaneExports} */ (/** @type {unknown} */ (instance.exports));
    const mem = ex.memory;
    const base = ex.scratchBase() >>> 0;

    let lastBuffer = null;
    /** @type {Uint8Array} */ let u8;
    /** @type {Int16Array} */ let i16;

    function refresh() {
        if (mem.buffer !== lastBuffer) {
            lastBuffer = mem.buffer;
            u8 = new Uint8Array(mem.buffer);
            i16 = new Int16Array(mem.buffer);
        }
    }
    function ensure(end) {
        const have = mem.buffer.byteLength;
        if (have < end) mem.grow(Math.ceil((end - have) / 65536));
        refresh();
    }
    const align4 = (x) => (x + 3) & ~3;

    refresh();

    return {
        /**
         * Decode one plane bitstream in WASM.
         * @param {Uint8Array} src — the IGC bitstream.
         * @param {number} srcOffset — byte offset of this plane within `src`.
         * @param {number} width @param {number} height
         * @param {boolean} wantMask — decode the zero-row mask (plane 0).
         * @returns {{ plane: Int16Array, mask: Uint8Array|null, consumed: number }}
         */
        planeDecode(src, srcOffset, width, height, wantMask) {
            const count = width * height;
            const tail = src.length - srcOffset;

            const bufPtr = base;
            const outPtr = align4(bufPtr + tail + BUF_PAD);
            const rowMaskPtr = outPtr + count * 2;
            const workPtr = align4(rowMaskPtr + height);

            // Grow for the fixed regions ; wasm grows further for coder + models.
            ensure(workPtr + 64);

            // Copy this plane + everything after it in src, then zero-pad.
            u8.set(src.subarray(srcOffset), bufPtr);
            u8.fill(0, bufPtr + tail, bufPtr + tail + BUF_PAD);
            // Zero the output plane for parity with a fresh `new Int16Array`.
            i16.fill(0, outPtr >> 1, (outPtr >> 1) + count);

            const consumed = ex.planeDecode(bufPtr, 0, outPtr, width, height,
                wantMask ? rowMaskPtr : 0, workPtr);

            if (consumed < 0) {
                throw new Error(
                    `planeDecode (wasm): decodeHigh1 anti-hang at plane offset ${srcOffset} ` +
                    `(${width}x${height}) — bitstream likely off-corpus (granny2.dll hangs on the same input).`
                );
            }

            // Memory may have grown in-wasm : recreate views before reading back.
            refresh();
            const plane = i16.slice(outPtr >> 1, (outPtr >> 1) + count);
            const mask = wantMask ? u8.slice(rowMaskPtr, rowMaskPtr + height) : null;
            return { plane, mask, consumed };
        },
    };
}
