// idwt-driver.js — JS-side driver for the WASM iDWT2D kernel.
//
// Owns the linear-memory layout for one inverse-wavelet pass (JS owns all
// pointers per the ABI) and invokes the single `iDWT2D` wasm entry. Used by:
//   - src/igc-kernels.wasm.js   — the production dual-dispatch seam.
//   - scripts/igc-idwt.tee.js    — the WASM-vs-JS iDWT differential gate.
//
// Layout per call (from `scratchBase()`) :
//   outPtr     = base                       the S16 plane, in-place (count i16)
//   <guard>    = GUARD_I16 zeroed i16        past-plane reads → 0 (see below)
//   tempPtr    = align4(outPtr + count*2 + guard)   scratch plane (count i16)
//   <guard>    = GUARD_I16 zeroed i16
//   rowMaskPtr = align4(tempPtr + count*2 + guard)  height bytes (0 when null)
//
// `count` = the full plane length (output.length) — every pass keeps the same
// backing buffer, indexing the sub-band via `pitch`. The ring pools are static
// in kernels.ts, so the kernel does NOT grow memory (unlike planeDecode) : the
// driver grows once up front and the pre-call views stay valid.
//
// The kernel's src reads are fold-bounded within the plane, but the two trailing
// guards zero any past-plane read defensively (== the JS oracle's `buf[oob] → 0`)
// and keep such a read from aliasing the next region. `tempPtr` is scratch —
// not copied in (the row pass writes it before the col pass reads it), only its
// guard is zeroed.

/** Zeroed i16 slots after each plane so a past-plane read yields 0. */
const GUARD_I16 = 8;

/**
 * @typedef {object} IdwtExports
 * @property {WebAssembly.Memory} memory
 * @property {() => number} scratchBase
 * @property {(outPtr: number, pitch: number, width: number, height: number, rowMaskPtr: number, tempPtr: number) => void} iDWT2D
 */

/**
 * Build an iDWT driver over an instantiated kernels.wasm.
 * @param {WebAssembly.Instance} instance
 */
export function createIdwtDriver(instance) {
    const ex = /** @type {IdwtExports} */ (/** @type {unknown} */ (instance.exports));
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
         * Inverse-wavelet-transform one plane in WASM, returning a fresh copy.
         * @param {Int16Array} output — the plane to transform (full length).
         * @param {number} pitch — S16-index row stride for this pass.
         * @param {number} width @param {number} height — sub-band dimensions.
         * @param {Uint8Array | null} rowMask — zero-row mask, or null.
         * @returns {Int16Array} the transformed plane (length = output.length).
         */
        iDWT2D(output, pitch, width, height, rowMask) {
            const count = output.length;
            const guardBytes = GUARD_I16 * 2;

            const outPtr = base;
            const tempPtr = align4(outPtr + count * 2 + guardBytes);
            const rowMaskPtr = align4(tempPtr + count * 2 + guardBytes);
            const maskLen = rowMask ? rowMask.length : 0;

            ensure(rowMaskPtr + maskLen);

            const outI16 = outPtr >> 1;
            const tempI16 = tempPtr >> 1;
            i16.set(output, outI16);
            // Zero the two trailing guards (kernel never writes them).
            i16.fill(0, outI16 + count, outI16 + count + GUARD_I16);
            i16.fill(0, tempI16 + count, tempI16 + count + GUARD_I16);
            if (rowMask) u8.set(rowMask, rowMaskPtr);

            ex.iDWT2D(outPtr, pitch, width, height, rowMask ? rowMaskPtr : 0, tempPtr);

            // The kernel does not grow memory : views from `ensure` stay valid.
            return i16.slice(outI16, outI16 + count);
        },
    };
}
