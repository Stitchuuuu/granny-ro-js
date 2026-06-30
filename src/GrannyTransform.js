// GrannyTransform.js — 68-byte fixed Transform struct decoder.
//
// Single source of truth for the Granny Transform layout used by both
// `GrannyTypeTree.parseObject` (when materializing an MT_TRANSFORM
// field) and `GrannySkeleton.extractSkeletons` (when reading the raw
// SkeletonBone.Transform bytes from `loaded.sectionsOriginal`).
//
// Layout : `flags u32 + position[3] f32 + orientation[4] f32 +
// scaleShear[9] f32` = 4 + 12 + 16 + 36 = 68 bytes, little-endian.

/**
 * Frozen identity transform — returned when the address falls outside
 * the section's byte range. Safe to share across callers (immutable).
 */
export const IDENTITY_TRANSFORM = Object.freeze({
    flags: 0,
    position: [0.0, 0.0, 0.0],
    orientation: [0.0, 0.0, 0.0, 1.0],
    scaleShear: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
});

/**
 * Read the 68-byte fixed Transform struct from `loaded.sectionsOriginal`
 * at `(section, offset)`. Returns the identity transform if the address
 * falls outside the section.
 *
 * @param {object} loaded — output of `loadGR2(file)`
 * @param {number} section — section index into `loaded.sectionsOriginal`
 * @param {number} offset — byte offset into the section
 * @returns {{ flags: number, position: number[], orientation: number[], scaleShear: number[] }}
 */
export function readTransform(loaded, section, offset) {
    const data = loaded.sectionsOriginal[section];
    if (!data || offset < 0 || offset + 68 > data.length) return IDENTITY_TRANSFORM;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const flags = view.getUint32(offset, true);
    const values = new Array(16);
    for (let i = 0; i < 16; i++) {
        values[i] = view.getFloat32(offset + 4 + i * 4, true);
    }
    return {
        flags,
        position:   [values[0], values[1], values[2]],
        orientation: [values[3], values[4], values[5], values[6]],
        scaleShear: [values[7], values[8], values[9],
                     values[10], values[11], values[12],
                     values[13], values[14], values[15]],
    };
}
