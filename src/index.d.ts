// src-relative type barrel — the roll SOURCE for dist/granny-ro.d.ts
// (scripts/build-dist.mjs feeds this to dts-bundle-generator). Build input
// only : it is not shipped (package.json "files" ships dist/ + the root
// index.d.ts, which re-exports the rolled bundle). Mirrors the public surface
// of the `.` entry.

export * from './Granny.js';
export * from './GrannyFile.js';
export * from './GrannyOodle0.js';
export * from './GrannyTypeTree.js';

// `Granny.js` re-exports `extractModels` at runtime but `export *` above does
// not carry the `ModelInfo` type ; surface both explicitly so consumers get
// real types instead of `any`.
export { extractModels, type ModelInfo } from './GrannyModel.js';

// Extractor / pose / animation types whose modules are not `export *`d above —
// surface them on the main entry as named `export type` re-exports. Named
// re-exports dedupe against the cross-module inline `import(...)` refs these
// types get elsewhere ; a bare `export *` would fork a duplicate (`Animation$1`).
// The animation *functions* still reach the entry via `export * from './Granny.js'`.
export type { Skeleton, SkeletonBone, ExtractSkeletonsOptions } from './GrannySkeleton.js';
export type { MeshGeometry, ExtractMeshesOptions } from './GrannyMesh.js';
export type { TextureRecord, ExtractTexturesOptions } from './GrannyTexture.js';
export type { PoseSnapshot, SampledTransform } from './GrannyPose.js';
export type {
    Animation,
    Curve,
    CurveCodec,
    TransformTrack,
    TrackGroup,
    EvaluatedTransform,
    ExtractAnimationsOptions,
} from './GrannyAnimation.js';
