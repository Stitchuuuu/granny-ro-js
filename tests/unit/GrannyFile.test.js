// Unit tests for the GR2 header + section table reader.
//
// Mix of two pass kinds :
// - synthetic .gr2 buffers built in-test (magic detection, endian flip,
//   out-of-range section table) — pure unit
// - the 21 real iRO ver12 fixtures (parses our actual corpus and
//   sees the values our pipeline expects)

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
    parseGR2File,
    detectGR2,
    MAGIC_32LE,
    MAGIC_SIZE,
    SECTION_RECORD_SIZE,
    COMPRESSION_NONE,
    COMPRESSION_OODLE0,
} from '../../src/GrannyFile.js';

// --- synthetic ----------------------------------------------------------

/** Coerce + write an unsigned 32-bit value little-endian into `view`. */
function writeU32LE(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
}

/**
 * Build a minimal-but-valid GR2 buffer for header parsing tests. The
 * returned buffer has a recognized magic, a coherent header pointing at
 * a `sectionCount` × 44-byte section array, and zero-length section data
 * (so `sectionBytes()` returns empty slices without touching out-of-bounds
 * memory).
 *
 * @param magicVariant one of the `MAGIC_*` quads ; default `MAGIC_32LE`
 * @param version 6 (short header, 60 bytes) or 7+ (long header, 72 bytes)
 * @param sectionCount how many section records to emit
 * @returns Uint8Array ready to feed `parseGR2File()`
 */
function buildMinimalGR2({
    magicVariant = MAGIC_32LE,
    version = 7,
    sectionCount = 6,
} = {
}) {
    // Layout : 32 bytes magic + ~72 bytes header + sectionCount * 44 bytes
    // section records. No actual section payloads — that's fine, parseGR2File
    // doesn't read them until sectionBytes() is called.
    const headerEnd = MAGIC_SIZE + (version >= 7 ? 72 : 60);
    const sectionsBase = headerEnd;
    const total = sectionsBase + sectionCount * SECTION_RECORD_SIZE + 16; // 16 bytes padding to satisfy sectionBytes
    const buf = new Uint8Array(total);
    const view = new DataView(buf.buffer);
    for (let i = 0; i < 4; i++) writeU32LE(view, i * 4, magicVariant[i]);
    // version
    writeU32LE(view, MAGIC_SIZE, version);
    // total_size, crc
    writeU32LE(view, MAGIC_SIZE + 4, total);
    writeU32LE(view, MAGIC_SIZE + 8, 0xDEADBEEF);
    // section_array_offset (relative to MAGIC_SIZE) — push the section table
    // right after the header.
    writeU32LE(view, MAGIC_SIZE + 12, headerEnd - MAGIC_SIZE);
    // section_count
    writeU32LE(view, MAGIC_SIZE + 16, sectionCount);
    // root_type/object/typeTag/extra_tags/string_db_crc/reserved : leave zero.

    // Write sectionCount section records, each pointing data_offset just past
    // sectionsBase + count*44. data_size = 0 so sectionBytes returns a zero-
    // length subarray (no actual data needed for header parsing tests).
    for (let i = 0; i < sectionCount; i++) {
        const off = sectionsBase + i * SECTION_RECORD_SIZE;
        writeU32LE(view, off + 0,  i === 5 ? COMPRESSION_NONE : COMPRESSION_OODLE0);
        writeU32LE(view, off + 4,  total - 4);    // data_offset → end of buffer
        writeU32LE(view, off + 8,  0);            // data_size
        writeU32LE(view, off + 12, 100 + i);      // expanded_size
        writeU32LE(view, off + 16, 4);            // internal_alignment
        writeU32LE(view, off + 20, 50);           // first_16bit
        writeU32LE(view, off + 24, 80);           // first_8bit
        writeU32LE(view, off + 28, 0);            // pointer_fixup_offset
        writeU32LE(view, off + 32, 0);            // pointer_fixup_count
        writeU32LE(view, off + 36, 0);            // mixed_marshalling_offset
        writeU32LE(view, off + 40, 0);            // mixed_marshalling_count
    }
    return buf;
}

describe('detectGR2 — magic recognition', () => {
    it('detects MAGIC_32LE little-endian', () => {
        const buf = buildMinimalGR2();
        const r = detectGR2(buf);
        expect(r.ok).toBe(true);
        expect(r.byteReversed).toBe(false);
        expect(r.pointerSize).toBe(32);
    });
    it('rejects a non-Granny buffer', () => {
        const buf = new Uint8Array(64).fill(0);
        expect(detectGR2(buf).ok).toBe(false);
    });
    it('rejects a buffer shorter than the magic', () => {
        expect(detectGR2(new Uint8Array(10)).ok).toBe(false);
    });
});

