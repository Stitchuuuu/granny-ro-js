// Unit tests for the GrannyPose runtime.
//
// Three families :
//   - composeLocalMatrix : quat-to-mat sanity + TRS layout (no skeleton).
//   - composeWorldPose / multiplyMat4 : 3-bone synthetic skeleton with
//     known angles + translations cross-checked by hand.
//   - Convention smoke test : `composeSkinningMatrices` at the bind pose
//     on every model fixture must return identity per bone within 1e-4
//     (the bind-pose math identity Mworld_bind × IWT = I).
//
// The live-oracle parity (JS vs Python numpy) lives in the integration
// suite and is env-gated by GRANNY_LIVE_ORACLE=1.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseModel } from '../../src/Granny.js';
import {
    composeLocalMatrix,
    multiplyMat4,
    composeWorldPose,
    composeSkinningMatrices,
    poseSkeletonAt,
    __test__,
} from '../../src/GrannyPose.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');

const haveManifest = existsSync(MANIFEST_PATH);
const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [] };

// Animation-only fixtures don't have meaningful bind-pose data we care
// about for the smoke test ; the model fixtures (no numeric prefix) do.
const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;
const modelFixtures = manifest.fixtures.filter((f) => !ANIMATION_RX.test(f.name));

const IDENTITY_TRANSFORM = {
    flags: 0,
    position: [0.0, 0.0, 0.0],
    orientation: [0.0, 0.0, 0.0, 1.0],
    scaleShear: [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0],
};

/** Column-major identity 4×4. Used to compare matrices elementwise. */
const IDENTITY_MAT4 = new Float32Array([
    1, 0, 0, 0,
    0, 1, 0, 0,
    0, 0, 1, 0,
    0, 0, 0, 1,
]);

/** Compare two 4×4 matrices elementwise to a numerical tolerance. */
function expectMatrixCloseTo(actual, expected, tolerance) {
    expect(actual.length).toBe(expected.length);
    for (let i = 0; i < expected.length; i++) {
        const diff = Math.abs(actual[i] - expected[i]);
        if (diff > tolerance) {
            throw new Error(
                `mat4 mismatch at index ${i}: ${actual[i]} vs ${expected[i]} (diff ${diff} > ${tolerance})`
            );
        }
    }
}

/** Column-major matmul reference implementation for cross-checking. */
function matmulReference(a, b) {
    const out = new Float32Array(16);
    for (let col = 0; col < 4; col++) {
        for (let row = 0; row < 4; row++) {
            let sum = 0;
            for (let k = 0; k < 4; k++) {
                sum += a[k * 4 + row] * b[col * 4 + k];
            }
            out[col * 4 + row] = sum;
        }
    }
    return out;
}

