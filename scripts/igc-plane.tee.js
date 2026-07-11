// igc-plane.tee.js — DEV-ONLY differential seam for the planeDecode WASM-vs-JS gate.
//
// Swapped in for ./igc-kernels.js by scripts/replay-plane-wasm.mjs (rolldown
// resolveId). Every `planeDecode` call runs BOTH the pure-JS oracle
// (../src/igc-plane.js, driven by the pure-JS arith re-exported below) and the
// WASM plane driver on the same (src, srcOffset), then asserts the full w·h S16
// plane + rowMask + consumed-bytes are byte-identical — throwing at the first
// diverging (plane#, offset). This is finer than the end-to-end RGBA sha : a
// prediction/renorm bug surfaces at the diverging pixel, before iDWT + yuv.
//
// The arith functions here are the pure-JS oracle (so the JS planeDecode runs
// on JS arith) ; the WASM path is exercised only through the plane driver. NOT
// shipped.

import * as jsPlane from '../src/igc-plane.js';
import { yuvToRGB } from '../src/igc-yuv.js';
import { iDWT2D } from '../src/igc-idwt.js';
import { runIGCPipeline } from '../src/igc-pipeline.js';
import { createPlaneDriver } from '../src/wasm/plane-driver.js';
import KERNELS_WASM_B64 from '../src/wasm/kernels-b64.js';

// The JS plane oracle's arith calls resolve to './igc-kernels.js' = this module,
// so re-export the pure-JS arith + yuv to make decode complete on the JS side.
export { yuvToRGB };
export { iDWT2D };
export {
    arithBitOpen,
    arithOpen,
    arithDecompress,
    arithWasEscaped,
    arithSetDecompressed,
    arithBitsGetValue,
    arithBitsGet,
    arithBitsRemove,
} from '../src/igc-arith.js';

let driver = null;
let planeNo = 0;

function b64ToBytes(b64) {
    const bin = atob(b64);
    const n = bin.length;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

export async function initKernels() {
    if (driver) return;
    const { instance } = await WebAssembly.instantiate(b64ToBytes(KERNELS_WASM_B64), {});
    driver = createPlaneDriver(instance);
}

export function planeDecode(src, srcOffset, output, outOffset, width, height, rowMask) {
    const idx = planeNo++;

    // JS oracle into `output` (the real result used downstream).
    const jsConsumed = jsPlane.planeDecode(src, srcOffset, output, outOffset, width, height, rowMask);

    // WASM into a fresh buffer for comparison.
    const w = driver.planeDecode(src, srcOffset, width, height, rowMask != null);

    if (jsConsumed !== w.consumed) {
        throw new Error(`[plane-tee] plane #${idx} (${width}x${height}): consumed js=${jsConsumed} wasm=${w.consumed}`);
    }

    const count = width * height;
    for (let i = 0; i < count; i++) {
        const jv = output[outOffset + i];
        const wv = w.plane[i];
        if (jv !== wv) {
            throw new Error(`[plane-tee] plane #${idx} (${width}x${height}): S16 diverges at offset ${i} — js=${jv} wasm=${wv}`);
        }
    }

    if (rowMask) {
        for (let i = 0; i < height; i++) {
            if (rowMask[i] !== w.mask[i]) {
                throw new Error(`[plane-tee] plane #${idx} (${width}x${height}): rowMask diverges at row ${i} — js=${rowMask[i]} wasm=${w.mask[i]}`);
            }
        }
    }

    return jsConsumed;
}

/** Drive the real pipeline on the tee-wrapped planeDecode (JS-vs-WASM per plane). */
export function decodeIGCPipeline(src, width, height, alpha) {
    return runIGCPipeline(src, width, height, alpha, planeDecode, iDWT2D, yuvToRGB);
}
