// arith-driver.js — JS-side driver for the WASM arith kernels.
//
// Owns the linear-memory scratch allocation (JS owns all pointers per the ABI)
// and exposes the arith coder/model as pointer-taking ops. Used by two callers:
//   - src/igc-kernels.wasm.js  — the production dual-dispatch seam.
//   - scripts/replay-arith-wasm.mjs — the per-symbol WASM-vs-JS differential gate.
//
// Block layout (mirrors src/wasm/kernels.ts) :
//   coder (ab) : 28 bytes { bufPtr, ptr, accum, bitsLeft, high, low, target }
//   model (a)  : 44-byte header (cumCounts[16] + singlesLength/bandBoundary/
//                shiftDepth/bucketSize/uniqueCount) + singleCounts[countsSize] +
//                values[countsSize], countsSize = ((uniqueValues+5)&~3).
//
// Per-plane the cursor resets to `base` on `bitOpen` : the coder + models of a
// finished plane are dead once the next plane's bitstream opens.

/** Zero-pad after the copied bitstream so the coder's read-past-end sees 0
 *  (matching the JS oracle's out-of-bounds `buf[oob] → undefined → 0`). */
const BUF_PAD = 32;

const AB_SIZE = 28;
const A_HEADER = 44;

/**
 * @typedef {object} ArithExports
 * @property {WebAssembly.Memory} memory
 * @property {() => number} scratchBase
 * @property {(abPtr: number, bufPtr: number, offset: number) => void} arithBitOpen
 * @property {(aPtr: number, uniqueValues: number) => number} arithOpen
 * @property {(aPtr: number, abPtr: number) => number} arithDecompress
 * @property {(aPtr: number, slot: number, value: number) => void} arithSetDecompressed
 * @property {(abPtr: number, scale: number) => number} arithBitsGetValue
 * @property {(abPtr: number, scale: number) => number} arithBitsGet
 * @property {(abPtr: number, lo: number, count: number, scale: number) => void} arithBitsRemove
 */

/**
 * Build an arith driver over an instantiated kernels.wasm.
 * @param {WebAssembly.Instance} instance
 */
export function createArithDriver(instance) {
    const ex = /** @type {ArithExports} */ (/** @type {unknown} */ (instance.exports));
    const mem = ex.memory;
    const base = ex.scratchBase() >>> 0;

    let cursor = base;
    let lastBuffer = null;
    /** @type {Uint8Array} */ let u8;
    /** @type {DataView} */ let dv;

    function refresh() {
        if (mem.buffer !== lastBuffer) {
            lastBuffer = mem.buffer;
            u8 = new Uint8Array(mem.buffer);
            dv = new DataView(mem.buffer);
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
        /** Open the range coder on a fresh plane bitstream. Resets the cursor.
         * @param {Uint8Array} srcBuf @param {number} offset @returns {number} abPtr */
        bitOpen(srcBuf, offset) {
            const len = srcBuf.length;
            cursor = base;
            const bufPtr = cursor;
            ensure(bufPtr + len + BUF_PAD);
            u8.set(srcBuf, bufPtr);
            u8.fill(0, bufPtr + len, bufPtr + len + BUF_PAD);
            cursor = align4(bufPtr + len + BUF_PAD);

            const abPtr = cursor;
            ensure(abPtr + AB_SIZE);
            cursor = abPtr + AB_SIZE;
            ex.arithBitOpen(abPtr, bufPtr, offset | 0);
            return abPtr;
        },
        /** Allocate + init a model block. @param {number} uniqueValues @returns {number} aPtr */
        open(uniqueValues) {
            const countsSize = (uniqueValues + 5) & ~3;
            const blockSize = A_HEADER + countsSize * 4;
            const aPtr = cursor;
            ensure(aPtr + blockSize);
            cursor = aPtr + blockSize;
            const got = ex.arithOpen(aPtr, uniqueValues | 0);
            if (got !== blockSize) {
                throw new Error(`arith-driver: arithOpen size mismatch ${got} !== ${blockSize} (uniqueValues=${uniqueValues})`);
            }
            return aPtr;
        },
        decompress(aPtr, abPtr) { return ex.arithDecompress(aPtr, abPtr) | 0; },
        setDecompressed(aPtr, slot, value) { ex.arithSetDecompressed(aPtr, slot | 0, value | 0); },
        bitsGetValue(abPtr, scale) { return ex.arithBitsGetValue(abPtr, scale | 0) | 0; },
        bitsGet(abPtr, scale) { return ex.arithBitsGet(abPtr, scale | 0) | 0; },
        bitsRemove(abPtr, lo, count, scale) { ex.arithBitsRemove(abPtr, lo | 0, count | 0, scale | 0); },

        /** Read the coder state (for the differential gate). @param {number} abPtr */
        readCoder(abPtr) {
            refresh();
            return {
                ptr: dv.getUint32(abPtr + 4, true),
                accum: dv.getUint32(abPtr + 8, true),
                bitsLeft: dv.getInt32(abPtr + 12, true),
                high: dv.getUint32(abPtr + 16, true),
                low: dv.getUint32(abPtr + 20, true),
                target: dv.getUint32(abPtr + 24, true),
            };
        },
        /** Read the model state (for the differential gate). @param {number} aPtr */
        readModel(aPtr) {
            refresh();
            const cumCounts = new Array(16);
            for (let k = 0; k < 16; k++) cumCounts[k] = dv.getUint16(aPtr + k * 2, true);
            return {
                cumCounts,
                singlesLength: dv.getUint16(aPtr + 32, true),
                bandBoundary: dv.getUint16(aPtr + 34, true),
                shiftDepth: dv.getUint16(aPtr + 36, true),
                bucketSize: dv.getUint16(aPtr + 38, true),
                uniqueCount: dv.getUint16(aPtr + 40, true),
            };
        },
    };
}
