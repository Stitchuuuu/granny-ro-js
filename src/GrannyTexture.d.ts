// Sibling .d.ts paired with GrannyTexture.js.

import type { LoadedGR2 } from './GrannyTypeTree.js';

/** Raw = 32 bpp BGRA stored verbatim, no codec. */
export const ENCODING_RAW: 1;
/** S3TC = DXT-N block compression. Not in iRO corpus ; throws on decode. */
export const ENCODING_S3TC: 2;
/** IGC = RAD BinkTC (wavelet + arithmetic + YUV→RGB). The iRO ver12 default. */
export const ENCODING_IGC: 3;

/** One decoded (texture, image, MIP) entry returned by {@link extractTextures}. */
export interface TextureRecord {
    /** 0-based texture index within `root.Textures`. */
    readonly texIdx: number;
    /** 0-based image index within the texture's `Images` array (iRO uses 0). */
    readonly imgIdx: number;
    /** 0-based MIP-level index within the image's `MIPLevels` array (iRO uses 0). */
    readonly mipIdx: number;
    /** Texture authored name (defaults to `tex<texIdx>` when `FromFileName` is empty). */
    readonly name: string;
    /** Original `FromFileName` from the Granny struct (may include Windows-style paths). */
    readonly fromFileName: string;
    /** MIP width in pixels. */
    readonly width: number;
    /** MIP height in pixels. */
    readonly height: number;
    /** Encoding tag (`1` = Raw, `2` = S3TC, `3` = IGC). */
    readonly encoding: 1 | 2 | 3;
    /** S3TC subformat (`0..3` = DXT-N) ; meaningful only for `encoding === 2`. */
    readonly subFormat: number;
    /** `1` when the texture carries an alpha channel ; `0` for opaque. */
    readonly alpha: 0 | 1;
    /** Decoded RGBA8888 bytes, length = `width * height * 4`. */
    readonly pixels: Uint8Array;
}

/** One pre-decode record yielded by {@link walkTextureImages}. */
export interface TextureWalkRecord {
    readonly texIdx: number;
    readonly imgIdx: number;
    readonly mipIdx: number;
    readonly width: number;
    readonly height: number;
    readonly encoding: number;
    readonly subFormat: number;
    readonly alpha: 0 | 1;
    readonly fromFileName: string;
    /** Raw `Pixels` bytes from the .gr2 ; `null` when the pixel array can't be resolved. */
    readonly pixelBytes: Uint8Array | null;
    /** Length declared in the Granny `Pixels` / `PixelBytes` reference (may differ from `pixelBytes?.length` on broken assets). */
    readonly pixelCount: number;
}

/** Options for {@link extractTextures} and {@link walkTextureImages}. */
export interface ExtractTexturesOptions {
    /** Cap on the number of textures walked (defaults to 256). */
    readonly maxTextures?: number;
    /** Cap on the number of images per texture (defaults to 8). */
    readonly maxImages?: number;
    /** Cap on the number of MIP levels per image (defaults to 32 ; iRO corpus uses 1). */
    readonly maxMips?: number;
}

/**
 * Walk `root.Textures` and decode every (texture, image, MIP) triple to
 * RGBA8888. Returns a flat array — one entry per MIP — matching the
 * baked-textures manifest shape so byte-exact parity tests can join by
 * `(texIdx, imgIdx, mipIdx)`.
 *
 * @throws Error on S3TC textures (encoding=2) — no iRO asset uses them.
 * @throws Error on IGC textures (encoding=3) in the `1.1.0-a.0` build —
 *   the JS bitstream port lands in `1.1.0-a.1` (S3.5).
 */
export function extractTextures(
    loaded: LoadedGR2,
    options?: ExtractTexturesOptions,
): readonly TextureRecord[];

/**
 * Lower-level walker : yields one record per (texture, image, MIP)
 * triple without decoding. Used by both `extractTextures` (decode path)
 * and `scripts/bake-textures.mjs` (Wine shim driver).
 */
export function walkTextureImages(
    loaded: LoadedGR2,
    options?: ExtractTexturesOptions,
): readonly TextureWalkRecord[];
