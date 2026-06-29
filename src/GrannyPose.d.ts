// Sibling .d.ts paired with GrannyPose.js.

import type { Animation, EvaluatedTransform } from './GrannyAnimation.js';
import type { Skeleton, Transform } from './GrannySkeleton.js';

/** One bone's local Transform at a sampled instant : either a `Transform`
 * read from the bind pose, an `EvaluatedTransform` produced by
 * `evaluateAnimation`, or any structurally-compatible shape (length-3
 * position, length-4 quaternion, length-9 scale-shear — checked at
 * runtime ; the type only constrains the shape, not tuple length). */
export interface LooseTransform {
    readonly flags?: number;
    readonly position?: ArrayLike<number>;
    readonly orientation?: ArrayLike<number>;
    readonly scaleShear?: ArrayLike<number>;
}
export type SampledTransform = Transform | EvaluatedTransform | LooseTransform;

/** Output of {@link poseSkeletonAt} : per-bone snapshots ready for the GPU. */
export interface PoseSnapshot {
    /** Per-bone local Transform : evaluated from the animation when the
     * bone has a matching track, bind-pose fallback otherwise. Indexed
     * by `bone.index`. */
    readonly localTransforms: readonly SampledTransform[];
    /** Per-bone world matrix (`Mworld[i] = Mworld[parent] × Mlocal[i]`),
     * column-major Float32Array(16). Indexed by `bone.index`. */
    readonly worldMatrices: readonly Float32Array[];
    /** Per-bone skinning matrix (`Mskin[i] = Mworld[i] × IWT[i]`),
     * column-major Float32Array(16). The GPU vertex shader uses these
     * directly to push bind-pose vertices into the frame's world space.
     * Indexed by `bone.index`. */
    readonly skinningMatrices: readonly Float32Array[];
}

/**
 * Build the column-major 4×4 matrix `Mlocal = T × R × S` from one
 * Transform. The quaternion is normalized defensively before R is
 * built. Returns a fresh Float32Array(16).
 */
export function composeLocalMatrix(transform: SampledTransform | null | undefined): Float32Array;

/**
 * Multiply two column-major 4×4 matrices : `out = a × b`. If `out` is
 * `null` or `undefined`, a fresh Float32Array(16) is allocated. `a` and
 * `b` may alias `out`.
 */
export function multiplyMat4(
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    out?: Float32Array | null,
): Float32Array;

/**
 * Forward-kinematics composition : walk the bone hierarchy parent-first
 * and produce per-bone world matrices. `Mworld[i] = Mworld[parent] ×
 * Mlocal[i]` ; root bones (`parentIndex < 0`) inherit `Mlocal[i]`.
 *
 * `localMatrices.length` must equal `skeleton.bones.length` ; entries
 * are column-major Float32Array(16). Returns a fresh array of
 * Float32Array(16) (the input is not mutated).
 */
export function composeWorldPose(
    skeleton: Skeleton,
    localMatrices: readonly ArrayLike<number>[],
): Float32Array[];

/**
 * Post-multiply each world matrix by the bone's bind-pose inverse for
 * GPU skinning : `Mskin[i] = Mworld[i] × bone.inverseWorldTransform`.
 * The IWT bytes are converted from Granny's row-major on-disk layout to
 * column-major Float32Array(16) at conversion time.
 */
export function composeSkinningMatrices(
    skeleton: Skeleton,
    worldMatrices: readonly ArrayLike<number>[],
): Float32Array[];

/**
 * Sample one animation at time `t` and produce a complete pose snapshot
 * for the skeleton. Bones not driven by the animation fall back to
 * their bind-pose Transform. Passing `null` for `animation` returns the
 * bind pose itself (useful for debug + the convention smoke test).
 */
export function poseSkeletonAt(
    skeleton: Skeleton,
    animation: Animation | null | undefined,
    t: number,
): PoseSnapshot;

/** Internal test surface ; not part of the public API. */
export const __test__: {
    readonly IDENTITY_MAT4: readonly number[];
    readonly IDENTITY_TRANSFORM: Transform;
    readonly IWT_TRANSPOSE_ON_LOAD: boolean;
    normalizeQuaternion(values: ArrayLike<number>): number[];
    boneIwtAsArray(bone: { inverseWorldTransform: readonly number[] }): number[];
    composeLocalMatrixF64(transform: SampledTransform | null | undefined): number[];
};
