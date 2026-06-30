// GrannySkeleton.js — Skeleton + bone extraction from a loaded GR2.
//
// JS port of Rasetsuu/blendergranny io_scene_gr2/gr2/skeleton.py.
// Pre-condition : `loaded` must come from `GrannyTypeTree.loadGR2(file)`.
//
// Public surface : a single `extractSkeletons(loaded, options)` returning
// an array of `Skeleton`. Each skeleton carries its bones with their
// parent-index, local Transform (68-byte fixed struct : flags u32 +
// position[3] + orientation[4] + scaleShear[9] f32), and the 16-float
// InverseWorldTransform 4×4 used by the renderer for skinning.
//
// Animation-only fixtures (no `root.Skeletons` ; or empty `element_refs`)
// resolve to `[]` — assertion target for the parametric test suite.
//
// Public-API types : see ./GrannySkeleton.d.ts (sibling).

import { parseTypeTree, parseObject, readReferenceArrayObjects } from './GrannyTypeTree.js';
import { IDENTITY_TRANSFORM, readTransform } from './GrannyTransform.js';

/**
 * Walk `root.Skeletons` and return every skeleton with its bones, local
 * Transforms, and InverseWorldTransform 4×4. Returns `[]` for fixtures
 * that don't carry any skeleton (animation-only files in the iRO corpus).
 */
export function extractSkeletons(loaded, options = {}) {
    const maxSkeletons = options.maxSkeletons ?? 16;
    const maxBones = options.maxBones ?? 4096;

    const file = loaded.file;
    const rootTypeRef = file.header.root_type;
    const rootObjectRef = file.header.root_object;
    const rootTypeTree = parseTypeTree(loaded, rootTypeRef);
    const root = parseObject(loaded, rootTypeTree, rootObjectRef, { maxArrayRefs: maxSkeletons });

    const skeletonField = root.Skeletons;
    if (!skeletonField) return [];
    const skeletonType = skeletonField.reference_type ?? null;
    const elementRefs = skeletonField.element_refs ?? [];
    if (skeletonType === null || elementRefs.length === 0) return [];

    const skeletons = [];
    const skeletonTypeMembers = parseTypeTree(loaded, [skeletonType.section, skeletonType.offset]);
    const limit = elementRefs.length < maxSkeletons ? elementRefs.length : maxSkeletons;
    for (let i = 0; i < limit; i++) {
        const skeletonRef = elementRefs[i];
        if (!skeletonRef) continue;
        const fields = parseObject(
            loaded,
            skeletonTypeMembers,
            [skeletonRef.section, skeletonRef.offset],
            { maxArrayRefs: maxBones },
        );
        const boneField = fields.Bones;
        const boneTarget = boneField?.target ?? null;
        const boneType = boneField?.reference_type ?? null;
        const boneCount = boneField?.count ?? 0;
        const boneObjects = readReferenceArrayObjects(
            loaded,
            boneTarget,
            boneCount,
            boneType,
            { maxCount: maxBones },
        );

        const bones = new Array(boneObjects.length);
        for (let b = 0; b < boneObjects.length; b++) {
            bones[b] = readBone(loaded, b, boneObjects[b]);
        }

        const nameValue = fields.Name?.value;
        const lodTypeValue = fields.LODType?.value;
        skeletons.push({
            name: typeof nameValue === 'string' && nameValue ? nameValue : `Skeleton_${skeletons.length}`,
            bones,
            lodType: typeof lodTypeValue === 'number' ? lodTypeValue : 0,
        });
    }
    return skeletons;
}

/**
 * Materialize one `SkeletonBone` from a `readReferenceArrayObjects`
 * element. The bone's Transform and InverseWorldTransform live as raw
 * bytes at field-offsets inside the bone object's section — we read 68
 * bytes for the Transform (flags u32 + 16 f32) and 64 bytes for the
 * InverseWorldTransform (16 f32).
 */
function readBone(loaded, index, boneObject) {
    const { ref, fields } = boneObject;
    const nameValue = fields.Name?.value;
    const parentValue = fields.ParentIndex?.value;
    const transformOffset = fields.Transform?.offset ?? 0;
    const inverseOffset = fields.InverseWorldTransform?.offset ?? 0;

    let transform = IDENTITY_TRANSFORM;
    let inverseWorldTransform = [];
    if (ref) {
        transform = readTransform(loaded, ref.section, transformOffset);
        inverseWorldTransform = readReal32Array(loaded, ref.section, inverseOffset, 16);
    }

    return {
        index,
        name: typeof nameValue === 'string' && nameValue ? nameValue : `Bone_${index}`,
        parentIndex: typeof parentValue === 'number' ? parentValue : -1,
        transform,
        inverseWorldTransform,
    };
}

/**
 * Read `count` f32 values from `loaded.sectionsOriginal` at `(section,
 * offset)`. Returns `[]` if the range escapes the section.
 */
function readReal32Array(loaded, section, offset, count) {
    const data = loaded.sectionsOriginal[section];
    if (!data || offset < 0 || offset + count * 4 > data.length) return [];
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const out = new Array(count);
    for (let i = 0; i < count; i++) {
        out[i] = view.getFloat32(offset + i * 4, true);
    }
    return out;
}
