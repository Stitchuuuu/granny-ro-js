// Sibling .d.ts paired with GrannyAnimation.js.

import type { LoadedGR2 } from './GrannyTypeTree.js';

/** Supported curve format names ; mirrors blendergranny + LegacyCurve32f. */
export type CurveCodec =
    | 'D3K16uC16u'
    | 'D3I1K16uC16u'
    | 'D4nK8uC7u'
    | 'D4nK16uC15u'
    | 'LegacyCurve32f'
    | 'DaIdentity'
    | (string & {});  // catch-all for *Constant32f + future codecs

/**
 * Compressed B-spline curve. Decoded knots + controls live in
 * `Float32Array`s ; `controls` is flattened so consumers read it as
 * `controls[knotIndex * dimension + dim]`.
 *
 * For constant codecs (`*Constant32f`) and identity codecs (`DaIdentity`),
 * `knots` and `controls` are both empty and `sampleValue` carries the
 * fixed value (length = dimension).
 */
export interface Curve {
    /** Codec name decoded from the curve type's first member. */
    readonly codec: CurveCodec;
    /** Granny-encoded format byte (≥0 for modern codecs, -1 for legacy). */
    readonly format: number;
    /** B-spline degree (0 = step, 1 = linear, 2 = quadratic, higher = nearest). */
    readonly degree: number;
    /** Per-knot value width (3 for position, 4 for orientation, 9 for scale-shear). */
    readonly dimension: number;
    /** Combined knot + control count from the on-disk header (sanity check). */
    readonly knotControlCount: number;
    /** Fallback value for constant / identity curves (length = dimension). */
    readonly sampleValue: Float32Array;
    /** Time-axis values in source order. Empty for constant / identity codecs. */
    readonly knots: Float32Array;
    /** Flattened controls in `[knot * dimension + dim]` order. */
    readonly controls: Float32Array;
}

/**
 * One bone's local-Transform timeline. The three curves drive position
 * (dim 3), orientation (dim 4 quaternion), and scale-shear (dim 9 3×3
 * matrix) independently. A curve is `null` only when the file omits it
 * — `evaluateTransformTrack` substitutes identity in that case.
 */
export interface TransformTrack {
    /** Index within the parent TrackGroup's `transformTracks` array. */
    readonly index: number;
    /** ASCII name from the GR2 file (joins to `skeleton.bones[i].name`). */
    readonly name: string;
    /** Granny SDK flags (typically 0 — interpretation deferred). */
    readonly flags: number;
    /** Quaternion orientation curve at this bone, or `null` if absent. */
    readonly orientationCurve: Curve | null;
    /** Position curve at this bone, or `null` if absent. */
    readonly positionCurve: Curve | null;
    /** Scale + shear curve at this bone, or `null` if absent. */
    readonly scaleShearCurve: Curve | null;
}

/**
 * A coherent set of TransformTracks. Multiple animations may share a
 * single TrackGroup (e.g. character idle + walk both reference the same
 * skeleton's tracks).
 */
export interface TrackGroup {
    /** Index within the top-level `track_groups` array. */
    readonly index: number;
    /** Track group name — animations reference it via this name. */
    readonly name: string;
    /** Reported count of vector tracks (S7 does not decode their values). */
    readonly vectorTrackCount: number;
    /** Reported count of transform tracks (must equal `transformTracks.length`). */
    readonly transformTrackCount: number;
    /** Reported count of text tracks (S7 does not decode them). */
    readonly textTrackCount: number;
    /** Granny SDK accumulation flags. */
    readonly accumulationFlags: number;
    /** Per-loop translation offset along the dominant axis. */
    readonly loopTranslation: number;
    /** Vector-track names (decoded — values not yet). */
    readonly vectorTrackNames: readonly string[];
    /** Per-bone Transform timelines decoded for this group. */
    readonly transformTracks: readonly TransformTrack[];
}

