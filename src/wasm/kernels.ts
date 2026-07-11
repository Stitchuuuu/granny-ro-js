// kernels.ts — AssemblyScript IGC decode kernels, compiled to kernels.wasm.
//
// Linear-memory ABI (the contract the rest of the granny-igc-wasm rollout
// extends). Compiled `--runtime stub` : there is NO in-wasm allocation — the
// JS caller owns every pointer. `scratchBase()` returns the first byte free of
// AS static data ; JS grows `memory`, writes inputs from that base, calls a
// kernel, reads outputs back. `grow` detaches the ArrayBuffer, so JS recreates
// its typed-array views per call.
//
// Session 1 ships only `yuvToRGB` (the walking skeleton). Sessions 2-4 add the
// arith coder / planeDecode / iDWT kernels against this same base + memory.

/** First linear-memory byte free of AS static data — the JS scratch base. */
export function scratchBase(): usize {
  return __heap_base;
}

/**
 * YUV-ish → RGBA8888 plane inversion. Byte-exact port of the JS `yuvToRGB`
 * (asm cite `granny2.dll @ 0x10009a30`).
 *
 * @param planesPtr - base of 4 contiguous S16 planes, each `count` elements :
 *   Y @ planesPtr, U @ +2*count, V @ +4*count, A @ +6*count (bytes).
 * @param count - width * height (pixel count).
 * @param rgbaPtr - output RGBA8888, `count * 4` bytes.
 */
export function yuvToRGB(planesPtr: usize, count: i32, rgbaPtr: usize): void {
  const c = <usize>count;
  const yP = planesPtr;
  const uP = planesPtr + (c << 1);
  const vP = planesPtr + (c << 2);
  const aP = planesPtr + c * 6;
  for (let i = 0; i < count; i++) {
    const off = (<usize>i) << 1;
    // load<i16> sign-extends the S16 plane value to i32 (PLANE_VALUE_OFFSET = 0).
    let r: i32 = <i32>load<i16>(uP + off);
    let g: i32 = <i32>load<i16>(yP + off);
    let b: i32 = <i32>load<i16>(vP + off);
    let a: i32 = <i32>load<i16>(aP + off);

    // i32 `/` is div_s = truncate-toward-zero = `(x/4)|0`, NOT an arith shift.
    g -= (r + b) / 4;
    r += g;
    b += g;

    r = r < 0 ? 0 : (r > 255 ? 255 : r);
    g = g < 0 ? 0 : (g > 255 ? 255 : g);
    b = b < 0 ? 0 : (b > 255 ? 255 : b);
    a = a < 0 ? 0 : (a > 255 ? 255 : a);

    const o: usize = rgbaPtr + ((<usize>i) << 2);
    store<u8>(o, <u8>r);
    store<u8>(o + 1, <u8>g);
    store<u8>(o + 2, <u8>b);
    store<u8>(o + 3, <u8>a);
  }
}
