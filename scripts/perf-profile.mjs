#!/usr/bin/env node
/**
 * perf-profile.mjs — JS-only profile driver for `node --prof`.
 *
 * Usage : node --prof scripts/perf-profile.mjs [iterations]
 *         default iterations = 30 (denser signal than perf-compare's 5)
 *
 * Loops the 21-fixture corpus through `parseGR2File` + `decompressSection`
 * with no subprocess wait time, so the resulting isolate-*.log contains
 * a clean JS-only sample distribution. Strictly a profiling helper —
 * don't use for headline numbers (those come from `perf-compare`).
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseGR2File } from '../src/GrannyFile.js';
import { decompressSection } from '../src/Granny.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_SOURCE = resolve(__dirname, '..', 'tests', 'fixtures', 'source');
const iterations = Math.max(1, parseInt(process.argv[2] ?? '30', 10));

const fixtures = readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).sort();
const raws = fixtures.map((n) => readFileSync(join(FIXTURE_SOURCE, n)));

const t0 = performance.now();
let totalBytes = 0;
for (let i = 0; i < iterations; i++) {
    for (const raw of raws) {
        const file = parseGR2File(raw);
        for (const sec of file.sections) {
            const out = decompressSection(sec, file.sectionBytes(sec));
            totalBytes += out.length;
        }
    }
}
const elapsed = performance.now() - t0;
console.error(`[perf-profile] ${iterations} iter × ${fixtures.length} fixtures = ${(totalBytes / (1024 * 1024)).toFixed(1)} MB in ${elapsed.toFixed(1)} ms`);
