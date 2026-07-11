// pipeline-driver.js — JS-side driver for the fused WASM `decodeIGCTexture`.
//
// Owns the linear-memory layout for a whole IGC texture decode (JS owns the
// outer pointers per the ABI) and invokes the single `decodeIGCTexture` wasm
// entry — one JS→WASM crossing per texture. The entry runs the per-plane loop
// (planeDecode + 4× iDWT2D + yuvToRGB) in-wasm, keeping each plane resident, and
// subdivides `workBase` itself (planes + temp + rowMask + planeDecode bump).
// Used by src/igc-kernels.wasm.js (the production dual-dispatch seam).
//
// Layout (from `scratchBase()`) :
//   bufPtr   = base                              the copied bitstream (src) + 32 pad
//   rgbaPtr  = align4(bufPtr + src.length + 32)  RGBA8888 output (count*4 bytes)
//   workBase = align4(rgbaPtr + count*4)         wasm-owned scratch (grows upward)
//
// `bufPtr` (src) sits below the planes and is read throughout decode ; `rgbaPtr`
// is written last (yuvToRGB) ; the fused entry's planeDecode grows memory past
// `workBase` via its in-wasm bump allocator, so JS refreshes its views after the
// call (grow detaches the ArrayBuffer).

/** Bytes zeroed past the bitstream so the coders' read-past-end yields 0. */
const BUF_PAD = 32;
/** i16 guard trailing the plane block + temp block (== kernels.ts GUARD). */
const GUARD_I16 = 8;

/**
 * @typedef {object} PipelineExports
 * @property {WebAssembly.Memory} memory
 * @property {() => number} scratchBase
 * @property {(bufPtr: number, width: number, height: number, alpha: number, rgbaPtr: number, workBase: number) => number} decodeIGCTexture
 */

/**
 * Build a fused-pipeline driver over an instantiated kernels.wasm.
 * @param {WebAssembly.Instance} instance
 */
export function createPipelineDriver(instance) {
    const ex = /** @type {PipelineExports} */ (/** @type {unknown} */ (instance.exports));
    const mem = ex.memory;
    const base = ex.scratchBase() >>> 0;

    let lastBuffer = null;
    /** @type {Uint8Array} */ let u8;

    function refresh() {
        if (mem.buffer !== lastBuffer) {
            lastBuffer = mem.buffer;
            u8 = new Uint8Array(mem.buffer);
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
         * Decode one IGC texture (compressed bytes → RGBA8888) fully in WASM.
         * @param {Uint8Array} src — the IGC bitstream.
         * @param {number} width @param {number} height — texture dimensions.
         * @param {0 | 1 | boolean} alpha — whether the bitstream carries an A plane.
         * @returns {Uint8Array} RGBA8888, length = width*height*4.
         */
        decode(src, width, height, alpha) {
            const count = width * height;
            const srcLen = src.length;

            const bufPtr = base;
            const rgbaPtr = align4(bufPtr + srcLen + BUF_PAD);
            const workBase = align4(rgbaPtr + count * 4);
            // Fixed scratch : planes (+guard) + temp (+guard) + rowMask ; the
            // fused entry's planeDecode grows memory past this for the coders.
            const fixedEnd = workBase + (count * 4 + GUARD_I16) * 2 + (count + GUARD_I16) * 2 + height + 64;
            ensure(fixedEnd);

            u8.set(src, bufPtr);
            u8.fill(0, bufPtr + srcLen, bufPtr + srcLen + BUF_PAD);

            const ret = ex.decodeIGCTexture(bufPtr, width, height, alpha ? 1 : 0, rgbaPtr, workBase);
            if (ret < 0) {
                throw new Error('decodeIGCTexture: planeDecode anti-hang (off-corpus bitstream)');
            }

            // planeDecode's bump allocator may have grown memory → views detached.
            refresh();
            return u8.slice(rgbaPtr, rgbaPtr + count * 4);
        },
    };
}
