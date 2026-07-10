import type { Transform } from './GrannyTransform.js';

/**
 * One binding of a Mesh to a Model. Indices into the array returned by
 * `extractMeshes(loaded)`. The skinning bone-table is inherited from the
 * Model's `skeletonIdx` ; per-binding `ToBoneIndices` is supported by
 * newer Granny SDK versions but absent in the iRO ver12 corpus and
 * therefore not surfaced here.
 */
export interface ModelMeshBinding {
    /** Index into `extractMeshes(loaded)` ; -1 if the on-disk pointer
     *  doesn't resolve to any extracted mesh (defensive fallback). */
    meshIdx: number;
}

/**
 * Materialized `GrannyModel` — the canonical instance struct that binds
 * a `GrannySkeleton` to a list of `GrannyMesh` with an initial world
 * placement Transform. Returned in order matching `root.Models.element_refs`.
 */
export interface ModelInfo {
    /** Model.Name, or `Model_<i>` when the name string is empty. */
    name: string;
    /** Index into `extractSkeletons(loaded)` ; -1 when the on-disk
     *  pointer doesn't resolve. */
    skeletonIdx: number;
    /** 68-byte Granny Transform decoded into `{ flags, position,
     *  orientation, scaleShear }`. Identity when the address falls
     *  outside the section. */
    initialPlacement: Transform;
    /** One entry per `GrannyModelMeshBinding` in the model. */
    meshBindings: ModelMeshBinding[];
}

/**
 * Walk `root.Models` and materialize every `GrannyModel` instance.
 * Returns `[]` for animation-only fixtures.
 */
export function extractModels(
    loaded: unknown,
    options?: { maxModels?: number; maxBindings?: number },
): ModelInfo[];
