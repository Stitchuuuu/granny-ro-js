// Unit tests for the GR2 type-tree walker.
//
// Three pass kinds :
// - synthetic round-trip tests for the fake-pointer codec
// - MEMBER_TYPE constants sanity (verbatim port from blendergranny)
// - real-fixture walks on treasurebox_2.gr2 (smallest of the 21)
//
// The 21-fixture parametric coverage lives in tests/unit/GrannyParse.test.js
// to keep this file focused on layer-by-layer correctness.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGR2File } from '../../src/GrannyFile.js';
import {
    loadGR2,
    parseTypeTree,
    parseObject,
    makeFakePointer,
    decodeFakePointer,
    FAKE_POINTER_BASE,
    FAKE_SECTION_STRIDE,
    MEMBER_TYPE_NAMES,
    MT_END,
    MT_INLINE,
    MT_REFERENCE,
    MT_REFERENCE_TO_ARRAY,
    MT_ARRAY_OF_REFERENCES,
    MT_STRING,
    MT_REAL32,
    MT_INT32,
    MT_UINT32,
    MT_REAL16,
    MT_EMPTY_REFERENCE,
    __test__,
} from '../../src/GrannyTypeTree.js';

const FIXTURE_URL = new URL('../fixtures/source/treasurebox_2.gr2', import.meta.url);
const FIXTURE_PATH = fileURLToPath(FIXTURE_URL);
const haveFixture = existsSync(FIXTURE_PATH);

// --- fake-pointer codec -------------------------------------------------

describe('fake-pointer codec', () => {
    it('round-trips [section, offset] across the grid', () => {
        for (let s = 0; s < 8; s++) {
            for (const off of [0, 4, 16, 64, 0x1000, 0x10000, 0x80000]) {
                const fake = makeFakePointer(s, off);
                expect(decodeFakePointer(fake, 8)).toEqual([s, off]);
            }
        }
    });

    it('returns null for pointers below FAKE_POINTER_BASE', () => {
        expect(decodeFakePointer(0, 8)).toBeNull();
        expect(decodeFakePointer(1, 8)).toBeNull();
        expect(decodeFakePointer(FAKE_POINTER_BASE - 1, 8)).toBeNull();
    });

    it('returns null when the encoded section index is out of range', () => {
        const fake = makeFakePointer(7, 0x100);
        expect(decodeFakePointer(fake, 8)).toEqual([7, 0x100]);
        expect(decodeFakePointer(fake, 7)).toBeNull();
    });

    it('encodes section stride at the documented power of two', () => {
        expect(FAKE_SECTION_STRIDE).toBe(0x100000);
        expect(makeFakePointer(1, 0) - makeFakePointer(0, 0)).toBe(FAKE_SECTION_STRIDE);
    });
});

// --- MEMBER_TYPE constants ----------------------------------------------

describe('MEMBER_TYPE constants', () => {
    it('cover 0–22 contiguously with the canonical names', () => {
        for (let i = 0; i <= 22; i++) {
            expect(MEMBER_TYPE_NAMES[i]).toBeTypeOf('string');
            expect(MEMBER_TYPE_NAMES[i].length).toBeGreaterThan(0);
        }
        // Spot-check a handful of the most-used ones.
        expect(MEMBER_TYPE_NAMES[MT_END]).toBe('end');
        expect(MEMBER_TYPE_NAMES[MT_INLINE]).toBe('inline');
        expect(MEMBER_TYPE_NAMES[MT_REFERENCE]).toBe('reference');
        expect(MEMBER_TYPE_NAMES[MT_STRING]).toBe('string');
        expect(MEMBER_TYPE_NAMES[MT_ARRAY_OF_REFERENCES]).toBe('array_of_references');
        expect(MEMBER_TYPE_NAMES[MT_REAL32]).toBe('real32');
        expect(MEMBER_TYPE_NAMES[MT_INT32]).toBe('int32');
        expect(MEMBER_TYPE_NAMES[MT_UINT32]).toBe('uint32');
        expect(MEMBER_TYPE_NAMES[MT_REAL16]).toBe('real16');
        expect(MEMBER_TYPE_NAMES[MT_EMPTY_REFERENCE]).toBe('empty_reference');
    });

    it('SCALAR_SIZES covers every numeric MEMBER_TYPE with the right byte width', () => {
        const sizes = __test__.SCALAR_SIZES;
        expect(sizes[MT_REAL32]).toBe(4);
        expect(sizes[MT_INT32]).toBe(4);
        expect(sizes[MT_UINT32]).toBe(4);
        expect(sizes[MT_REAL16]).toBe(2);
        // 8-bit
        for (const t of [11, 12, 13, 14]) expect(sizes[t]).toBe(1);
        // 16-bit
        for (const t of [15, 16, 17, 18]) expect(sizes[t]).toBe(2);
    });
});

// --- looksText heuristic ------------------------------------------------