describe('parseGR2File — synthetic', () => {
    it('parses header + 6 section records', () => {
        const buf = buildMinimalGR2({ sectionCount: 6 });
        const file = parseGR2File(buf);
        expect(file.header.version).toBe(7);
        expect(file.header.section_count).toBe(6);
        expect(file.sections).toHaveLength(6);
        for (let i = 0; i < 6; i++) {
            expect(file.sections[i].index).toBe(i);
            expect(file.sections[i].expanded_size).toBe(100 + i);
            expect(file.sections[i].first_16bit).toBe(50);
            expect(file.sections[i].first_8bit).toBe(80);
        }
        // Sanity : section 5 marked NONE, others OODLE0
        expect(file.sections[5].compression).toBe(COMPRESSION_NONE);
        expect(file.sections[0].compression).toBe(COMPRESSION_OODLE0);
    });
    it('throws on a non-Granny buffer', () => {
        expect(() => parseGR2File(new Uint8Array(64))).toThrow(/not a Granny2 file/);
    });
    it('section.compression_name + semantic_name accessors', () => {
        const buf = buildMinimalGR2();
        const file = parseGR2File(buf);
        expect(file.sections[0].semantic_name).toBe('main');
        expect(file.sections[0].compression_name).toBe('oodle0');
        expect(file.sections[5].semantic_name).toBe('texture');
        expect(file.sections[5].compression_name).toBe('none');
    });
    it('accepts ArrayBuffer, Uint8Array and DataView inputs', () => {
        const buf = buildMinimalGR2();
        const fromU8     = parseGR2File(buf);
        const fromAB     = parseGR2File(buf.buffer);
        const fromView   = parseGR2File(new DataView(buf.buffer));
        expect(fromU8.header.section_count).toBe(6);
        expect(fromAB.header.section_count).toBe(6);
        expect(fromView.header.section_count).toBe(6);
    });
});

// --- real iRO ver12 corpus ---------------------------------------------

/**
 * Locate the directory carrying the 21 .gr2 fixtures. Prefers
 * `tests/fixtures/source/` (populated by `npm run bake`), falls back to
 * `/tmp/gr2-ver12/data/model/3dmob` (planning-time extraction). Returns
 * `null` when neither path has any .gr2 file ; the real-corpus tests
 * then skip via `describe.skipIf(!fixtures)`.
 */
function findFixturesRoot() {
    const candidates = [
        resolve(new URL('../fixtures/source', import.meta.url).pathname),
        '/tmp/gr2-ver12/data/model/3dmob',
    ];
    for (const dir of candidates) {
        if (existsSync(dir) && statSync(dir).isDirectory()) {
            const files = listGR2(dir);
            if (files.length > 0) return { dir, files };
        }
    }
    return null;
}

/** Recursive directory walk : every `*.gr2` under `dir`, absolute paths. */
function listGR2(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            for (const sub of listGR2(full)) out.push(sub);
        } else if (name.endsWith('.gr2')) {
            out.push(full);
        }
    }
    return out;
}

const fixtures = findFixturesRoot();

describe.skipIf(!fixtures)('parseGR2File — real iRO ver12 corpus', () => {
    it(`finds at least 1 .gr2 fixture under ${fixtures?.dir}`, () => {
        expect(fixtures.files.length).toBeGreaterThan(0);
    });
    it('each .gr2 parses to a 6-section file with sane values', () => {
        for (const path of fixtures.files) {
            const buf = readFileSync(path);
            const file = parseGR2File(buf);
            // Per EXISTING.md : every iRO ver12 .gr2 has exactly 6 sections.
            expect(file.sections, `file ${path}`).toHaveLength(6);
            // Every section's compression is in the known set
            for (const sec of file.sections) {
                expect([0, 1, 2, 3, 4], `${path} section ${sec.index}`).toContain(sec.compression);
            }
            // sectionBytes() returns a slice of the expected length
            for (const sec of file.sections) {
                const sliced = file.sectionBytes(sec);
                expect(sliced.length, `${path} section ${sec.index}`).toBe(sec.data_size);
            }
        }
    });
    it('section 5 (texture) is NoCompression on every model+anim file', () => {
        for (const path of fixtures.files) {
            const file = parseGR2File(readFileSync(path));
            expect(file.sections[5].compression, `${path} section 5`).toBe(COMPRESSION_NONE);
        }
    });
});
