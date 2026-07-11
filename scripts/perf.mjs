#!/usr/bin/env node
/**
 * perf.mjs — JS-only decompression timings on the 21 .gr2 fixtures.
 * Prints a per-fixture + total table with `best_ms` (best-of-N) and
 * throughput in MB/s.
 *
 * Usage : node scripts/perf.mjs [iterations]
 *         (or `npm run perf`)
 *         default iterations = 5
 *
 * Methodology :
 * - Times the same workload : `parseGR2File` + 6 × `decompressSection`,
 *   repeated N times per fixture, reporting the best (= least GC / OS
 *   jitter affected) sample as the headline.
 * - Uses `performance.now()`.
 * - Pure decompression — no I/O. Bytes are preloaded before timing.
 *
 * For a v8 sample profile, use `node --prof scripts/perf-profile.mjs`
 * and post-process the resulting isolate-*.log with `node --prof-process`.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { parseGR2File } from '../src/GrannyFile.js';
import { decompressSection } from '../src/Granny.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const FIXTURE_SOURCE = join(PKG, 'tests', 'fixtures', 'source');

const iterations = Math.max(1, parseInt(process.argv[2] ?? '5', 10));

if (!existsSync(FIXTURE_SOURCE)) {
    console.error(`[perf] tests/fixtures/source/ missing — run \`npm run bake\` first`);
    process.exit(2);
}

const fixtures = readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).sort();
if (fixtures.length === 0) {
    console.error(`[perf] no .gr2 in ${FIXTURE_SOURCE}`);
    process.exit(2);
}

function throughput(bytes, ms) {
    return ((bytes / (1024 * 1024)) / (ms / 1000)).toFixed(1);
}

const byFixture = {};
for (const name of fixtures) {
    const bytes = readFileSync(join(FIXTURE_SOURCE, name));
    let best_ms = Infinity;
    let decompressedBytes = 0;
    for (let i = 0; i < iterations; i++) {
        const t0 = performance.now();
        const file = parseGR2File(bytes);
        let bytesOut = 0;
        for (const section of file.sections) {
            const data = decompressSection(section, file.sectionBytes(section));
            bytesOut += data.length;
        }
        const ms = performance.now() - t0;
        if (ms < best_ms) {
            best_ms = ms;
            decompressedBytes = bytesOut;
        }
    }
    byFixture[name] = { best_ms, decompressed_bytes: decompressedBytes };
}

const rows = [];
let totalBytes = 0;
let totalBest = 0;
for (const name of fixtures) {
    const r = byFixture[name];
    totalBytes += r.decompressed_bytes;
    totalBest  += r.best_ms;
    rows.push({
        name,
        bytes: r.decompressed_bytes,
        ms: r.best_ms,
    });
}

const headers = ['fixture', 'bytes', 'best ms', 'MB/s'];
const widths = [
    Math.max(headers[0].length, ...rows.map((r) => r.name.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.bytes.toString().length)),
    Math.max(headers[2].length, 8),
    Math.max(headers[3].length, 8),
];
const pad  = (s, w) => s.padStart(w, ' ');
const padR = (s, w) => s.padEnd(w, ' ');

console.log(`\nperf — JS decompression (parseGR2File + decompressSection)`);
console.log(`  iterations per fixture : ${iterations} (reporting best-of-N)`);
console.log(`  fixtures               : ${fixtures.length}`);
console.log('');
console.log(
    padR(headers[0], widths[0]) + '  ' +
    pad(headers[1], widths[1]) + '  ' +
    pad(headers[2], widths[2]) + '  ' +
    pad(headers[3], widths[3])
);
console.log(
    '-'.repeat(widths[0]) + '  ' +
    '-'.repeat(widths[1]) + '  ' +
    '-'.repeat(widths[2]) + '  ' +
    '-'.repeat(widths[3])
);
for (const r of rows) {
    console.log(
        padR(r.name, widths[0]) + '  ' +
        pad(r.bytes.toString(), widths[1]) + '  ' +
        pad(r.ms.toFixed(2), widths[2]) + '  ' +
        pad(throughput(r.bytes, r.ms), widths[3])
    );
}
console.log(
    '-'.repeat(widths[0]) + '  ' +
    '-'.repeat(widths[1]) + '  ' +
    '-'.repeat(widths[2]) + '  ' +
    '-'.repeat(widths[3])
);
console.log(
    padR('TOTAL', widths[0]) + '  ' +
    pad(totalBytes.toString(), widths[1]) + '  ' +
    pad(totalBest.toFixed(2), widths[2]) + '  ' +
    pad(throughput(totalBytes, totalBest), widths[3])
);
console.log('');
