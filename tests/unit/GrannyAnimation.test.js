// Unit tests for the GR2 animation extractor + curve evaluator.
//
// Three pass kinds :
//   - Parametric coverage on all 21 fixtures via manifest.json :
//     · 15 animation fixtures → ≥ 1 animation with ≥ 1 track group +
//       ≥ 1 TransformTrack, duration > 0, finite curve knots, sane
//       evaluator output (no NaN, normalized quaternion).
//     · 6 model fixtures → shape-valid `Animation[]` (may be empty
//       for pure model assets, otherwise sanity-check only).
//   - Codec helpers : table lookups + B-spline coefficients verified in
//     isolation (no fixture I/O) — fast feedback when a numeric
//     formula drifts.
//   - Inline snapshot on the smallest animation fixture (2_damage.gr2)
//     covering animation meta + first track + first curve format.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import {
    extractAnimations,
    evaluateTransformTrack,
    evaluateAnimation,
    __test__,
} from '../../src/GrannyAnimation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const SMALL_ANIM = '2_damage.gr2';
const SMALL_ANIM_PATH = resolve(FIXTURE_DIR, SMALL_ANIM);

const haveManifest = existsSync(MANIFEST_PATH);
const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [] };

const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;
const animationFixtures = manifest.fixtures.filter((f) => ANIMATION_RX.test(f.name));
const modelFixtures = manifest.fixtures.filter((f) => !ANIMATION_RX.test(f.name));

function loadFixture(name) {
    const buf = readFileSync(resolve(FIXTURE_DIR, name));
    return loadGR2(parseGR2File(buf));
}

function isFiniteNumber(v) {
    return typeof v === 'number' && Number.isFinite(v);
}

describe.skipIf(!haveManifest)('extractAnimations — animation fixtures', () => {
    for (const fixture of animationFixtures) {
        it(`${fixture.name} returns at least one well-formed animation`, () => {
            const animations = extractAnimations(loadFixture(fixture.name));
            expect(animations.length).toBeGreaterThan(0);
            for (const animation of animations) {
                expect(typeof animation.name).toBe('string');
                expect(isFiniteNumber(animation.duration)).toBe(true);
                expect(animation.duration).toBeGreaterThan(0);
                expect(animation.trackGroups.length).toBeGreaterThan(0);
                // At least one track in the animation must carry an
                // actual curve (else the file isn't really animated).
                // Individual tracks are allowed to have all-null curves
                // for non-animated root bones (e.g. `Dummy01`).
                let curvesSeen = 0;
                for (const group of animation.trackGroups) {
                    expect(typeof group.name).toBe('string');
                    expect(group.transformTracks.length).toBeGreaterThan(0);
                    for (const track of group.transformTracks) {
                        expect(typeof track.name).toBe('string');
                        expect(track.name).toMatch(/^[\x20-\x7e]+$/);
                        const present = [
                            track.positionCurve,
                            track.orientationCurve,
                            track.scaleShearCurve,
                        ].filter((c) => c !== null);
                        curvesSeen += present.length;
                        // Knots are finite + non-negative.
                        for (const curve of present) {
                            for (let i = 0; i < curve.knots.length; i++) {
                                expect(isFiniteNumber(curve.knots[i])).toBe(true);
                                expect(curve.knots[i]).toBeGreaterThanOrEqual(0);
                            }
                            for (let i = 0; i < curve.controls.length; i++) {
                                expect(isFiniteNumber(curve.controls[i])).toBe(true);
                            }
                        }
                    }
                }
                expect(curvesSeen).toBeGreaterThan(0);
            }
        });
    }
});

describe.skipIf(!haveManifest)('extractAnimations — model fixtures', () => {
    // Pure model fixtures may carry zero animations OR a minimal rest
    // animation. We sanity-check shape + finiteness only.
    for (const fixture of modelFixtures) {
        it(`${fixture.name} returns a well-formed animation array`, () => {
            const animations = extractAnimations(loadFixture(fixture.name));
            expect(Array.isArray(animations)).toBe(true);
            for (const animation of animations) {
                expect(typeof animation.name).toBe('string');
                expect(isFiniteNumber(animation.duration)).toBe(true);
                for (const group of animation.trackGroups) {
                    expect(typeof group.name).toBe('string');
                    for (const track of group.transformTracks) {
                        expect(typeof track.name).toBe('string');
                    }
                }
            }
        });
    }
});

describe.skipIf(!haveManifest)('evaluateTransformTrack — curve sampling', () => {
    for (const fixture of animationFixtures) {
        it(`${fixture.name} samples without NaN at t = duration/2`, () => {
            const animations = extractAnimations(loadFixture(fixture.name));
            const animation = animations[0];
            const t = animation.duration * 0.5;
            const group = animation.trackGroups[0];
            const transform = evaluateTransformTrack(group.transformTracks[0], t);
            expect(transform.position).toHaveLength(3);
            expect(transform.orientation).toHaveLength(4);
            expect(transform.scaleShear).toHaveLength(9);
            for (const v of transform.position) expect(isFiniteNumber(v)).toBe(true);
            for (const v of transform.orientation) expect(isFiniteNumber(v)).toBe(true);
            for (const v of transform.scaleShear) expect(isFiniteNumber(v)).toBe(true);
            // Quaternion must be ~ unit length.
            const q = transform.orientation;
            const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
            expect(Math.abs(len - 1.0)).toBeLessThan(1e-3);
        });
    }
});

