// Performance benchmark for the single-pass `parseAll` vs the three-pass path.
//
// Run with `npm run bench` (vitest's `bench` command). Skips entirely if the
// model + anim fixtures are missing — populate via `npm run bake`.
//
// The two cases mirror what roBrowser's GR2Loader.load() does today (`load3x`)
// against the new single-pass entry (`load1x`). The dominant cost is the Oodle0
// decompress inside `loadGR2` : `load3x` runs it three times per buffer,
// `load1x` once — so `load1x` is expected to land near ⅓ the time of `load3x`.

import { bench, describe } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    parseAll,
    parseTextured,
    parseAnimated,
    extractModels,
    loadGR2,
    parseGR2File,
} from '../../src/Granny.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..', '..');
const FIXTURE_SOURCE = join(PKG, 'tests', 'fixtures', 'source');

// One model + one anim fixture — the two shapes a real entity load joins.
const NAMES = ['treasurebox_2.gr2', '7_dead.gr2'];
const paths = NAMES.map((n) => join(FIXTURE_SOURCE, n));
const haveFixtures = paths.every((p) => existsSync(p));

// Preload so the bench body only pays for the parse work it measures.
const buffers = haveFixtures ? paths.map((p) => readFileSync(p)) : [];

describe.skipIf(!haveFixtures)('parseAll — single-pass vs three-pass', () => {
    // Exactly what GR2Loader.load() does today : three independent parses,
    // each re-running loadGR2 from raw bytes.
    bench('load3x — parseTextured + parseAnimated + extractModels(loadGR2)', () => {
        for (const buf of buffers) {
            parseTextured(buf);
            parseAnimated(buf);
            extractModels(loadGR2(parseGR2File(buf)));
        }
    }, {
        time: 1500,
        warmupIterations: 3,
    });

    // The single-pass entry : one loadGR2 feeds every extractor.
    bench('load1x — parseAll', () => {
        for (const buf of buffers) {
            parseAll(buf);
        }
    }, {
        time: 1500,
        warmupIterations: 3,
    });
});
