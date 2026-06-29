// Sibling .d.ts paired with Granny.js — the public entry point of granny-ro-js.

import type { GR2File, GR2Section } from './GrannyFile.js';
import type { Oodle0SectionInput } from './GrannyOodle0.js';
import type {
    LoadedGR2,
    ParsedObject,
    SectionRef,
    TypeMember,
    ParseTypeTreeOptions,
    ParseObjectOptions,
    ReadReferenceArrayObjectsOptions,
    ReferenceArrayObject,
} from './GrannyTypeTree.js';
import type { Skeleton, ExtractSkeletonsOptions } from './GrannySkeleton.js';
import type { MeshGeometry, ExtractMeshesOptions } from './GrannyMesh.js';
import type {
    Animation,
    TrackGroup,
    TransformTrack,
    Curve,
    CurveCodec,
    EvaluatedTransform,
    ExtractAnimationsOptions,
} from './GrannyAnimation.js';
import type { PoseSnapshot, SampledTransform } from './GrannyPose.js';

export {
    parseGR2File,
    COMPRESSION_NAMES,
    SECTION_NAMES,
    COMPRESSION_NONE,
    COMPRESSION_OODLE0,
} from './GrannyFile.js';

/**
 * Structural subset of {@link import('./GrannyFile.js').GR2Section} the
 * dispatcher needs : the codec inputs + the `compression` tag for routing.
 */
export interface DispatchSectionInput extends Oodle0SectionInput {
    readonly compression: number;
}

/**
 * Decompress one section, dispatching by `section.compression`.
 *
 * Currently supports `COMPRESSION_NONE` (0) and `COMPRESSION_OODLE0` (1).
 * `COMPRESSION_OODLE1` / `COMPRESSION_BITKNIT` / `COMPRESSION_BITKNIT2`
 * throw — none of the iRO ver12 corpus uses them ; they'll be added if a
 * future asset needs them.
 *
 * @param compressed bytes returned by `file.sectionBytes(section)`
 * @returns Uint8Array of length `section.expanded_size`
 * @throws RangeError when NoCompression input is shorter than `expanded_size`
 * @throws Error on an unsupported compression tag
 */
export function decompressSection(section: DispatchSectionInput, compressed: Uint8Array): Uint8Array;

/** Result of the top-level {@link parse} entry. */
export interface ParseResult {
    /** Header + section table for the input buffer. */
    readonly file: GR2File;
    /** Members of the root type tree (terminates at MT_END). */
    readonly typeTree: readonly TypeMember[];
    /** Materialized root object, keyed by member name. */
    readonly root: ParsedObject;
}

/** Result of {@link parseModel} : {@link ParseResult} + skeleton + mesh extraction. */
export interface ParseModelResult extends ParseResult {
    /** All skeletons in the file (empty for animation-only fixtures). */
    readonly skeletons: readonly Skeleton[];
    /** All static meshes in the file (empty for animation-only fixtures). */
    readonly meshes: readonly MeshGeometry[];
}

/** Combined options for {@link parseModel} (forwarded to skeleton + mesh extractors). */
export interface ParseModelOptions extends ExtractSkeletonsOptions, ExtractMeshesOptions {}

/** Result of {@link parseAnimated} : {@link ParseModelResult} + animation extraction. */
export interface ParseAnimatedResult extends ParseModelResult {
    /** All animations in the file (empty for pure-model fixtures without curves). */
    readonly animations: readonly Animation[];
}

/** Combined options for {@link parseAnimated} (forwarded to all three extractors). */
export interface ParseAnimatedOptions
    extends ExtractSkeletonsOptions,
        ExtractMeshesOptions,
        ExtractAnimationsOptions {}

/**
 * Parse + decompress + fixup + walk : turns a GR2 buffer into a
 * navigable JS graph. See {@link decompressSection} / {@link parseGR2File}
 * for the lower-level entries.
 *
 * @throws Error on non-Granny input, unsupported compression, or
 *   cross-endian asset with non-empty mixed-marshalling table
 * @throws RangeError when a declared section / fixup table escapes the buffer
 */
export function parse(buffer: ArrayBuffer | Uint8Array | DataView | ArrayBufferView): ParseResult;

/**
 * Full model pipeline : `parse(buffer)` + skeleton + mesh extraction.
 * Re-runs the pipeline locally (does not call {@link parse}) to keep
 * `parse()`'s lean return shape unchanged for callers that don't need
 * the multi-MB `loaded` buffers.
 */
export function parseModel(
    buffer: ArrayBuffer | Uint8Array | DataView | ArrayBufferView,
    options?: ParseModelOptions,
): ParseModelResult;

/**
 * Full animated-asset pipeline : `parseModel(buffer)` + animation
 * curve extraction. Animation-only fixtures resolve `result.skeletons`
 * + `result.meshes` to empty arrays but populate `result.animations`
 * fully ; pure model fixtures do the reverse.
 */
export function parseAnimated(
    buffer: ArrayBuffer | Uint8Array | DataView | ArrayBufferView,
    options?: ParseAnimatedOptions,
): ParseAnimatedResult;

/**
 * Sample the first skeleton of `parsed` at time `t` against
 * `parsed.animations[animationIndex]`. Returns a {@link PoseSnapshot}
 * with per-bone local Transforms + world matrices + skinning matrices
 * (column-major Float32Array(16), GPU-ready).
 *
 * The iRO ver12 layout keeps model + animations in separate `.gr2`
 * files ; callers typically graft an animation array onto a parsed
 * model before calling `poseAt`. Pure model fixtures (no animation
 * available) accept `animationIndex` outside the available range — the
 * pose collapses to the bind pose.
 */
export function poseAt(
    parsed: ParseModelResult | ParseAnimatedResult,
    animationIndex: number,
    t: number,
): PoseSnapshot;

// Re-exports from GrannyTypeTree (advanced surface for direct walking).
export {
    loadGR2,
    parseTypeTree,
    parseObject,
    objectStorageSize,
    readReferenceArrayObjects,
} from './GrannyTypeTree.js';
export { extractSkeletons } from './GrannySkeleton.js';
export { extractMeshes } from './GrannyMesh.js';
export {
    extractAnimations,
    evaluateTransformTrack,
    evaluateAnimation,
} from './GrannyAnimation.js';
export {
    composeLocalMatrix,
    multiplyMat4,
    composeWorldPose,
    composeSkinningMatrices,
    poseSkeletonAt,
} from './GrannyPose.js';

export type {
    LoadedGR2,
    ParsedObject,
    SectionRef,
    TypeMember,
    ParseTypeTreeOptions,
    ParseObjectOptions,
    ReadReferenceArrayObjectsOptions,
    ReferenceArrayObject,
    Skeleton,
    ExtractSkeletonsOptions,
    MeshGeometry,
    ExtractMeshesOptions,
    Animation,
    TrackGroup,
    TransformTrack,
    Curve,
    CurveCodec,
    EvaluatedTransform,
    ExtractAnimationsOptions,
    PoseSnapshot,
    SampledTransform,
};