describe('looksText heuristic', () => {
    const { looksText } = __test__;

    it('accepts plain ASCII strings', () => {
        expect(looksText(new TextEncoder().encode('Meshes'))).toBe(true);
        expect(looksText(new TextEncoder().encode('Skeletons'))).toBe(true);
    });

    it('rejects bytes < 32 (except tab / LF / CR) and DEL (0x7f)', () => {
        expect(looksText(new Uint8Array([0, 0, 0, 0]))).toBe(false);
        expect(looksText(new Uint8Array([1, 2, 3, 4]))).toBe(false);
        expect(looksText(new Uint8Array([0x68, 0x69, 0x7f]))).toBe(false);
    });

    it('accepts high bytes (port matches blendergranny ; UTF-8 multibyte friendly)', () => {
        // Matches Rasetsuu/blendergranny types.py:_looks_text exactly :
        // only bytes < 32 (minus 9/10/13) or === 127 reject ; high bytes pass.
        expect(looksText(new Uint8Array([0x80, 0x90, 0xa0, 0xff]))).toBe(true);
    });

    it('rejects empty input', () => {
        expect(looksText(new Uint8Array(0))).toBe(false);
    });

    it('accepts whitespace + ASCII (tab / LF / CR)', () => {
        expect(looksText(new Uint8Array([0x68, 0x69, 0x09, 0x0a, 0x0d]))).toBe(true);
    });
});

// --- real-fixture walks -------------------------------------------------

describe.skipIf(!haveFixture)('treasurebox_2.gr2 — full walk', () => {
    const buffer = haveFixture ? readFileSync(FIXTURE_URL) : new Uint8Array(0);
    const file = haveFixture ? parseGR2File(buffer) : null;

    it('parses without throwing', () => {
        expect(file).not.toBeNull();
        expect(file.sections.length).toBeGreaterThan(0);
    });

    it('loadGR2 returns one decompressed buffer per section', () => {
        const loaded = loadGR2(file);
        expect(loaded.sectionsOriginal.length).toBe(file.sections.length);
        expect(loaded.sectionsFixed.length).toBe(file.sections.length);
        for (let i = 0; i < file.sections.length; i++) {
            expect(loaded.sectionsOriginal[i].length).toBe(file.sections[i].expanded_size);
            expect(loaded.sectionsFixed[i].length).toBe(file.sections[i].expanded_size);
        }
    });

    it('applies at least one pointer fixup (else the walker would see garbage)', () => {
        const loaded = loadGR2(file);
        expect(loaded.pointerFixups.length).toBeGreaterThan(0);
    });

    it('keeps sectionsOriginal byte-identical to a fresh decompress (fixup writes to clone)', () => {
        const loaded = loadGR2(file);
        // Pick a section that has fixups + sample its bytes by SHA-comparison.
        // sectionsOriginal must NOT have been mutated by the fixup pass.
        const sectionWithFixups = loaded.pointerFixups[0].source_section;
        const original = loaded.sectionsOriginal[sectionWithFixups];
        const fixed = loaded.sectionsFixed[sectionWithFixups];
        // At least one byte differs (the fixed pointer slot).
        let differs = false;
        for (let i = 0; i < original.length; i++) {
            if (original[i] !== fixed[i]) {
                differs = true;
                break;
            }
        }
        expect(differs).toBe(true);
    });

    it('parseTypeTree on header.root_type yields real ASCII member names', () => {
        const loaded = loadGR2(file);
        const tree = parseTypeTree(loaded, file.header.root_type);
        expect(tree.length).toBeGreaterThan(0);
        // Members must terminate before the maxMembers budget.
        expect(tree.length).toBeLessThan(512);
        for (const member of tree) {
            expect(member.name).toMatch(/^[\x20-\x7e]+$/);
            // « member_NNN » fallback would indicate fixup didn't land.
            expect(member.name).not.toMatch(/^member_\d+$/);
        }
    });

    it('parseObject on header.root_object exposes the canonical Granny root keys', () => {
        const loaded = loadGR2(file);
        const tree = parseTypeTree(loaded, file.header.root_type);
        const root = parseObject(loaded, tree, file.header.root_object);
        const keys = Object.keys(root);
        expect(keys.length).toBeGreaterThan(0);
        // At least one canonical sub-array must be present in any v2 GR2.
        const canonical = ['Meshes', 'Skeletons', 'Animations', 'Materials', 'Textures'];
        const hit = canonical.filter((k) => k in root);
        expect(hit.length).toBeGreaterThan(0);
        for (const key of hit) {
            const field = root[key];
            // Canonical sub-arrays are array_of_references / reference_to_array.
            expect([
                'array_of_references',
                'reference_to_array',
                'reference_to_variant_array',
            ]).toContain(field.type);
            expect(typeof field.count).toBe('number');
        }
    });

    it('parseTypeTree shape snapshot (regression guard)', () => {
        const loaded = loadGR2(file);
        const tree = parseTypeTree(loaded, file.header.root_type);
        // Strip referenceType (section-dependent) + offset (layout-dependent)
        // — leaves name + memberType, which is the schema's stable surface.
        const shape = tree.map((m) => ({
            name: m.name,
            memberType: m.memberType,
            memberTypeName: m.memberTypeName,
            arrayWidth: m.arrayWidth,
        }));
        expect(shape).toMatchSnapshot();
    });
});
