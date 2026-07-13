// Single-pass `parseAll` : shape + equivalence coverage.
//
// `parseAll` does one `parseGR2File`→`loadGR2` then every extractor on that
// single graph. This test proves it is a faithful superset of the existing
// three-pass path — its meshes / skeletons / textures match `parseTextured`,
// its animations match `parseAnimated`, and its `models[0].initialPlacement`
// matches `extractModels(loadGR2(parseGR2File(buf)))` — so the Session-2
// consumer swap (3×→1×) is behaviour-preserving.
//
// Mirrors GrannyParse.test.js : import from src, fixtures from
// tests/fixtures/source/, skip when they're absent.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseAll,
    parseTextured,
    parseAnimated,
    extractModels,
    loadGR2,
    parseGR2File,
} from '../../src/Granny.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(HERE, '..', 'fixtures', 'source');

const MODEL_FIXTURE = 'treasurebox_2.gr2';
const ANIM_FIXTURE = '7_dead.gr2';

const haveModel = existsSync(resolve(SOURCE_DIR, MODEL_FIXTURE));
const haveAnim = existsSync(resolve(SOURCE_DIR, ANIM_FIXTURE));
const haveFixtures = haveModel && haveAnim;

const readFixture = (name) => readFileSync(resolve(SOURCE_DIR, name));

describe.skipIf(!haveFixtures)('parseAll — single-pass superset', () => {
    for (const name of [MODEL_FIXTURE, ANIM_FIXTURE]) {
        describe(name, () => {
            let buf;
            let all;
            beforeAll(() => {
                buf = readFixture(name);
                all = parseAll(buf);
            });

            it('returns the superset shape', () => {
                expect(all.file).toBeDefined();
                expect(all.file.header).toBeDefined();
                expect(Array.isArray(all.typeTree)).toBe(true);
                expect(typeof all.root).toBe('object');
                expect(Array.isArray(all.skeletons)).toBe(true);
                expect(Array.isArray(all.meshes)).toBe(true);
                expect(Array.isArray(all.textures)).toBe(true);
                expect(Array.isArray(all.animations)).toBe(true);
                expect(Array.isArray(all.models)).toBe(true);
            });

            it('meshes / skeletons / textures equal parseTextured', () => {
                const textured = parseTextured(buf);
                expect(all.meshes).toEqual(textured.meshes);
                expect(all.skeletons).toEqual(textured.skeletons);
                expect(all.textures).toEqual(textured.textures);
            });

            it('animations equal parseAnimated', () => {
                const animated = parseAnimated(buf);
                expect(all.animations).toEqual(animated.animations);
            });

            it('models equal extractModels on the low-level graph', () => {
                const models = extractModels(loadGR2(parseGR2File(buf)));
                expect(all.models).toEqual(models);
            });
        });
    }

    it('model fixture exposes models[0].initialPlacement', () => {
        const all = parseAll(readFixture(MODEL_FIXTURE));
        expect(all.models.length).toBeGreaterThan(0);
        expect(all.models[0].initialPlacement).toBeDefined();
    });

    it('animation fixture has non-empty animations', () => {
        const all = parseAll(readFixture(ANIM_FIXTURE));
        expect(all.animations.length).toBeGreaterThan(0);
    });
});