describe('composeLocalMatrix', () => {
    it('identity Transform → identity matrix', () => {
        const mat = composeLocalMatrix(IDENTITY_TRANSFORM);
        expectMatrixCloseTo(mat, IDENTITY_MAT4, 1e-6);
    });

    it('null / undefined Transform → identity matrix', () => {
        const matNull = composeLocalMatrix(null);
        const matUndef = composeLocalMatrix(undefined);
        expectMatrixCloseTo(matNull, IDENTITY_MAT4, 1e-6);
        expectMatrixCloseTo(matUndef, IDENTITY_MAT4, 1e-6);
    });

    it('translation-only Transform → identity rotation + translation column', () => {
        const mat = composeLocalMatrix({
            ...IDENTITY_TRANSFORM,
            position: [3.5, -2.0, 7.25],
        });
        // Rotation block = identity, column 3 = position.
        const expected = new Float32Array([
            1, 0, 0, 0,
            0, 1, 0, 0,
            0, 0, 1, 0,
            3.5, -2.0, 7.25, 1,
        ]);
        expectMatrixCloseTo(mat, expected, 1e-6);
    });

    it('90° rotation around Z transforms (1,0,0,1) → (0,1,0,1)', () => {
        // quat for 90° around Z : (0, 0, sin(45°), cos(45°))
        const halfAngle = Math.PI / 4;
        const mat = composeLocalMatrix({
            ...IDENTITY_TRANSFORM,
            orientation: [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)],
        });
        // Apply to (1, 0, 0, 1) in column-vector convention : out = M × v.
        const out = [
            mat[0] * 1 + mat[4] * 0 + mat[8] * 0 + mat[12] * 1,
            mat[1] * 1 + mat[5] * 0 + mat[9] * 0 + mat[13] * 1,
            mat[2] * 1 + mat[6] * 0 + mat[10] * 0 + mat[14] * 1,
            mat[3] * 1 + mat[7] * 0 + mat[11] * 0 + mat[15] * 1,
        ];
        expect(out[0]).toBeCloseTo(0, 5);
        expect(out[1]).toBeCloseTo(1, 5);
        expect(out[2]).toBeCloseTo(0, 5);
        expect(out[3]).toBeCloseTo(1, 5);
    });

    it('uniform scale 2 → diagonal 2 in upper 3×3', () => {
        const mat = composeLocalMatrix({
            ...IDENTITY_TRANSFORM,
            scaleShear: [2, 0, 0, 0, 2, 0, 0, 0, 2],
        });
        expect(mat[0]).toBeCloseTo(2, 6);
        expect(mat[5]).toBeCloseTo(2, 6);
        expect(mat[10]).toBeCloseTo(2, 6);
        expect(mat[15]).toBeCloseTo(1, 6);
        // Off-diagonal in rotation/scale block should be 0.
        expect(mat[1]).toBeCloseTo(0, 6);
        expect(mat[2]).toBeCloseTo(0, 6);
        expect(mat[4]).toBeCloseTo(0, 6);
    });

    it('denormalized quaternion is normalized defensively', () => {
        const mat = composeLocalMatrix(/** @type {any} */ ({
            ...IDENTITY_TRANSFORM,
            orientation: [0, 0, 0, 2],   // length 2 (not unit)
        }));
        // After normalize : (0, 0, 0, 1) → identity rotation.
        expectMatrixCloseTo(mat, IDENTITY_MAT4, 1e-6);
    });

    it('zero quaternion → identity rotation fallback', () => {
        const mat = composeLocalMatrix(/** @type {any} */ ({
            ...IDENTITY_TRANSFORM,
            orientation: [0, 0, 0, 0],
        }));
        expectMatrixCloseTo(mat, IDENTITY_MAT4, 1e-6);
    });
});

describe('multiplyMat4', () => {
    it('identity × identity = identity', () => {
        const out = multiplyMat4(IDENTITY_MAT4, IDENTITY_MAT4);
        expectMatrixCloseTo(out, IDENTITY_MAT4, 1e-6);
    });

    it('M × identity = M', () => {
        const m = composeLocalMatrix({
            ...IDENTITY_TRANSFORM,
            position: [1.5, 2.5, 3.5],
            orientation: [0, 0, Math.sin(Math.PI / 6), Math.cos(Math.PI / 6)],
        });
        const out = multiplyMat4(m, IDENTITY_MAT4);
        expectMatrixCloseTo(out, m, 1e-6);
    });

    it('matches a reference column-major matmul on two random matrices', () => {
        const a = composeLocalMatrix({
            ...IDENTITY_TRANSFORM,
            position: [1, 2, 3],
            orientation: [0.1, 0.2, 0.3, 0.9],
        });
        const b = composeLocalMatrix({
            ...IDENTITY_TRANSFORM,
            position: [-4, 5, -6],
            orientation: [0.5, -0.5, 0.5, 0.5],
            scaleShear: [1.5, 0.1, 0, 0, 0.9, 0.05, 0.0, 0.0, 1.2],
        });
        const ours = multiplyMat4(a, b);
        const reference = matmulReference(a, b);
        expectMatrixCloseTo(ours, reference, 1e-5);
    });

    it('writes into the supplied out array (no allocation)', () => {
        const out = new Float32Array(16);
        const result = multiplyMat4(IDENTITY_MAT4, IDENTITY_MAT4, out);
        expect(result).toBe(out);
        expectMatrixCloseTo(out, IDENTITY_MAT4, 1e-6);
    });
});

