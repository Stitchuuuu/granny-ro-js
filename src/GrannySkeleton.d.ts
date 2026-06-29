// Sibling .d.ts paired with GrannySkeleton.js.
// TypeScript automatically uses this file as the type signature for the
// adjacent .js — no JSDoc imports or jsconfig wiring needed in callers.

import type { LoadedGR2 } from './GrannyTypeTree.js';

/** Local-bone Transform : on-disk 68-byte struct (u32 flags + 16 f32). */
export interface Transform {
    /** Granny SDK flags (typically 0 for animated bones, 1 for static bones). */
    readonly flags: number;
    /** Bone position in parent space (x, y, z). */
    readonly position: readonly [number, number, number];
    /** Bone orientation quaternion in parent space (x, y, z, w). */
    readonly orientation: readonly [number, number, number, number];
    /** Bone scale + shear matrix in parent space (3×3 row-major, 9 floats). */
    readonly scaleShear: readonly number[];
}

/** One bone in a skeleton (parent-index linked into the same skeleton). */
export interface SkeletonBone {
    /** 0-based index within the parent skeleton's `bones` array. */
    readonly index: number;
    /** ASCII bone name from the GR2 file (defaults to `Bone_<index>` if missing). */
    readonly name: string;
    /** Index of the parent bone, or a negative value for root bones. */
    readonly parentIndex: number;
    /** Local-space Transform applied at this bone. */
    readonly transform: Transform;
    /** Inverse bind-pose 4×4 matrix (16 floats, row-major) used for skinning. */
    readonly inverseWorldTransform: readonly number[];
}

/** A skeleton : ordered bones + LOD type. */
export interface Skeleton {
    /** Skeleton name from the GR2 file (defaults to `Skeleton_<index>` if missing). */
    readonly name: string;
    /** Bones in source order ; `parentIndex` references entries within this array. */
    readonly bones: readonly SkeletonBone[];
    /** Granny LOD type field (0 for standard skeletons). */
    readonly lodType: number;
}

/** Options for {@link extractSkeletons}. */
export interface ExtractSkeletonsOptions {
    /** Cap on the number of skeletons extracted (defaults to 16). */
    readonly maxSkeletons?: number;
    /** Cap on the number of bones extracted per skeleton (defaults to 4096). */
    readonly maxBones?: number;
}

/**
 * Walk `root.Skeletons` and return every skeleton with bones, local
 * Transforms, and InverseWorldTransform. Returns `[]` when the GR2
 * carries no skeleton (animation-only files in the iRO corpus).
 */
export function extractSkeletons(
    loaded: LoadedGR2,
    options?: ExtractSkeletonsOptions,
): readonly Skeleton[];
