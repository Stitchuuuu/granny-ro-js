// igc-kernels.wasm.js — WASM IGC kernel seam (the opt-in `./wasm` build).
//
// Swapped in for ./igc-kernels.js by scripts/build-dist.mjs stage 6. Holds the
// singleton WebAssembly instance + scratch base, instantiates it from the
// inlined base64 (./wasm/kernels-b64.js) in `initKernels()` — awaited via
// `Granny.ready()` before the first decode — and dispatches each kernel to the
// wasm module, falling back to the pure-JS implementation (./igc-yuv.js) when
// the module has not instantiated. The JS fallback is mandatory : if
// instantiation is skipped or fails, decode still produces byte-exact pixels.
//
// Session 1 wires only yuvToRGB. Sessions 2-4 add arith / planeDecode / iDWT
// against the same instance + linear-memory scratch base.

import { yuvToRGB as yuvJS } from './igc-yuv.js';
import KERNELS_WASM_B64 from './wasm/kernels-b64.js';

/**
 * Exports of kernels.wasm (the linear-memory ABI). Sessions 2-4 extend this
 * with the arith / planeDecode / iDWT kernels against the same `memory`.
 *
 * @typedef {object} KernelExports
 * @property {WebAssembly.Memory} memory — the shared linear memory.
 * @property {() => number} scratchBase — first byte free of AS static data.
 * @property {(planesPtr: number, count: number, rgbaPtr: number) => void} yuvToRGB
 */

/** @type {KernelExports | null} — kernel exports once instantiated. */
let wasm = null;
/** First linear-memory byte free of AS static data (from `scratchBase()`). */
let base = 0;

/** Decode a base64 string to bytes (global `atob` : Node ≥ 16 + browsers). */
function b64ToBytes(b64) {
    const bin = atob(b64);
    const n = bin.length;
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

/**
 * Instantiate the kernel wasm module (idempotent). Awaited via
 * `Granny.ready()` before the first decode ; browser main-thread
 * `WebAssembly.instantiate` is async and the sync form is capped at 4 KB, so
 * this must be awaited, not resolved synchronously.
 *
 * @returns {Promise<void>}
 */
export async function initKernels() {
    if (wasm) return;
    const { instance } = await WebAssembly.instantiate(b64ToBytes(KERNELS_WASM_B64), {});
    wasm = /** @type {KernelExports} */ (/** @type {unknown} */ (instance.exports));
    base = wasm.scratchBase() >>> 0;
}

/** Grow `memory` so `[base, base+bytes)` is addressable ; returns the buffer. */
function ensure(memory, bytes) {
    const end = base + bytes;
    const have = memory.buffer.byteLength;
    if (have < end) memory.grow(Math.ceil((end - have) / 65536));
    return memory.buffer;
}

/**
 * YUV-ish → RGBA8888 — WASM when instantiated, else the JS oracle (fallback).
 * Signature identical to {@link yuvJS} so `decodeIGCTexture`'s call site is
 * build-agnostic.
 *
 * @param {Int16Array} yp @param {Int16Array} up @param {Int16Array} vp @param {Int16Array} ap
 * @param {number} width @param {number} height
 * @returns {Uint8Array}
 */
export function yuvToRGB(yp, up, vp, ap, width, height) {
    if (!wasm) return yuvJS(yp, up, vp, ap, width, height);

    const count = width * height;
    const planeBytes = count * 8; // 4 planes × count × i16
    const rgbaPtr = base + planeBytes;
    const buf = ensure(wasm.memory, planeBytes + count * 4);

    // Planes written contiguously (Y, U, V, A) from `base` per the ABI.
    const planes = new Int16Array(buf, base, count * 4);
    planes.set(yp, 0);
    planes.set(up, count);
    planes.set(vp, count * 2);
    planes.set(ap, count * 3);

    wasm.yuvToRGB(base, count, rgbaPtr);

    // Copy out : the next decode reuses the same scratch region.
    return new Uint8Array(buf, rgbaPtr, count * 4).slice();
}