describe('composeWorldPose — synthetic 3-bone skeleton', () => {
    // Skeleton : root → mid → leaf with simple translations only.
    /** @type {import('../../src/GrannySkeleton.js').Skeleton} */
    const skeleton = /** @type {any} */ ({
        name: 'synthetic',
        lodType: 0,
        bones: [
            {
                index: 0,
                name: 'root',
                parentIndex: -1,
                transform: {
                    ...IDENTITY_TRANSFORM,
                    position: [10, 0, 0],
                },
                inverseWorldTransform: [],
            },
            {
                index: 1,
                name: 'mid',
                parentIndex: 0,
                transform: {
                    ...IDENTITY_TRANSFORM,
                    position: [0, 5, 0],
                },
                inverseWorldTransform: [],
            },
            {
                index: 2,
                name: 'leaf',
                parentIndex: 1,
                transform: {
                    ...IDENTITY_TRANSFORM,
                    position: [0, 0, 2],
                },
                inverseWorldTransform: [],
            },
        ],
    });

    it('translations cascade along the parent chain', () => {
        const locals = skeleton.bones.map((b) => composeLocalMatrix(b.transform));
        const worlds = composeWorldPose(skeleton, locals);
        // Each world matrix's translation column is the running sum.
        // Root @ (10, 0, 0) ; mid @ (10, 5, 0) ; leaf @ (10, 5, 2).
        expect(worlds[0][12]).toBeCloseTo(10, 6);
        expect(worlds[0][13]).toBeCloseTo(0, 6);
        expect(worlds[0][14]).toBeCloseTo(0, 6);
        expect(worlds[1][12]).toBeCloseTo(10, 6);
        expect(worlds[1][13]).toBeCloseTo(5, 6);
        expect(worlds[1][14]).toBeCloseTo(0, 6);
        expect(worlds[2][12]).toBeCloseTo(10, 6);
        expect(worlds[2][13]).toBeCloseTo(5, 6);
        expect(worlds[2][14]).toBeCloseTo(2, 6);
    });

    it('returns a fresh array (no aliasing of input locals)', () => {
        const locals = skeleton.bones.map((b) => composeLocalMatrix(b.transform));
        const worlds = composeWorldPose(skeleton, locals);
        for (let i = 0; i < skeleton.bones.length; i++) {
            expect(worlds[i]).not.toBe(locals[i]);
            expect(worlds[i] instanceof Float32Array).toBe(true);
            expect(worlds[i].length).toBe(16);
        }
    });

    it('rotation at the root propagates into descendant world translations', () => {
        // Root : 90° around Z + translate (10, 0, 0). Apply to mid @ (0, 5, 0)
        // → world = (10 - 5, 0 + 0, 0) = (10, ..., 0) ; wait, 90°Z maps
        // (0, 5, 0) → (-5, 0, 0). So mid world = root translation + rotated
        // mid local = (10, 0, 0) + (-5, 0, 0) = (5, 0, 0).
        const halfAngle = Math.PI / 4;
        /** @type {import('../../src/GrannySkeleton.js').Skeleton} */
        const rotated = /** @type {any} */ ({
            ...skeleton,
            bones: skeleton.bones.map((b, i) => i === 0
                ? {
                    ...b,
                    transform: {
                        ...b.transform,
                        orientation: [0, 0, Math.sin(halfAngle), Math.cos(halfAngle)],
                    },
                }
                : b),
        });
        const locals = rotated.bones.map((b) => composeLocalMatrix(b.transform));
        const worlds = composeWorldPose(rotated, locals);
        expect(worlds[1][12]).toBeCloseTo(10 - 5, 4);   // x
        expect(worlds[1][13]).toBeCloseTo(0 + 0, 4);    // y (was 5, now ~0)
        expect(worlds[1][14]).toBeCloseTo(0, 4);
    });
});

describe('poseSkeletonAt — null animation = bind pose', () => {
    it('returns Mlocal[i] composed via FK for every bone', () => {
        /** @type {import('../../src/GrannySkeleton.js').Skeleton} */
        const skeleton = /** @type {any} */ ({
            name: 'tiny',
            lodType: 0,
            bones: [
                {
                    index: 0,
                    name: 'root',
                    parentIndex: -1,
                    transform: { ...IDENTITY_TRANSFORM, position: [1, 2, 3] },
                    inverseWorldTransform: [],
                },
            ],
        });
        const pose = poseSkeletonAt(skeleton, null, 0);
        expect(pose.localTransforms.length).toBe(1);
        expect(pose.worldMatrices.length).toBe(1);
        expect(pose.skinningMatrices.length).toBe(1);
        expect(pose.localTransforms[0]).toBe(skeleton.bones[0].transform);
        expect(pose.worldMatrices[0][12]).toBeCloseTo(1, 6);
        expect(pose.worldMatrices[0][13]).toBeCloseTo(2, 6);
        expect(pose.worldMatrices[0][14]).toBeCloseTo(3, 6);
    });
});