/** One playable animation : duration + references to TrackGroups by name. */
export interface Animation {
    /** Index within the top-level `animations` array. */
    readonly index: number;
    /** Animation name (e.g. `attack`, `dead`, `move` for iRO assets). */
    readonly name: string;
    /** Total duration in seconds. */
    readonly duration: number;
    /** Suggested per-frame time step (`0` when the file doesn't carry one). */
    readonly timeStep: number;
    /** Curve-sampling oversampling factor (typically `1.0`). */
    readonly oversampling: number;
    /** Default loop count (`0` for one-shot, `-1` for infinite by convention). */
    readonly defaultLoopCount: number;
    /** Granny SDK flags. */
    readonly flags: number;
    /** TrackGroup names referenced by this animation. */
    readonly trackGroupNames: readonly string[];
    /** TrackGroup objects resolved by name lookup (may be `[]`). */
    readonly trackGroups: readonly TrackGroup[];
}

/** Options for {@link extractAnimations}. */
export interface ExtractAnimationsOptions {
    /** Cap on the number of TrackGroups extracted (defaults to 64). */
    readonly maxTrackGroups?: number;
    /** Cap on the number of TransformTracks per TrackGroup (defaults to 512). */
    readonly maxTracksPerGroup?: number;
    /** Cap on the number of Animations extracted (defaults to 64). */
    readonly maxAnimations?: number;
}

/** Local Transform produced by {@link evaluateTransformTrack} at a given time. */
export interface EvaluatedTransform {
    /** Bone position in parent space (x, y, z). */
    readonly position: readonly [number, number, number];
    /** Bone orientation quaternion (x, y, z, w) ; re-normalized after blend. */
    readonly orientation: readonly [number, number, number, number];
    /** Bone scale + shear matrix (3×3 row-major, 9 floats). */
    readonly scaleShear: readonly number[];
}

/**
 * Walk `root.TrackGroups` and `root.Animations` and decode every
 * `TransformTrack` (including its position / orientation / scale-shear
 * curves). Returns `[]` for fixtures that don't expose any animation.
 */
export function extractAnimations(
    loaded: LoadedGR2,
    options?: ExtractAnimationsOptions,
): readonly Animation[];

/**
 * Evaluate the three curves of a `TransformTrack` at time `t`. Curves
 * that are null / empty fall back to identity values (zero position,
 * identity quat, identity 3×3 scale-shear) so the return shape is
 * always fully populated.
 *
 * Boundary semantics : `t <= knots[0]` clamps to the first knot's value
 * ; `t >= knots[n-1]` clamps to the last. In-between : B-spline blend
 * per `degree`.
 */
export function evaluateTransformTrack(
    track: TransformTrack | null | undefined,
    t: number,
): EvaluatedTransform;

/**
 * Evaluate every TransformTrack of every TrackGroup in `animation` at
 * time `t`. Returns a map keyed by `transformTrack.name`. Track-group
 * boundaries are flattened — callers wire the names to skeleton bones
 * downstream (S8).
 */
export function evaluateAnimation(
    animation: Animation | null | undefined,
    t: number,
): { readonly [trackName: string]: EvaluatedTransform };

/** Internal codec helpers exposed to the unit-test suite. Not public. */
export const __test__: {
    readonly SCALAR_SIZES: { readonly [memberType: number]: number };
    readonly QUATERNION_SCALE_OFFSET_TABLE: readonly (readonly [number, number])[];
    floatFromHighU16(value: number): number;
    quaternionScalesOffsets(
        entries: number,
        quantizedMax: number,
    ): { scales: Float32Array; offsets: Float32Array };
    curveDimension(codec: string): number;
    findKnot(knots: Float32Array, t: number): number;
    safeDiv(numerator: number, denominator: number): number;
    linearCoefficients(tiPrev: number, tiCurr: number, t: number): [number, number];
    quadraticCoefficients(
        ti2: number,
        ti1: number,
        ti: number,
        ti1Next: number,
        t: number,
    ): [number, number, number];
    normalizeQuaternion(values: readonly number[]): number[];
    readLegacyCurveMetadata(loaded: LoadedGR2, section: number, offset: number): Curve | null;
    readCurveMetadata(loaded: LoadedGR2, parentSection: number, curveOffset: number): Curve | null;
    evaluateCurve(curve: Curve | null | undefined, t: number): number[] | null;
};
