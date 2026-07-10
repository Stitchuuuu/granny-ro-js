// Unit tests for the GR2 model extractor (extractModels).
//
// Coherence oracle for the one decoded category that previously had no
// test coverage. Directory-based enumeration over all 21 fixtures (no
// manifest coupling), mirroring GrannyMesh.test.js.
//
// Corpus reality (verified against the iRO ver12 fixtures) : EVERY GR2 —
// including the 15 animation-only packs — carries exactly one Model. RO's
// 3ds-Max export pipeline wraps the skeleton in a "Dummy01"/"Dummy03"
// Model helper, so `extractModels` returns `[]` ONLY for a file with no
// `root.Models` member at all (none in this corpus). The meaningful split
// is therefore NOT model-vs-animation but content-model (carries mesh
// bindings) vs animation pack (skeleton-only, usually 0 bindings — the
// 8_* family being the exception, shipping 2). We assert the true shape,
// not the (incorrect) "anim packs return []" premise.
//
//   · all 21 fixtures      → exactly 1 well-formed model : non-empty name,
//     skeletonIdx ≥ 0, every meshBinding.meshIdx ≥ 0, well-formed
//     InitialPlacement Transform.
//   · 6 content-model files → ≥ 1 mesh binding.
//   · treasurebox_2.gr2     → stable first-model snapshot.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import { extractModels } from '../../src/GrannyModel.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const TREASUREBOX_PATH = resolve(FIXTURE_DIR, 'treasurebox_2.gr2');

const haveFixtures = existsSync(FIXTURE_DIR);
const allFixtures = haveFixtures
    ? readdirSync(FIXTURE_DIR).filter((n) => n.endsWith('.gr2')).sort()
    : [];

const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;
const modelFixtures = allFixtures
    .filter((name) => !ANIMATION_RX.test(name))
    .map((name) => ({ name }));
const animationFixtures = allFixtures
    .filter((name) => ANIMATION_RX.test(name))
    .map((name) => ({ name }));

function loadFixture(name) {
    const buf = readFileSync(resolve(FIXTURE_DIR, name));
    return loadGR2(parseGR2File(buf));
}

// Assert a value is a structurally well-formed Granny Transform :
// flags (uint32), position[3], orientation[4], scaleShear[9], all finite.
function expectWellFormedTransform(t) {
    expect(t, 'initialPlacement present').toBeTruthy();
    expect(typeof t.flags).toBe('number');
    expect(Array.isArray(t.position)).toBe(true);
    expect(t.position.length).toBe(3);
    expect(Array.isArray(t.orientation)).toBe(true);
    expect(t.orientation.length).toBe(4);
    expect(Array.isArray(t.scaleShear)).toBe(true);
    expect(t.scaleShear.length).toBe(9);
    for (const v of [...t.position, ...t.orientation, ...t.scaleShear]) {
        expect(Number.isFinite(v)).toBe(true);
    }
}

// Assert a single model object is internally coherent.
function expectWellFormedModel(model) {
    expect(typeof model.name).toBe('string');
    expect(model.name.length).toBeGreaterThan(0);
    expect(Number.isInteger(model.skeletonIdx)).toBe(true);
    expect(model.skeletonIdx).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(model.meshBindings)).toBe(true);
    for (const binding of model.meshBindings) {
        expect(Number.isInteger(binding.meshIdx)).toBe(true);
        // A resolved binding is ≥ 0 ; -1 would signal an unresolved Mesh
        // ref, which none of the corpus fixtures should produce.
        expect(binding.meshIdx).toBeGreaterThanOrEqual(0);
    }
    expectWellFormedTransform(model.initialPlacement);
}

describe.skipIf(!haveFixtures)('extractModels — all fixtures carry one well-formed model', () => {
    for (const fixture of allFixtures.map((name) => ({ name }))) {
        it(`${fixture.name} yields exactly one coherent model`, () => {
            const models = extractModels(loadFixture(fixture.name));
            expect(Array.isArray(models)).toBe(true);
            // Every GR2 in this corpus wraps its skeleton in a single Model.
            expect(models.length).toBe(1);
            expectWellFormedModel(models[0]);
        });
    }
});

describe.skipIf(!haveFixtures)('extractModels — content-model fixtures bind meshes', () => {
    for (const fixture of modelFixtures) {
        it(`${fixture.name} has at least one resolved mesh binding`, () => {
            const models = extractModels(loadFixture(fixture.name));
            expect(models.length).toBe(1);
            const bindings = models[0].meshBindings;
            expect(bindings.length).toBeGreaterThanOrEqual(1);
            expect(bindings.some((b) => b.meshIdx >= 0)).toBe(true);
        });
    }
});

describe.skipIf(!haveFixtures)('extractModels — animation packs carry a skeleton-only model', () => {
    // NOT an empty-array assertion : RO anim packs ship the skeleton wrapped
    // in a Dummy model. Bindings are typically empty (pure animation) but
    // the 8_* family ships 2 — so we only assert the model is well-formed
    // and its bindings (if any) resolve, never that it is [].
    for (const fixture of animationFixtures) {
        it(`${fixture.name} returns one skeleton-bound model`, () => {
            const models = extractModels(loadFixture(fixture.name));
            expect(models.length).toBe(1);
            expectWellFormedModel(models[0]);
        });
    }
});

describe.skipIf(!existsSync(TREASUREBOX_PATH))('extractModels — treasurebox_2.gr2 snapshot', () => {
    it('matches a stable first-model snapshot for the smallest model', () => {
        const models = extractModels(loadFixture('treasurebox_2.gr2'));
        expect(models.length).toBeGreaterThan(0);
        const model = models[0];
        expect({
            name: model.name,
            skeletonIdx: model.skeletonIdx,
            meshBindingCount: model.meshBindings.length,
            meshIndices: model.meshBindings.map((b) => b.meshIdx),
            placementFlags: model.initialPlacement.flags,
        }).toMatchSnapshot();
    });
});