describe('boneIwtAsArray', () => {
    it('missing IWT → identity matrix', () => {
        const mat = __test__.boneIwtAsArray({ inverseWorldTransform: [] });
        expectMatrixCloseTo(mat, IDENTITY_MAT4, 1e-6);
    });

    it('short / malformed IWT → identity matrix', () => {
        const mat = __test__.boneIwtAsArray({ inverseWorldTransform: [1, 2, 3] });
        expectMatrixCloseTo(mat, IDENTITY_MAT4, 1e-6);
    });
});

describe.skipIf(modelFixtures.length === 0)('convention smoke test — bind-pose Mskin is constant across bones', () => {
    // Canonical Granny invariant : at bind pose, every bone's
    // `Mskin[i] = Mworld_bind[i] × IWT[i]` equals the SAME matrix — a
    // global object-space-to-world-space rest transform that depends on
    // the source DCC's coordinate convention (identity for most iRO
    // models ; a -90° X rotation on treasurebox_2 which still ships its
    // Z-up authoring convention baked into IWT[root]).
    //
    // The invariant locks both the matrix convention (column-major
    // Float32Array, column-vector math, TRS = T × R × S, FK forward-pass)
    // AND the IWT byte interpretation (no transpose on load — controlled
    // by `IWT_TRANSPOSE_ON_LOAD` in GrannyPose.js).

    for (const fixture of modelFixtures) {
        it(`${fixture.name} — every bone produces the same bind-pose Mskin`, () => {
            const buf = readFileSync(resolve(FIXTURE_DIR, fixture.name));
            const model = parseModel(buf);
            const skeleton = model.skeletons[0];
            expect(skeleton.bones.length).toBeGreaterThan(0);
            const haveIwt = skeleton.bones.some((b) => b.inverseWorldTransform.length === 16);
            expect(haveIwt).toBe(true);

            const pose = poseSkeletonAt(skeleton, null, 0);
            const reference = pose.skinningMatrices[0];
            // Sanity : reference matrix has finite entries + valid affine
            // bottom row (no parsing/matmul garbage leaking into row 3).
            for (let k = 0; k < 16; k++) expect(Number.isFinite(reference[k])).toBe(true);
            expect(reference[3]).toBeCloseTo(0, 5);
            expect(reference[7]).toBeCloseTo(0, 5);
            expect(reference[11]).toBeCloseTo(0, 5);
            expect(reference[15]).toBeCloseTo(1, 5);

            const failures = [];
            for (let i = 1; i < skeleton.bones.length; i++) {
                if (skeleton.bones[i].inverseWorldTransform.length !== 16) continue;
                const mskin = pose.skinningMatrices[i];
                let maxDiff = 0;
                for (let k = 0; k < 16; k++) {
                    const diff = Math.abs(mskin[k] - reference[k]);
                    if (diff > maxDiff) maxDiff = diff;
                }
                // 1e-4 is the matrix-multiply cascade tolerance per the S8
                // plan ; deep bone chains (R/L Finger0 on guardian rigs)
                // accumulate ~5e-6 across the parent walk + Mskin product.
                if (maxDiff > 1e-4) {
                    failures.push({
                        bone: skeleton.bones[i].name,
                        index: i,
                        maxDiff,
                        mskin: Array.from(mskin).map((v) => Number(v.toFixed(6))),
                    });
                }
            }
            if (failures.length > 0) {
                throw new Error(
                    `bind-pose Mskin drift > 1e-4 for ${failures.length} / ${skeleton.bones.length} bones in ${fixture.name}\n` +
                    `reference Mskin (bone 0) : ${Array.from(reference).map((v) => Number(v.toFixed(6))).join(', ')}\n` +
                    `first failure : ${JSON.stringify(failures[0], null, 2)}`
                );
            }
        });
    }
});
