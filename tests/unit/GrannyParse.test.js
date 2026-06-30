// Parametric parse test over every `.gr2` in tests/fixtures/source/.
//
// For each fixture, calls `Granny.parse(buffer)` and asserts the basic
// shape : non-empty type tree + non-empty root keyed by ASCII member
// names + at least one of the canonical sub-arrays present.
//
// No try/catch fallback — fixtures that fail surface by name so we can
// see exactly which one regressed.

import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '../../src/Granny.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = resolve(HERE, '..', 'fixtures', 'source');

const haveFixtures = existsSync(SOURCE_DIR);
const fixtures = haveFixtures
    ? readdirSync(SOURCE_DIR).filter((n) => n.endsWith('.gr2')).sort()
    : [];

/** Canonical root keys that Granny v2 schemas expose ; at least one must hit. */
const CANONICAL_ROOT_KEYS = [
    'Meshes',
    'Skeletons',
    'Animations',
    'Materials',
    'Textures',
];

describe.skipIf(!haveFixtures || fixtures.length === 0)('Granny.parse — parametric coverage', () => {
    it(`source/ has at least 1 fixture (found ${fixtures.length})`, () => {
        expect(fixtures.length).toBeGreaterThan(0);
    });

    for (const name of fixtures) {
        describe(name, () => {
            let result;
            beforeAll(() => {
                const buf = readFileSync(resolve(SOURCE_DIR, name));
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