describe.skipIf(!haveManifest)('evaluateAnimation — full pose at t', () => {
    for (const fixture of animationFixtures) {
        it(`${fixture.name} produces a name→transform map`, () => {
            const animations = extractAnimations(loadFixture(fixture.name));
            const animation = animations[0];
            const pose = evaluateAnimation(animation, animation.duration * 0.25);
            const names = Object.keys(pose);
            expect(names.length).toBeGreaterThan(0);
            for (const name of names) {
                expect(pose[name].position).toHaveLength(3);
                expect(pose[name].orientation).toHaveLength(4);
                expect(pose[name].scaleShear).toHaveLength(9);
            }
        });
    }
});

describe('codec helpers — table + arithmetic', () => {
    const {
        floatFromHighU16,
        quaternionScalesOffsets,
        curveDimension,
        findKnot,
        safeDiv,
        linearCoefficients,
        quadraticCoefficients,
        normalizeQuaternion,
    } = __test__;

    it('curveDimension parses Dn prefix', () => {
        expect(curveDimension('D3K16uC16u')).toBe(3);
        expect(curveDimension('D4nK8uC7u')).toBe(4);
        expect(curveDimension('D9I3K16uC15uBw4')).toBe(9);
        expect(curveDimension('DaIdentity')).toBe(0);
        expect(curveDimension('LegacyCurve32f')).toBe(0);
    });

    it('findKnot returns first knot > t (clamped)', () => {
        const knots = new Float32Array([0, 1, 2, 3]);
        expect(findKnot(knots, -1)).toBe(0);
        expect(findKnot(knots, 0.5)).toBe(1);
        expect(findKnot(knots, 2)).toBe(3);
        expect(findKnot(knots, 5)).toBe(3);
        expect(findKnot(new Float32Array([]), 0)).toBe(0);
    });

    it('safeDiv guards against tiny denominators', () => {
        expect(safeDiv(10, 2)).toBe(5);
        expect(safeDiv(10, 1e-13)).toBe(0);
        expect(safeDiv(0, 0)).toBe(0);
    });

    it('linearCoefficients sums to 1', () => {
        const [a, b] = linearCoefficients(0, 1, 0.25);
        expect(a + b).toBeCloseTo(1.0);
        expect(b).toBeCloseTo(0.25);
    });

    it('quadraticCoefficients basis sums to 1 at interior t', () => {
        const [a, b, c] = quadraticCoefficients(0, 1, 2, 3, 1.5);
        expect(a + b + c).toBeCloseTo(1.0);
    });

    it('normalizeQuaternion produces unit length', () => {
        const q = normalizeQuaternion([1, 1, 1, 1]);
        const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
        expect(len).toBeCloseTo(1.0);
    });

    it('normalizeQuaternion preserves zero-length input', () => {
        const q = normalizeQuaternion([0, 0, 0, 0]);
        expect(q).toEqual([0, 0, 0, 0]);
    });

    it('floatFromHighU16 promotes u16 to high f32 bits', () => {
        // Reference value : 0x3f80 → high-16 of 0x3f800000 (1.0f).
        expect(floatFromHighU16(0x3f80)).toBeCloseTo(1.0);
        expect(floatFromHighU16(0x4040)).toBeCloseTo(3.0);
    });

    it('quaternionScalesOffsets unpacks 4 nibbles', () => {
        const { scales, offsets } = quaternionScalesOffsets(0x0000, 127.0);
        expect(scales).toHaveLength(4);
        expect(offsets).toHaveLength(4);
        // Entry 0 : scale ≈ √2, offset ≈ -1/√2
        expect(scales[0]).toBeCloseTo(Math.SQRT2 / 127.0, 4);
        expect(offsets[0]).toBeCloseTo(-1 / Math.SQRT2, 4);
    });
});

describe.skipIf(!existsSync(SMALL_ANIM_PATH))(`extractAnimations — ${SMALL_ANIM} snapshot`, () => {
    it('matches a stable meta snapshot for the smallest animation fixture', () => {
        const animations = extractAnimations(loadFixture(SMALL_ANIM));
        expect(animations.length).toBeGreaterThan(0);
        const animation = animations[0];
        const group = animation.trackGroups[0];
        const track = group.transformTracks[0];
        const firstCurve = track.orientationCurve ?? track.positionCurve ?? track.scaleShearCurve;
        expect(firstCurve).not.toBeNull();
        expect({
            animationName: animation.name,
            trackGroupCount: animation.trackGroups.length,
            trackGroupName: group.name,
            transformTrackCount: group.transformTracks.length,
            firstTrackName: track.name,
            firstCurveCodec: firstCurve.codec,
            firstCurveDegree: firstCurve.degree,
            firstCurveDimension: firstCurve.dimension,
            firstCurveKnotCount: firstCurve.knots.length,
        }).toMatchSnapshot();
    });
});
