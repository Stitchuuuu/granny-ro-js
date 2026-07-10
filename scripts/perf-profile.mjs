#!/usr/bin/env node
/**
 * perf-profile.mjs — JS-only profile driver for `node --prof`.
 *
 * Usage : node --prof scripts/perf-profile.mjs [iterations] [full]
 *         default iterations = 30 (Oodle0) / 10 (full-load, far heavier)
 *
 * Two workloads (mode = second positional / any `full` arg) :
 *   - default (Oodle0) : `parseGR2File` + `decompressSection` on all 21
 *     fixtures. Clean JS-only decompression sample distribution.
 *   - `full`           : the true consumer flow — `parseTextured` on the
 *     6 models (parse + IGC texture decode) and `parseAnimated` on the 15
 *     anim packs. Samples span both codecs (Oodle0 + IGC) + parse.
 *
 * Strictly a profiling helper — headline numbers come from `perf.mjs`
 * (Oodle0) / `perf-load.mjs` (full-load). Post-process the resulting
 * isolate-*.log with `node --prof-process`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseGR2File } from '../src/GrannyFile.js';
import { decompressSection, parseAnimated, parseTextured } from '../src/Granny.js';

// Animation-only fixtures : numeric prefix + `_attack|_damage|_dead|_move`.
const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = resolve(__dirname, '..', 'tests', 'fixtures', 'source');

const full = process.argv.slice(2).includes('full');
const iterArg = process.argv.slice(2).find((a) => /^\d+$/.test(a));
const iterations = Math.max(1, parseInt(iterArg ?? (full ? '10' : '30'), 10));

const fixtures = readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).sort();
const raws = fixtures.map((n) => readFileSync(join(FIXTURE_SOURCE, n)));

const t0 = performance.now();
let totalBytes = 0;
if (full) {
    for (let i = 0; i < iterations; i++) {
        for (let f = 0; f < fixtures.length; f++) {
            const raw = raws[f];
            if (ANIMATION_RX.test(fixtures[f])) parseAnimated(raw);
            else parseTextured(raw);
            totalBytes += raw.length; // input .gr2 bytes (info line only)
        }
    }
} else {
    for (let i = 0; i < iterations; i++) {
        for (const raw of raws) {
            const file = parseGR2File(raw);
            for (const sec of file.sections) {
                const out = decompressSection(sec, file.sectionBytes(sec));
                totalBytes += out.length;
            }
        }
    }
}
const elapsed = performance.now() - t0;
const mode = full ? 'full-load' : 'oodle0';
console.error(`[perf-profile:${mode}] ${iterations} iter × ${fixtures.length} fixtures = ${(totalBytes / (1024 * 1024)).toFixed(1)} MB in ${elapsed.toFixed(1)} ms`);
