/**
 * Public type for the 68-byte fixed Granny Transform struct.
 * `flags u32 + position[3] f32 + orientation[4] f32 + scaleShear[9] f32`.
 */
export interface Transform {
    /** Granny TRANSFORM_FLAGS bitmask (HAS_POSITION / HAS_ORIENTATION / HAS_SCALESHEAR). */
    flags: number;
    /** xyz translation. */
    position: number[];
    /** xyzw rotation quaternion. */
    orientation: number[];
    /** Row-major 3×3 scale + shear matrix (9 floats). */
    scaleShear: number[];
}

/**
 * Identity transform — frozen, safe to share across callers.
 */
export const IDENTITY_TRANSFORM: Readonly<Transform>;

/**
 * Read the 68-byte fixed Transform struct from `loaded.sectionsOriginal`
 * at `(section, offset)`. Returns the identity transform if the address
 * falls outside the section.
 */
export function readTransform(loaded: unknown, section: number, offset: number): Transform;
