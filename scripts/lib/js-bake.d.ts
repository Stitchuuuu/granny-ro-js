/**
 * JS-only decompression of a .gr2 fixture, producing the canonical
 * hash-set used by the content-addressed manifest.
 *
 * Used by both `regenerate-manifest.mjs` (writes the manifest) and
 * `test-js.mjs` (verifies the manifest). Keeping one source of truth
 * for the bake logic ensures regen and verify never drift apart.
 */

import type { Gr2Record } from './discover-gr2.js';

/**
 * Per-section sha record. One element per Granny section (typically 6 :
 * `main`, `rigid_vertex`, `rigid_index`, `deformable_vertex`,
 * `deformable_index`, `texture`). The sha is of the post-Oodle0
 * decompressed bytes (matches the wine shim's gr2_decompress output).
 */
export interface ManifestSection {
    idx: number;
    sizeBytes: number;
    sha256: string;
}

/**
 * Per-texture sha record. One element per (texture, image, MIP). The
 * sha is of the **decoded RGBA8888 pixel bytes** — what `granny2.dll`
 * produces for the same input.
 */
export interface ManifestTexture {
    texIdx: number;
    imgIdx: number;
    mipIdx: number;
    width: number;
    height: number;
    /** 1 = Raw BGRA, 2 = S3TC, 3 = IGC. */
    encoding: number;
    alpha: number;
    rgbaSha256: string;
}

/**
 * Per-mesh sha record. Mesh details (vertices count, triangle groups
 * count) are surfaced for log readability ; the sha is of the
 * structurally-extracted mesh object (vertices, triangles, weights,
 * material bindings) under a stable JSON serialization.
 */
export interface ManifestMesh {
    idx: number;
    name: string | null;
    verticesCount: number | null;
    triangleGroupsCount: number | null;
    sha256: string;
}

/**
 * Per-skeleton sha record. Hash covers bone hierarchy + local transforms
 * + inverse-world transforms.
 */
export interface ManifestSkeleton {
    idx: number;
    name: string | null;
    boneCount: number | null;
    sha256: string;
}

/**
 * Per-animation sha record. Hash covers all transform tracks + vector
 * tracks (keyframe arrays, curve-form bytes — runtime evaluation at
 * time `t` is NOT in scope here, see GrannyAnimation.test.js for that).
 */
export interface ManifestAnimation {
    idx: number;
    name: string | null;
    duration: number | null;
    sha256: string;
}

/**
 * Per-material sha record. Hash covers maps + sub-materials +
 * parameters.
 */
export interface ManifestMaterial {
    idx: number;
    name: string | null;
    sha256: string;
}

/**
 * Manifest entry for a single fixture, keyed externally by the .gr2 sha.
 */
export interface ManifestEntry {
    sizeBytes: number;
    /** Filename hint for log readability — never used for matching. */
    filenameHint: string;
    sections: ManifestSection[];
    textures: ManifestTexture[];
    meshes: ManifestMesh[];
    skeletons: ManifestSkeleton[];
    animations: ManifestAnimation[];
    materials: ManifestMaterial[];
    /**
     * Per-category error messages from any extract that threw. Present
     * only when at least one category failed (e.g. anti-hang guard
     * triggered on a known-malformed fixture).
     */
    errors?: Record<string, string>;
}

/**
 * Hex sha256 of a buffer.
 */
export function sha256Hex(buf: Buffer | Uint8Array): string;

/**
 * JS-side bake of one texture record (from `walkTextureImages`) to
 * RGBA8888 bytes. Encoding 1 (Raw) → BGRA swizzle ; Encoding 3 (IGC) →
 * `decodeIGCTexture` clean-room port.
 */
export function jsBakeTexture(record: {
    width: number;
    height: number;
    encoding: number;
    alpha: number;
    pixelBytes: Uint8Array;
}): Uint8Array;

/**
 * Stable JSON serialization with sorted object keys + hex-encoded
 * typed arrays, for structural hashing. Output bytes are deterministic
 * across Node runs and platforms.
 */
export function stableStringify(value: unknown): string;

/**
 * Hex sha256 of a value's stable JSON serialization.
 */
export function structuralSha(value: unknown): string;

/**
 * Build the manifest entry for a single fixture via JS-only decompression.
 *
 * Uses `loaded.sectionsOriginal` for section bytes (post-Oodle0,
 * pre-fixup — same as the wine shim's gr2_decompress output, so the
 * shas are cross-comparable).
 *
 * Per-category extraction is wrapped in `tryExtract` so a throw in one
 * category (e.g. textures on a known-anti-hang fixture) doesn't blow
 * up the rest. Errors are recorded in `entry.errors`.
 */
export function buildEntry(fixture: Gr2Record): ManifestEntry;
