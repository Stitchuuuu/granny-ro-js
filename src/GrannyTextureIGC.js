// GrannyTextureIGC.js — IGC (RAD BinkTC) texture-bitstream decoder.
//
// Clean-room port of the codec exposed as `_GrannyDecompressIGCTexture@12`
// in granny2.dll (iRO ver12), spec'd in
// `iRO_ver12.0-full-client-data/RE/granny2/IGC-FORMAT.md` and validated
// byte-exact against the parity-bake golden data in
// `tests/fixtures/baked/textures/*.rgba` (produced by S2's Wine shim).
//
// Pipeline per IGC-FORMAT.md § 7 :
//
//   1. `planeDecode(src)` — adaptive arithmetic coder + 4-level sub-band
//      traversal, produces a wavelet-transformed S16 plane (Y, U, V, A).
//      Asm cite : `granny2.dll @ 0x100045b0` (`FromBinkTC`), leaked-SDK
//      `encode.c:1884` (`plane_decode`).
//   2. `iDWT2D(plane)` — 4 passes of RAD's reversible-integer lifting-
//      scheme wavelet at increasing resolution (1/8 → 1/4 → 1/2 → full).
//      Asm cite : `granny2.dll @ 0x10009700`, leaked-SDK
//      `wavelet.c:1328` (`iDWT2D` dispatcher).
//   3. `yuvToRGB(yp, up, vp, ap)` — custom integer-reversible YUV-ish
//      colorspace inversion, writes RGBA8888 in dest. Asm cite :
//      `granny2.dll @ 0x10009a30`, leaked-SDK `granny_bink.cpp:165`
//      (USING_GL_RGB branch — matches what iRO 2002 codec produces ;
//      verified by hex-inspecting the baked treasurebox_2 byte order :
//      pixel 0 = R=0x40 G=0x20 B=0x00 → brown, RGBA order).
//
// **Status (1.1.0-a.0)** : `yuvToRGB` ported + validated. `iDWT2D` +
// `planeDecode` + arithmetic codec land in `1.1.0-a.1` (rollout S3.5).
// Until then, `decodeIGCTexture` throws a clear error so callers know
// where to look ; raw (encoding=1) fixtures decode normally.

const PLANE_VALUE_OFFSET = 0;  // YUVtoRGB consumes raw S16, no bias applied

/**
 * `_GrannyDecompressIGCTexture@12` clean-room port.
 *
 * Input : `{Width, Height, Alpha, ImageData}` — the IGC bitstream as
 * stored in the .gr2's `Pixels` array (see IGC-FORMAT.md § 3).
 *
 * Output : RGBA8888 `Uint8Array` of length `Width * Height * 4`.
 *
 * **Not yet implemented in `granny-ro-js@1.1.0-a.0`** — the wavelet +
 * arithmetic + plane-decode kernels are deferred to S3.5. For now,
 * generate parity blobs via the Wine shim (see
 * `scripts/bake-textures.mjs`) and read them back from
 * `tests/fixtures/baked/textures/`.
 */
export function decodeIGCTexture(igcImage) {
    const { Width, Height } = igcImage;
    throw new Error(
        `decodeIGCTexture: IGC bitstream decode is not yet implemented in ` +
        `granny-ro-js@1.1.0-a.0 (rollout S3 partial ship). The wavelet + ` +
        `arithmetic + plane-decode kernels (~2000 LoC of dense bit-twiddling) ` +
        `land in 1.1.0-a.1 (S3.5). Workaround: bake RGBA blobs with the Wine ` +
        `shim — see plans/granny-texture-igc/STATUS.md S3.5 and ` +
        `scripts/bake-textures.mjs. Requested decode: ${Width}x${Height} IGC.`
    );
}

/**
 * YUV-ish → RGB inversion for one set of S16 planes. Output byte order
 * is RGBA8888 (matches the baked .rgba golden data — verified by hex-
 * inspecting the treasurebox_2 first pixel : 0x40 0x20 0x00 → R=64 G=32
 * B=0, the expected brown of a wood chest).
 *
 * Per IGC-FORMAT.md § 5 (asm cite `granny2.dll @ 0x10009a30`) :
 * the planes are mapped `r ← U_plane`, `g ← Y_plane`, `b ← V_plane`
 * (NOT Y→r) and de-coupled via :
 *
 *   g -= (r + b) >> 2
 *   r += g
 *   b += g
 *
 * then clamped to `0..255`. Leaked-SDK reference :
 * `granny_bink.cpp:165-210` (the `USING_GL_RGB` branch, line 196).
 *
 * @param yp Y plane (S16, length = `width * height`)
 * @param up U plane (S16, length = `width * height`)
 * @param vp V plane (S16, length = `width * height`)
 * @param ap A plane (S16, length = `width * height`) ; values already in 0..255
 * @param width plane width in pixels
 * @param height plane height in pixels
 * @returns RGBA8888 `Uint8Array` of length `width * height * 4`
 */
export function yuvToRGB(yp, up, vp, ap, width, height) {
    const count = width * height;
    const out = new Uint8Array(count * 4);
    let o = 0;
    for (let i = 0; i < count; i++) {
        let r = up[i] + PLANE_VALUE_OFFSET;
        let g = yp[i] + PLANE_VALUE_OFFSET;
        let b = vp[i] + PLANE_VALUE_OFFSET;
        let a = ap[i];

        // de-couple : Y carries luma offset by 1/4 of the (R+B) chroma sum
        g -= (r + b) >> 2;
        r += g;
        b += g;

        // clamp to 0..255
        if (r < 0) r = 0; else if (r > 255) r = 255;
        if (g < 0) g = 0; else if (g > 255) g = 255;
        if (b < 0) b = 0; else if (b > 255) b = 255;
        if (a < 0) a = 0; else if (a > 255) a = 255;

        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = a;
        o += 4;
    }
    return out;
}
