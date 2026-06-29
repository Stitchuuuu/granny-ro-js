// Performance benchmarks for the Oodle0 decompressor.
//
// Run with `npm run bench` (vitest's `bench` command). Skips entirely
// if `tests/fixtures/source/` is missing — populate it via `npm run bake`.
//
// Output : per-bench hz (invocations / second), p99 latency, sample count.
// Plus a one-shot summary line written to stderr at module load with
// total decompressed bytes / throughput, to put the hz numbers in context.

import { bench, describe } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGR2File } from '../../src/GrannyFile.js';
import { decompressSection } from '../../src/Granny.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..', '..');
const FIXTURE_SOURCE = join(PKG, 'tests', 'fixtures', 'source');

const haveFixtures = existsSync(FIXTURE_SOURCE) &&
    readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).length > 0;

// --- preload fixtures --------------------------------------------------

/**
 * One in-memory record per fixture so the benchmark itself doesn't pay
 * for I/O or for file-parsing on every iteration. The bench callbacks
 * only do the work the benchmark wants to measure (decompression).
 *
 * @type {Array<{
 *   name: string,
 *   raw: Uint8Array,
 *   file: ReturnType<typeof parseGR2File>,
 *   sections: Array<{
 *     index: number,
 *     section: ReturnType<typeof parseGR2File>['sections'][number],
 *     compressed: Uint8Array,
 *     expanded_size: number,
 *     compression: string,
 *   }>,
 * }>}
 */
const fixtures = [];

if (haveFixtures) {
    const names = readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).sort();
    for (const name of names) {
        const raw = readFileSync(join(FIXTURE_SOURCE, name));
        const file = parseGR2File(raw);
        const sections = file.sections.map((s) => ({
            index: s.index,
            section: s,
            compressed: file.sectionBytes(s),
            expanded_size: s.expanded_size,
            compression: s.compression_name,
        }));
        fixtures.push({
            name,
            raw,
            file,
            sections,
        });
    }
    // One-shot context line so the hz numbers below have a denominator.
    const totalBytes = fixtures.reduce(
        (acc, f) => acc + f.sections.reduce((a, s) => a + s.expanded_size, 0),
        0,
    );
    const oodleBytes = fixtures.reduce(
        (acc, f) => acc + f.sections
            .filter((s) => s.compression === 'oodle0')
            .reduce((a, s) => a + s.expanded_size, 0),
        0,
    );
    console.error(
        `[bench] preloaded ${fixtures.length} fixtures / ` +
        `${fixtures.reduce((a, f) => a + f.sections.length, 0)} sections / ` +
        `${(totalBytes / 1024).toFixed(0)} KB decompressed total ` +
        `(${(oodleBytes / 1024).toFixed(0)} KB Oodle0)`
    );
}

// --- pick representative fixtures --------------------------------------

/** Pick the fixture whose biggest section has the most bytes (peak throughput target). */
function findBiggestSection() {
    let bestFixture = null;
    let bestSection = null;
    let bestSize = -1;
    for (const f of fixtures) {
        for (const s of f.sections) {
            if (s.compression === 'oodle0' && s.expanded_size > bestSize) {
                bestSize = s.expanded_size;
                bestFixture = f;
                bestSection = s;
            }
        }
    }
    return {
        fixture: bestFixture,
        section: bestSection,
    };
}

// --- bench suites ------------------------------------------------------

describe.skipIf(!haveFixtures)('GrannyOodle0 — performance', () => {
    /** Full corpus : decompress every section of every fixture in one pass. */
    bench('decompress all 21 fixtures (126 sections)', () => {
        for (const f of fixtures) {
            for (const s of f.sections) {
                decompressSection(s.section, s.compressed);
            }
        }
    }, {
        time: 1500,
        warmupIterations: 3,
    });

    /** Peak per-section throughput — biggest Oodle0 section in the corpus. */
    if (haveFixtures) {
        const { fixture, section } = findBiggestSection();
        const label = fixture && section
            ? `biggest single section — ${fixture.name} #${section.index} (${(section.expanded_size / 1024).toFixed(1)} KB Oodle0)`
            : 'biggest single section (n/a)';
        bench(label, () => {
            decompressSection(section.section, section.compressed);
        }, {
            time: 1500,
            warmupIterations: 5,
        });
    }

    /** Representative model file (multi-section, mix of Oodle0 + NoCompression). */
    if (haveFixtures) {
        const treasure = fixtures.find((f) => f.name === 'treasurebox_2.gr2');
        if (treasure) {
            bench('model fixture — treasurebox_2.gr2 (6 sections, 56 KB)', () => {
                for (const s of treasure.sections) {
                    decompressSection(s.section, s.compressed);
                }
            }, {
                time: 1500,
                warmupIterations: 3,
            });
        }
    }

    /** Representative animation file (mostly single Oodle0 section). */
    if (haveFixtures) {
        const anim = fixtures.find((f) => f.name === '7_dead.gr2');
        if (anim) {
            bench('animation fixture — 7_dead.gr2 (6 sections, biggest 84 KB)', () => {
                for (const s of anim.sections) {
                    decompressSection(s.section, s.compressed);
                }
            }, {
                time: 1500,
                warmupIterations: 3,
            });
        }
    }
});
