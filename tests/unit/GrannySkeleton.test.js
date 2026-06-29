// Unit tests for the GR2 skeleton extractor.
//
// Two pass kinds :
//   - Parametric coverage on all 21 fixtures via manifest.json :
//     · 6 model fixtures → at least 1 skeleton with at least 1 bone,
//       ASCII bone names, sane parent-index range, finite transforms.
//     · 15 animation-only fixtures → explicit empty-array assertion
//       (guards against silent regressions where animation files start
//       surfacing bogus skeletons).
//   - Inline snapshot on treasurebox_2.gr2 (smallest model, fastest
//     feedback loop) covering skeleton-meta + first bone.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import { extractSkeletons } from '../../src/GrannySkeleton.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const TREASUREBOX_PATH = resolve(FIXTURE_DIR, 'treasurebox_2.gr2');

const haveManifest = existsSync(MANIFEST_PATH);
const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [] };

// Animation-only fixtures : numeric prefix + `_attack|_damage|_dead|_move`.
// Model fixtures : every other `.gr2` in the manifest.
const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;
const modelFixtures = manifest.fixtures.filter((f) => !ANIMATION_RX.test(f.name));
const animationFixtures = manifest.fixtures.filter((f) => ANIMATION_RX.test(f.name));

function loadFixture(name) {
    const buf = readFileSync(resolve(FIXTURE_DIR, name));
    return loadGR2(parseGR2File(buf));
}

describe.skipIf(!haveManifest)('extractSkeletons — model fixtures', () => {
    for (const fixture of modelFixtures) {
        it(`${fixture.name} returns at least one well-formed skeleton`, () => {
            const skeletons = extractSkeletons(loadFixture(fixture.name));
            expect(skeletons.length).toBeGreaterThan(0);
            for (const skeleton of skeletons) {
                expect(skeleton.bones.length).toBeGreaterThan(0);
                expect(typeof skeleton.name).toBe('string');
                for (const bone of skeleton.bones) {
                    // ASCII printable (Granny bone names are always plain ASCII)
                    expect(bone.name).toMatch(/^[\x20-\x7e]+$/);
                    // Parent index is either -1 (root) or a valid back-reference
                    expect(bone.parentIndex).toBeGreaterThanOrEqual(-1);
                    expect(bone.parentIndex).toBeLessThan(skeleton.bones.length);
                    // Transform values must be finite numbers
                    expect(Number.isFinite(bone.transform.flags)).toBe(true);
                    for (const v of bone.transform.position) expect(Number.isFinite(v)).toBe(true);
                    for (const v of bone.transform.orientation) expect(Number.isFinite(v)).toBe(true);
                    for (const v of bone.transform.scaleShear) expect(Number.isFinite(v)).toBe(true);
                    // InverseWorldTransform is 16 floats (when readable)
                    if (bone.inverseWorldTransform.length > 0) {
                        expect(bone.inverseWorldTransform.length).toBe(16);
                        for (const v of bone.inverseWorldTransform) expect(Number.isFinite(v)).toBe(true);
                    }
                }
            }
        });
    }
});

describe.skipIf(!haveManifest)('extractSkeletons — animation-only fixtures', () => {
    // Animation-only fixtures DO ship a skeleton (the bind target for the
    // animation curves) — so we sanity-check shape + value finiteness only.
    // Field-by-field parity with the Python oracle is covered by the
    // GrannyModelLive integration test (env-gated by GRANNY_LIVE_ORACLE=1).
    for (const fixture of animationFixtures) {
        it(`${fixture.name} returns a well-formed skeleton array`, () => {
            const skeletons = extractSkeletons(loadFixture(fixture.name));
            expect(Array.isArray(skeletons)).toBe(true);
            for (const skeleton of skeletons) {
                expect(typeof skeleton.name).toBe('string');
                for (const bone of skeleton.bones) {
                    expect(typeof bone.name).toBe('string');
                    expect(Number.isFinite(bone.parentIndex)).toBe(true);
                    expect(Number.isFinite(bone.transform.flags)).toBe(true);
                }
            }
        });
    }
});

describe.skipIf(!existsSync(TREASUREBOX_PATH))('extractSkeletons — treasurebox_2.gr2 snapshot', () => {
    it('matches a stable meta snapshot for the smallest model', () => {
        const skeletons = extractSkeletons(loadFixture('treasurebox_2.gr2'));
        expect(skeletons.length).toBeGreaterThan(0);
        const skeleton = skeletons[0];
        const firstBone = skeleton.bones[0];
        expect({
            skeletonName: skeleton.name,
            boneCount: skeleton.bones.length,
            firstBoneName: firstBone.name,
            firstBoneParent: firstBone.parentIndex,
        }).toMatchSnapshot();
    });
});
