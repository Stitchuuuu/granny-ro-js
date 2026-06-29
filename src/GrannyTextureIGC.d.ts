// Sibling .d.ts paired with GrannyTextureIGC.js.
//
// Internal codec : these types are NOT re-exported from the package's
// public surface (`index.d.ts` / `src/Granny.d.ts`). External callers
// should use `extractTextures` from `./GrannyTexture.js`, which calls
// `decodeIGCTexture` internally.

/** Input to {@link decodeIGCTexture}. */
export interface IGCImage {
    /** Image width in pixels (from the `GrannyIGCTexture` reflection struct). */
    readonly Width: number;
    /** Image height in pixels. */
    readonly Height: number;
    /** Alpha flag (`1` = `BinkEncodeAlpha`, `0` = no A plane in the bitstream). */
    readonly Alpha: 0 | 1;
    /** The IGC bitstream as stored in the .gr2 `Pixels` array (see IGC-FORMAT.md § 3). */
    readonly ImageData: Uint8Array;
}

/**
 * Decode one IGC texture to RGBA8888.
 *
 * **Not yet implemented in `granny-ro-js@1.1.0-a.0`** : throws with a
 * descriptive error pointing to the Wine-shim workaround. Full bitstream
 * decode lands in `1.1.0-a.1` (S3.5).
 *
 * @returns RGBA8888 bytes, length = `Width * Height * 4`
 * @throws Error in the current ship — see `plans/granny-texture-igc/STATUS.md`
 */
export function decodeIGCTexture(igcImage: IGCImage): Uint8Array;

/**
 * YUV-ish → RGB plane inversion (asm cite `granny2.dll @ 0x10009a30`).
 *
 * Internal helper — exported so the test suite can validate it
 * independently on synthetic planes. Not part of the public package
 * surface.
 *
 * @param yp Y plane, S16 length `width * height`
 * @param up U plane, S16 length `width * height`
 * @param vp V plane, S16 length `width * height`
 * @param ap A plane, S16 length `width * height` (values already 0..255)
 * @returns RGBA8888 `Uint8Array` of length `width * height * 4`
 */
export function yuvToRGB(
    yp: Int16Array | Int32Array | ReadonlyArray<number>,
    up: Int16Array | Int32Array | ReadonlyArray<number>,
    vp: Int16Array | Int32Array | ReadonlyArray<number>,
    ap: Int16Array | Int32Array | ReadonlyArray<number>,
    width: number,
    height: number,
): Uint8Array;
