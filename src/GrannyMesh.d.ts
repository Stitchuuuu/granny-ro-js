// Sibling .d.ts paired with GrannyMesh.js.

import type { LoadedGR2, MemberTypeConstant } from './GrannyTypeTree.js';

/** One declared component of a vertex row (Position, Normal, BoneWeights, …). */
export interface VertexComponent {
    /** Component name from the Granny vertex type tree. */
    readonly name: string;
    /** Byte offset within one vertex row at which this component starts. */
    readonly offset: number;
    /** Declared element width (typically 3 for Position, 2 for UV, 4 for weights). */
    readonly width: number;
    /** Raw `MT_*` enum value the component is stored as (drives decode). */
    readonly memberType: MemberTypeConstant;
}

/** A skeleton-bone reference a mesh declares it depends on (skinning slot). */
export interface BoneBinding {
    /** 0-based slot index within the mesh's `boneBindings` array. */
    readonly index: number;
    /** Bone name (matches a `SkeletonBone.name` in the model's skeleton). */
    readonly name: string;
}

/** One per-vertex (bone, weight) entry for skinning. */
export interface VertexBoneWeight {
    /** Index into the mesh's `boneBindings` array (NOT a global bone index). */
    readonly boneIndex: number;
    /** Skinning weight in `[0, 1]` (already normalized for normal-uint encodings). */
    readonly weight: number;
}

/** One material-bucketed triangle range within the mesh. */
export interface MeshTriangleGroup {
    /** Index into the mesh's `materials` array (which material to bind for this batch). */
    readonly materialIndex: number;
    /** First triangle of the batch (index into the mesh's triangle list). */
    readonly triFirst: number;
    /** Number of triangles in the batch. */
    readonly triCount: number;
}

/** Material metadata + the first associated texture (file name + size). */
export interface MaterialInfo {
    /** 0-based index in the GR2 file's Materials array. */
    readonly index: number;
    /** Material name from the Granny file (defaults to `Material_<index>` if missing). */
    readonly name: string;
    /** Texture file name as authored (empty when the material has no Texture / Maps). */
    readonly textureFile: string;
    /** `[width, height]` in pixels when the Texture sub-object declares them ; `null` otherwise. */
    readonly textureSize: readonly [number, number] | null;
}

/** A fully decoded mesh ready for the renderer. */
export interface MeshGeometry {
    /** Mesh name from the Granny file (defaults to `Mesh_<index>` if missing). */
    readonly name: string;
    /** Number of vertices in the vertex buffer. */
    readonly vertexCount: number;
    /** Number of indices in the index buffer (always divisible by 3 for triangle meshes). */
    readonly indexCount: number;
    /** Bytes per vertex row in the source vertex buffer. */
    readonly vertexStride: number;
    /** Declared vertex layout components in source order. */
    readonly components: readonly VertexComponent[];
    /** Per-vertex `[x, y, z]` positions (empty when the mesh has no Position component). */
    readonly positions: readonly (readonly [number, number, number])[];
    /** Per-vertex `[x, y, z]` normals (empty when the mesh has no Normal component). */
    readonly normals: readonly (readonly [number, number, number])[];
    /** Per-vertex `[u, v]` texture coordinates (empty when no `TextureCoordinates*` component). */
    readonly uvs: readonly (readonly [number, number])[];
    /** Index buffer (16- or 32-bit indices, decoded to JS numbers). */
    readonly indices: readonly number[];
    /** Mesh-local bone binding table (skinning weight `boneIndex` references this array). */
    readonly boneBindings: readonly BoneBinding[];
    /** Per-vertex bone-weight list (outer length = `vertexCount` ; inner up to ~4 entries). */
    readonly vertexWeights: readonly (readonly VertexBoneWeight[])[];
    /** Material references the mesh declares it uses (one entry per binding slot). */
    readonly materials: readonly MaterialInfo[];
    /** Triangle batches grouped by material. */
    readonly triangleGroups: readonly MeshTriangleGroup[];
}

/** Options for {@link extractMeshes}. */
export interface ExtractMeshesOptions {
    /** Cap on the number of meshes extracted (defaults to 32). */
    readonly maxMeshes?: number;
    /** Cap on the number of materials looked up (defaults to 4096). */
    readonly maxMaterials?: number;
    /** Cap on the number of bone bindings / material bindings per mesh (defaults to 4096). */
    readonly maxBones?: number;
}

/**
 * Walk `root.Meshes` and decode every static mesh into a renderable
 * `MeshGeometry`. Returns `[]` for fixtures without meshes.
 */
export function extractMeshes(
    loaded: LoadedGR2,
    options?: ExtractMeshesOptions,
): readonly MeshGeometry[];

/** Options for {@link extractMaterials}. */
export interface ExtractMaterialsOptions {
    /** Cap on the number of materials extracted (defaults to 4096). */
    readonly maxMaterials?: number;
}

/**
 * Walk `root.Materials` and return one {@link MaterialInfo} per top-level
 * material in source order. Returns `[]` for fixtures without materials.
 * For per-mesh material binding, use {@link extractMeshes} (which builds
 * its own internal lookup off the same walk).
 */
export function extractMaterials(
    loaded: LoadedGR2,
    options?: ExtractMaterialsOptions,
): readonly MaterialInfo[];
