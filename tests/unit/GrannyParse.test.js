// 21-fixture parametric parse test.
//
// For each fixture in tests/fixtures/manifest.json, calls
// `Granny.parse(buffer)` and asserts the basic shape : non-empty type
// tree + non-empty root keyed by ASCII member names + at least one of
// the canonical sub-arrays present.
//
// No try/catch fallback — fixtures that fail surface by name so we can
// see exactly which one regressed (§ memory : feedback_no_empirical_closure_re).

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '../../src/Granny.js';

const MANIFEST_URL = new URL('../fixtures/manifest.json', import.meta.url);
const MANIFEST_PATH = fileURLToPath(MANIFEST_URL);

const haveManifest = existsSync(MANIFEST_PATH);
const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [], fixture_count: 0 };

/** Canonical root keys that Granny v2 schemas expose ; at least one must hit. */
const CANONICAL_ROOT_KEYS = [
    'Meshes',
    'Skeletons',
    'Animations',
    'Materials',
    'Textures',
];

describe.skipIf(!haveManifest)('Granny.parse — 21-fixture parametric coverage', () => {
    it(`manifest sanity : ${manifest.fixture_count} fixtures`, () => {
        expect(manifest.fixtures.length).toBeGreaterThan(0);
        expect(manifest.fixtures.length).toBe(manifest.fixture_count);
    });

    for (const fixture of manifest.fixtures) {
        describe(fixture.name, () => {
            let result;
            beforeAll(() => {
                const url = new URL(`../fixtures/source/${fixture.name}`, import.meta.url);
                const buf = readFileSync(url);
                result = parse(buf);
            });

            it('returns { file, typeTree, root }', () => {
                expect(result.file).toBeDefined();
                expect(result.file.header).toBeDefined();
                expect(Array.isArray(result.typeTree)).toBe(true);
                expect(result.root).toBeDefined();
                expect(typeof result.root).toBe('object');
            });

            it('type tree has at least one member', () => {
                expect(result.typeTree.length).toBeGreaterThan(0);
            });

            it('all member names are non-empty ASCII (no « member_NNN » fallback)', () => {
                for (const member of result.typeTree) {
                    expect(member.name).toMatch(/^[\x20-\x7e]+$/);
                    expect(member.name).not.toMatch(/^member_\d+$/);
                }
            });

            it('root object has at least one member key', () => {
                expect(Object.keys(result.root).length).toBeGreaterThan(0);
            });

            it('root carries at least one canonical sub-array', () => {
                const hits = CANONICAL_ROOT_KEYS.filter((k) => k in result.root);
                expect(hits.length).toBeGreaterThan(0);
                for (const key of hits) {
                    const field = result.root[key];
                    expect(typeof field.count).toBe('number');
                    expect(field.count).toBeGreaterThanOrEqual(0);
                }
            });
        });
    }
});
