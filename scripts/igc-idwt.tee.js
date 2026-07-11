// igc-idwt.tee.js — DEV-ONLY differential seam for the iDWT2D WASM-vs-JS gate.
//
// Swapped in for ./igc-kernels.js by scripts/replay-idwt-wasm.mjs (rolldown
// resolveId). Every `iDWT2D` call runs BOTH the pure-JS oracle (../src/igc-idwt.js)
// into the real `output` + `temp` AND the WASM iDWT driver on a snapshot of the
// same input plane, then asserts the full-length transformed S16 plane is
// byte-identical — throwing at the first diverging (pass#, offset).
//
// `decodeIGCTexture` calls the seam `iDWT2D` once PER PASS (4× per plane at
// increasing resolution), so this compares per-pass automatically — a lifting /
// rounding / boundary bug surfaces at the diverging coefficient, before yuvToRGB.
//
// yuvToRGB, planeDecode and arith are re-exported as the pure-JS oracles so the
// rest of the decode (producing the S16 plane that feeds iDWT) runs on JS ; the
// WASM path is exercised only through the iDWT driver. NOT shipped.

import * as jsIdwt from '../src/igc-idwt.js';
import { yuvToRGB } from '../src/igc-yuv.js';
import { planeDecode } from '../src/igc-plane.js';
import { runIGCPipeline } from '../src/igc-pipeline.js';
import { createIdwtDriver } from '../src/wasm/idwt-driver.js';
import KERNELS_WASM_B64 from '../src/wasm/kernels-b64.js';

// The rest of the pipeline resolves its kernels to './igc-kernels.js' = this
// module, so re-export the pure-JS oracles to make decode complete on the JS side.
export { yuvToRGB };
export { planeDecode };
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
let passNo = 0;

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
    driver = createIdwtDriver(instance);
}

export function iDWT2D(output, pitch, width, height, rowMask, temp) {
    const idx = passNo++;

    // Snapshot the input BEFORE the JS oracle transforms `output` in place.
    const inputCopy = output.slice();

    // JS oracle into the real `output` (the result used downstream).
    jsIdwt.iDWT2D(output, pitch, width, height, rowMask, temp);

    // WASM driver on the untouched input (its own linear-memory scratch).
    const wasmPlane = driver.iDWT2D(inputCopy, pitch, width, height, rowMask);

    const count = output.length;
    for (let i = 0; i < count; i++) {
        if (output[i] !== wasmPlane[i]) {
            throw new Error(`[idwt-tee] pass #${idx} (${width}x${height} pitch=${pitch}): S16 diverges at offset ${i} — js=${output[i]} wasm=${wasmPlane[i]}`);
        }
    }
}

/** Drive the real pipeline on the tee-wrapped iDWT2D (JS-vs-WASM per pass). */
export function decodeIGCPipeline(src, width, height, alpha) {
    return runIGCPipeline(src, width, height, alpha, planeDecode, iDWT2D, yuvToRGB);
}
