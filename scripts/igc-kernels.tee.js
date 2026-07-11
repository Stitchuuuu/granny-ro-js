// igc-kernels.tee.js — DEV-ONLY differential seam for the arith WASM-vs-JS gate.
//
// Swapped in for ./igc-kernels.js by scripts/replay-arith-wasm.mjs (rolldown
// resolveId). Every arith call runs BOTH the pure-JS oracle (../src/igc-arith.js)
// and the WASM coder (via the arith driver) on parallel state, and asserts the
// returned symbol + the per-call coder/model state are byte-identical — throwing
// at the first divergence with the call# and the diverging field. This is the
// finest-grained byte-exact gate (finer than the end-to-end RGBA sha).
//
// Handles are `{ js, w }` pairs, opaque to GrannyTextureIGC.js. NOT shipped.

import * as jsArith from '../src/igc-arith.js';
import { yuvToRGB } from '../src/igc-yuv.js';
import { createArithDriver } from '../src/wasm/arith-driver.js';
import KERNELS_WASM_B64 from '../src/wasm/kernels-b64.js';

export { yuvToRGB };
// GrannyTextureIGC imports planeDecode from the seam ; the arith gate drives it
// on the pure-JS oracle, whose per-symbol arith calls route back through this
// tee (the oracle imports arith from './igc-kernels.js' = this module) and get
// compared JS-vs-WASM. So the plane loop feeds the per-symbol arith gate.
export { planeDecode } from '../src/igc-plane.js';
export { iDWT2D } from '../src/igc-idwt.js';

let driver = null;
let callNo = 0;

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
    driver = createArithDriver(instance);
}

const hex = (v) => '0x' + (v >>> 0).toString(16);
function fail(site, field, jsv, wv) {
    throw new Error(`[tee] call #${callNo} ${site}: ${field} — js=${hex(jsv)} wasm=${hex(wv)}`);
}

function cmpCoder(site, abjs, abPtr) {
    const w = driver.readCoder(abPtr);
    if ((abjs.high >>> 0) !== w.high) fail(site, 'high', abjs.high, w.high);
    if ((abjs.low >>> 0) !== w.low) fail(site, 'low', abjs.low, w.low);
    if ((abjs.target >>> 0) !== w.target) fail(site, 'target', abjs.target, w.target);
    if ((abjs.ptr >>> 0) !== w.ptr) fail(site, 'ptr', abjs.ptr, w.ptr);
    if ((abjs.accum >>> 0) !== w.accum) fail(site, 'accum', abjs.accum, w.accum);
    if ((abjs.bitsLeft | 0) !== w.bitsLeft) fail(site, 'bitsLeft', abjs.bitsLeft, w.bitsLeft);
}

function cmpModel(site, ajs, aPtr) {
    const w = driver.readModel(aPtr);
    for (let k = 0; k < 16; k++) {
        if (ajs.cumCounts[k] !== w.cumCounts[k]) fail(site, `cum[${k}]`, ajs.cumCounts[k], w.cumCounts[k]);
    }
    if (ajs.singlesLength !== w.singlesLength) fail(site, 'singlesLength', ajs.singlesLength, w.singlesLength);
    if (ajs.bandBoundary !== w.bandBoundary) fail(site, 'bandBoundary', ajs.bandBoundary, w.bandBoundary);
    if (ajs.shiftDepth !== w.shiftDepth) fail(site, 'shiftDepth', ajs.shiftDepth, w.shiftDepth);
    if (ajs.bucketSize !== w.bucketSize) fail(site, 'bucketSize', ajs.bucketSize, w.bucketSize);
    if (ajs.uniqueCount !== w.uniqueCount) fail(site, 'uniqueCount', ajs.uniqueCount, w.uniqueCount);
}

export function arithBitOpen(buf, offset) {
    const js = jsArith.arithBitOpen(buf, offset);
    const w = driver.bitOpen(buf, offset);
    cmpCoder('bitOpen', js, w);
    return { js, w };
}

export function arithOpen(max, num) {
    const js = jsArith.arithOpen(max, num);
    const w = driver.open(num);
    cmpModel('open', js, w);
    return { js, w, _wret: 0 };
}

export function arithDecompress(h, abh) {
    callNo++;
    const jsRet = jsArith.arithDecompress(h.js, abh.js);
    const wRet = driver.decompress(h.w, abh.w);
    h._wret = wRet;

    const jsEsc = jsArith.arithWasEscaped(jsRet);
    const wEsc = wRet < 0;
    if (jsEsc !== wEsc) fail('decompress', 'escape?', jsEsc | 0, wEsc | 0);
    if (!jsEsc && (jsRet | 0) !== wRet) fail('decompress', 'value', jsRet, wRet);
    if (jsEsc && jsRet.slot !== -wRet - 1) fail('decompress', 'escapeSlot', jsRet.slot, -wRet - 1);

    cmpCoder('decompress', abh.js, abh.w);
    cmpModel('decompress', h.js, h.w);
    return jsRet;
}

export function arithWasEscaped(cur) {
    return jsArith.arithWasEscaped(cur);
}

export function arithSetDecompressed(cur, escaped, h) {
    jsArith.arithSetDecompressed(cur, escaped, h.js);
    driver.setDecompressed(h.w, -h._wret - 1, escaped);
}

export function arithBitsGetValue(abh, scale) {
    const js = jsArith.arithBitsGetValue(abh.js, scale);
    const w = driver.bitsGetValue(abh.w, scale);
    if ((js | 0) !== w) fail('bitsGetValue', 'value', js, w);
    cmpCoder('bitsGetValue', abh.js, abh.w);
    return js;
}

export function arithBitsGet(abh, scale) {
    const js = jsArith.arithBitsGet(abh.js, scale);
    const w = driver.bitsGet(abh.w, scale);
    if ((js | 0) !== w) fail('bitsGet', 'value', js, w);
    cmpCoder('bitsGet', abh.js, abh.w);
    return js;
}

export function arithBitsRemove(abh, lo, count, scale) {
    jsArith.arithBitsRemove(abh.js, lo, count, scale);
    driver.bitsRemove(abh.w, lo, count, scale);
    cmpCoder('bitsRemove', abh.js, abh.w);
}
