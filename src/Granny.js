// Granny.js — public entry point for granny-ro-js.
//
// S3' surface : parse a .gr2 buffer + decompress each section (NONE / OODLE0).
// S5 adds parse(buffer) → { file, typeTree, root } : full DataTypeDefinition
// walk + RootObject materialization. See ./GrannyTypeTree.js for details.
//
// Public-API types : see ./Granny.d.ts (sibling).

import {
    parseGR2File,
    COMPRESSION_NONE,
    COMPRESSION_OODLE0,
    COMPRESSION_NAMES,
    SECTION_NAMES,
} from './GrannyFile.js';
import { decompressOodle0 } from './GrannyOodle0.js';
import {
    loadGR2,
    parseTypeTree,
    parseObject,
    objectStorageSize,
    readReferenceArrayObjects,
} from './GrannyTypeTree.js';
import { extractSkeletons } from './GrannySkeleton.js';
import { extractMeshes } from './GrannyMesh.js';
import { extractAnimations, evaluateTransformTrack, evaluateAnimation } from './GrannyAnimation.js';
import {
    composeLocalMatrix,
    multiplyMat4,
    composeWorldPose,
    composeSkinningMatrices,
    poseSkeletonAt,
} from './GrannyPose.js';

export { parseGR2File, COMPRESSION_NAMES, SECTION_NAMES };
export { COMPRESSION_NONE, COMPRESSION_OODLE0 };
export { loadGR2, parseTypeTree, parseObject, objectStorageSize, readReferenceArrayObjects };
export { extractSkeletons, extractMeshes };
export { extractAnimations, evaluateTransformTrack, evaluateAnimation };
export {
    composeLocalMatrix,
    multiplyMat4,
    composeWorldPose,
    composeSkinningMatrices,
    poseSkeletonAt,
};

/**
 * Decompress a single section, dispatching by `section.compression`.
 *
 * Supported : `COMPRESSION_NONE` (0) and `COMPRESSION_OODLE0` (1).
 * `COMPRESSION_OODLE1` (2), `COMPRESSION_BITKNIT` (3), `COMPRESSION_BITKNIT2` (4)
 * throw — none of the iRO ver12 corpus uses them ; codec ports will land
 * in a later session if an asset ever needs them.
 *
 * Empty sections (`expanded_size === 0`) short-circuit to an empty
 * Uint8Array without dispatching.
 *
 * @throws RangeError when NoCompression input is shorter than `expanded_size`
 * @throws Error on an unsupported compression tag
 * @throws DecompressionError on malformed Oodle0 input (re-thrown from `decompressOodle0`)
 */
export function decompressSection(section, compressed) {
    if (section.expanded_size === 0) return new Uint8Array(0);
    if (section.compression === COMPRESSION_NONE) {
        if (compressed.length < section.expanded_size) {
            throw new RangeError(
                `section ${section.index} short: ${compressed.length} < ${section.expanded_size}`
            );
        }
        return compressed.subarray(0, section.expanded_size);
    }
    if (section.compression === COMPRESSION_OODLE0) {
        return decompressOodle0(section, compressed);
    }
    throw new Error(`unsupported compression ${section.compression}`);
}

/**
 * Full pipeline : parse the GR2 file, decompress + fixup all sections,
 * walk the root type tree, materialize the root object.
 *
 * After this returns, `result.root` is a plain JS graph keyed by member
 * name (`root.Meshes`, `root.Skeletons`, …) ready for downstream
 * skeleton / mesh extraction to navigate without touching binary again.
 *
 * @throws Error on non-Granny input, unsupported compression, or
 *   cross-endian asset with non-empty mixed-marshalling table
 * @throws RangeError when a declared section / fixup table escapes the buffer
 */
export function parse(buffer) {
    const file = parseGR2File(buffer);
    const loaded = loadGR2(file);
    const typeTree = parseTypeTree(loaded, file.header.root_type);
    const root = parseObject(loaded, typeTree, file.header.root_object);
    return { file, typeTree, root };
}

/**
 * Full model pipeline : `parse(buffer)` + skeleton + mesh extraction.
 * On any of the 6 model fixtures, `result.skeletons` carries the bind-
 * pose bones (with local Transforms + InverseWorldTransform) and
 * `result.meshes` carries decoded vertex / index / weight / material
 * buffers — ready for the renderer without any further binary parsing.
 *
 * Re-runs the pipeline locally (does not call {@link parse}) so the
 * lean `parse()` return shape stays unchanged for callers that don't
 * need the multi-MB `loaded` buffers.
 *
 * Animation-only fixtures resolve to empty arrays for both `skeletons`
 * and `meshes` — same throw / error surface as {@link parse}.
 */
export function parseModel(buffer, options = {}) {
    const file = parseGR2File(buffer);
    const loaded = loadGR2(file);
    const typeTree = parseTypeTree(loaded, file.header.root_type);
    const root = parseObject(loaded, typeTree, file.header.root_object);
    const skeletons = extractSkeletons(loaded, options);
    const meshes = extractMeshes(loaded, options);
    return { file, typeTree, root, skeletons, meshes };
}

/**
 * Full animated-asset pipeline : `parseModel(buffer)` + animation
 * extraction. On the 15 animation-only fixtures, `result.animations`
 * carries every `Animation` with its resolved `TrackGroup`s + decoded
 * `TransformTrack`s ; call `evaluateTransformTrack(track, t)` (or
 * `evaluateAnimation(anim, t)`) to sample local-Transform values at any
 * point in time, ready for S8 pose composition.
 *
 * Pure model fixtures resolve to `animations = []` (they carry skeleton
 * + mesh but no curve data). Mirrors {@link parseModel}'s contract :
 * re-runs the lower-level pipeline locally so {@link parse} stays lean.
 */
export function parseAnimated(buffer, options = {}) {
    const file = parseGR2File(buffer);
    const loaded = loadGR2(file);
    const typeTree = parseTypeTree(loaded, file.header.root_type);
    const root = parseObject(loaded, typeTree, file.header.root_object);
    const skeletons = extractSkeletons(loaded, options);
    const meshes = extractMeshes(loaded, options);
    const animations = extractAnimations(loaded, options);
    return { file, typeTree, root, skeletons, meshes, animations };
}

/**
 * Sample one animation against the first skeleton of `parsed` at time
 * `t`. `parsed` is the union shape `parseModel(buffer)` or
 * `parseAnimated(buffer)` returns ; the animations array can also be
 * grafted from a sibling `parseAnimated` call when the animation lives
 * in a separate `.gr2` (the iRO ver12 layout : model + N animations
 * keyed by mob ID, all separate files).
 *
 * Returns the {@link import('./GrannyPose.js').PoseSnapshot} S9 needs to
 * push per-bone transforms to the GPU vertex shader (`skinningMatrices`)
 * + debug-friendly intermediates (`localTransforms`, `worldMatrices`).
 */
export function poseAt(parsed, animationIndex, t) {
    const skeleton = parsed.skeletons?.[0];
    if (!skeleton) {
        throw new Error('poseAt: parsed.skeletons[0] is missing');
    }
    const animations = parsed.animations ?? [];
    const animation = animations[animationIndex] ?? null;
    return poseSkeletonAt(skeleton, animation, t);
}
