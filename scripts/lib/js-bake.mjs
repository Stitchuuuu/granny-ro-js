/**
 * js-bake.mjs — JS-only decompression of a .gr2 fixture, producing the
 * canonical hash-set used by the content-addressed manifest.
 *
 * Used by both `regenerate-manifest.mjs` (writes the manifest) and
 * `test-js.mjs` (verifies the manifest). Keeping one source of truth
 * for the bake logic ensures regen and verify never drift apart.
 *
 * Output shape per fixture :
 *   {
 *     sizeBytes, filenameHint,
 *     sections:   [ { idx, sizeBytes, sha256 } ],
 *     textures:   [ { texIdx, imgIdx, mipIdx, width, height, encoding, alpha, rgbaSha256 } ],
 *     meshes:     [ { idx, name, verticesCount, triangleGroupsCount, sha256 } ],
 *     skeletons:  [ { idx, name, boneCount, sha256 } ],
 *     animations: [ { idx, name, duration, sha256 } ],
 *     materials:  [ { idx, name, sha256 } ],
 *     errors?:    { category: errorMessage }
 *   }
 */

import { createHash } from 'node:crypto';

import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import {
    walkTextureImages, ENCODING_RAW, ENCODING_IGC,
} from '../../src/GrannyTexture.js';
import { decodeIGCTexture } from '../../src/GrannyTextureIGC.js';
import { extractMeshes, extractMaterials } from '../../src/GrannyMesh.js';
import { extractSkeletons } from '../../src/GrannySkeleton.js';
import { extractAnimations } from '../../src/GrannyAnimation.js';

export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * JS-side bake of a texture image record to RGBA8888 bytes.
 * Encoding 1 (Raw)  → BGRA swizzle from on-disk pixelBytes.
 * Encoding 3 (IGC)  → decodeIGCTexture clean-room port.
 */
export function jsBakeTexture(record) {
    const { width, height, encoding, alpha, pixelBytes } = record;
    if (encoding === ENCODING_RAW) {
        const expected = width * height * 4;
        if (!pixelBytes || pixelBytes.length !== expected) {
            throw new Error(
                `Raw MIP byte count ${pixelBytes?.length} != W*H*4 (${expected})`
            );
        }
        const rgba = new Uint8Array(expected);
        for (let i = 0; i < expected; i += 4) {
            rgba[i]     = pixelBytes[i + 2];
            rgba[i + 1] = pixelBytes[i + 1];
            rgba[i + 2] = pixelBytes[i];
            rgba[i + 3] = pixelBytes[i + 3];
        }
        return rgba;
    }
    if (encoding === ENCODING_IGC) {
        return decodeIGCTexture({
            Width: width,
            Height: height,
            Alpha: alpha,
            ImageData: pixelBytes,
        });
    }
    throw new Error(`unsupported encoding ${encoding}`);
}

/**
 * Stable JSON serialization with sorted object keys + hex-encoded typed
 * arrays, for structural hashing.
 */
export function stableStringify(value) {
    return JSON.stringify(value, (key, val) => {
        if (val && typeof val === 'object' && val.constructor) {
            const ctor = val.constructor.name;
            if (ctor === 'Uint8Array' || ctor === 'Uint16Array' ||
                ctor === 'Uint32Array' || ctor === 'Int8Array' ||
                ctor === 'Int16Array' || ctor === 'Int32Array' ||
                ctor === 'Float32Array' || ctor === 'Float64Array') {
                return {
                    __typed: ctor,
                    hex: Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('hex'),
                };
            }
            if (val.constructor === Object) {
                const sortedKeys = Object.keys(val).sort();
                const sorted = {};
                for (const k of sortedKeys) sorted[k] = val[k];
                return sorted;
            }
        }
        return val;
    });
}

export function structuralSha(value) {
    return createHash('sha256').update(stableStringify(value)).digest('hex');
}

function tryExtract(fn) {
    try { return { ok: true, value: fn() ?? [] }; }
    catch (err) { return { ok: false, value: [], error: err.message }; }
}

/**
 * Build the manifest entry for a single fixture via JS-only decompression.
 * `loaded.sectionsOriginal` carries the post-Oodle0, pre-fixup section
 * bytes — same as the wine shim's gr2_decompress output, so the shas are
 * cross-comparable.
 */
export function buildEntry({ name, sizeBytes, bytes }) {
    const file = parseGR2File(bytes);
    const loaded = loadGR2(file);

    const sections = loaded.sectionsOriginal.map((data, idx) => ({
        idx,
        sizeBytes: data.length,
        sha256: sha256Hex(data),
    }));

    const texResult = tryExtract(() => {
        const records = walkTextureImages(loaded);
        return records.map((rec) => {
            const rgba = jsBakeTexture(rec);
            return {
                texIdx: rec.texIdx,
                imgIdx: rec.imgIdx,
                mipIdx: rec.mipIdx,
                width: rec.width,
                height: rec.height,
                encoding: rec.encoding,
                alpha: rec.alpha,
                rgbaSha256: sha256Hex(rgba),
            };
        });
    });

    const meshResult = tryExtract(() =>
        extractMeshes(loaded).map((mesh, idx) => ({
            idx,
            name: mesh.name ?? null,
            verticesCount: mesh.vertices?.length ?? null,
            triangleGroupsCount: mesh.triangleGroups?.length ?? null,
            sha256: structuralSha(mesh),
        }))
    );

    const skelResult = tryExtract(() =>
        extractSkeletons(loaded).map((skel, idx) => ({
            idx,
            name: skel.name ?? null,
            boneCount: skel.bones?.length ?? null,
            sha256: structuralSha(skel),
        }))
    );

    const animResult = tryExtract(() =>
        extractAnimations(loaded).map((anim, idx) => ({
            idx,
            name: anim.name ?? null,
            duration: anim.duration ?? null,
            sha256: structuralSha(anim),
        }))
    );

    const matResult = tryExtract(() =>
        extractMaterials(loaded).map((mat, idx) => ({
            idx,
            name: mat.name ?? null,
            sha256: structuralSha(mat),
        }))
    );

    const errors = {};
    if (!texResult.ok)  errors.textures   = texResult.error;
    if (!meshResult.ok) errors.meshes     = meshResult.error;
    if (!skelResult.ok) errors.skeletons  = skelResult.error;
    if (!animResult.ok) errors.animations = animResult.error;
    if (!matResult.ok)  errors.materials  = matResult.error;

    const entry = {
        sizeBytes,
        filenameHint: name,
        sections,
        textures:   texResult.value,
        meshes:     meshResult.value,
        skeletons:  skelResult.value,
        animations: animResult.value,
        materials:  matResult.value,
    };
    if (Object.keys(errors).length > 0) entry.errors = errors;
    return entry;
}
