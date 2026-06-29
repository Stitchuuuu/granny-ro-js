#!/usr/bin/env node
/**
 * perf-compare.mjs — head-to-head JS vs Python decompression timings on
 * the 21 .gr2 fixtures. Prints a per-fixture + total table with `best_ms`
 * (best-of-N), throughput in MB/s, and the JS-vs-Python speed ratio.
 *
 * Usage : node scripts/perf-compare.mjs [iterations]
 *         (or `npm run perf:compare`)
 *         default iterations = 5
 *
 * Methodology :
 * - Both backends time the same workload : `parseGR2File` + 6 ×
 *   `decompressSection`, repeated N times per fixture, reporting the
 *   best (= least GC / OS jitter affected) sample as the headline.
 * - JS uses `performance.now()` ; Python uses `time.perf_counter()`.
 * - JS runs in-process ; Python via one batched `spawnSync` covering
 *   all fixtures (so per-call interpreter-startup cost is amortized).
 *
 * Note : this measures pure decompression — no I/O. Both languages
 * preload bytes before the timed section.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { parseGR2File } from '../src/GrannyFile.js';
import { decompressSection } from '../src/Granny.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const FIXTURE_SOURCE = join(PKG, 'tests', 'fixtures', 'source');
const PYTHON_BENCH = join(__dirname, 'python-bench.py');

const iterations = Math.max(1, parseInt(process.argv[2] ?? '5', 10));

if (!existsSync(FIXTURE_SOURCE)) {
    console.error(`[perf] tests/fixtures/source/ missing — run \`npm run bake\` first`);
    process.exit(2);
}

const fixtures = readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).sort();
if (fixtures.length === 0) {
    console.error(`[perf] no .gr2 under tests/fixtures/source/`);
    process.exit(2);
}

console.error(`[perf] timing ${fixtures.length} fixtures × ${iterations} iterations per backend`);

// --- JS timings --------------------------------------------------------

/**
 * Time one parse + decompress pass over a .gr2 byte buffer.
 *
 * @returns `{ elapsed_ms, decompressed_bytes }`
 */
function timeOneJS(raw) {
    const t0 = performance.now();
    const file = parseGR2File(raw);
    let totalBytes = 0;
    for (const sec of file.sections) {
        const out = decompressSection(sec, file.sectionBytes(sec));
        totalBytes += out.length;
    }
    return {
        elapsed_ms: performance.now() - t0,
        decompressed_bytes: totalBytes,
    };
}

console.error(`[perf] JS pass...`);
const jsByFixture = {
};
for (const name of fixtures) {
    const raw = readFileSync(join(FIXTURE_SOURCE, name));
    const times = [];
    let bytes = 0;
    for (let i = 0; i < iterations; i++) {
        const r = timeOneJS(raw);
        times.push(r.elapsed_ms);
        bytes = r.decompressed_bytes;
    }
    jsByFixture[name] = {
        best_ms: Math.min(...times),
        mean_ms: times.reduce((a, b) => a + b, 0) / times.length,
        decompressed_bytes: bytes,
    };
}

// --- Python timings ----------------------------------------------------

console.error(`[perf] Python pass (one batched subprocess)...`);
const pyResult = spawnSync(
    'python3',
    [PYTHON_BENCH, String(iterations), ...fixtures.map((n) => join(FIXTURE_SOURCE, n))],
    {
        stdio: ['ignore', 'pipe', 'inherit'],
    },
);
if (pyResult.status !== 0) {
    console.error(`[perf] Python bench failed : exit=${pyResult.status}`);
    process.exit(3);
}
const pyJson = JSON.parse(pyResult.stdout.toString());
const pyByFixture = pyJson.per_fixture;

// --- format + print ----------------------------------------------------

/** Pretty MB/s given (bytes, ms). */
function throughput(bytes, ms) {
    if (ms <= 0) return 'n/a';
    const mbPerSec = (bytes / (1024 * 1024)) / (ms / 1000);
    return `${mbPerSec.toFixed(1)} MB/s`;
}

const rows = [];
let jsTotalBytes = 0;
let jsTotalBest = 0;
let pyTotalBest = 0;
for (const name of fixtures) {
    const js = jsByFixture[name];
    const py = pyByFixture[name];
    jsTotalBytes += js.decompressed_bytes;
    jsTotalBest += js.best_ms;
    pyTotalBest += py.best_ms;
    rows.push({
        name,
        bytes: js.decompressed_bytes,
        js_ms: js.best_ms,
        py_ms: py.best_ms,
        ratio: py.best_ms / js.best_ms,
    });
}

const headers = ['fixture', 'bytes', 'JS best ms', 'Py best ms', 'JS MB/s', 'Py MB/s', 'JS / Py'];
const widths = [
    Math.max(headers[0].length, ...rows.map((r) => r.name.length)),
    Math.max(headers[1].length, ...rows.map((r) => r.bytes.toString().length)),
    Math.max(headers[2].length, 9),
    Math.max(headers[3].length, 9),
    Math.max(headers[4].length, 9),
    Math.max(headers[5].length, 9),
    Math.max(headers[6].length, 8),
];
const pad = (s, w) => s.padStart(w, ' ');
const padR = (s, w) => s.padEnd(w, ' ');

console.log(`\nperf-compare — JS vs Python (Rasetsuu/blendergranny clean-room codec)`);
console.log(`  iterations per fixture : ${iterations} (reporting best-of-N)`);
console.log(`  fixtures               : ${fixtures.length}`);
console.log('');
console.log(
    padR(headers[0], widths[0]) + '  ' +
    pad(headers[1], widths[1]) + '  ' +
    pad(headers[2], widths[2]) + '  ' +
    pad(headers[3], widths[3]) + '  ' +
    pad(headers[4], widths[4]) + '  ' +
    pad(headers[5], widths[5]) + '  ' +
    pad(headers[6], widths[6])
);
console.log(
    '-'.repeat(widths[0]) + '  ' +
    '-'.repeat(widths[1]) + '  ' +
    '-'.repeat(widths[2]) + '  ' +
    '-'.repeat(widths[3]) + '  ' +
    '-'.repeat(widths[4]) + '  ' +
    '-'.repeat(widths[5]) + '  ' +
    '-'.repeat(widths[6])
);
for (const r of rows) {
    console.log(
        padR(r.name, widths[0]) + '  ' +
        pad(r.bytes.toString(), widths[1]) + '  ' +
        pad(r.js_ms.toFixed(2), widths[2]) + '  ' +
        pad(r.py_ms.toFixed(2), widths[3]) + '  ' +
        pad(throughput(r.bytes, r.js_ms), widths[4]) + '  ' +
        pad(throughput(r.bytes, r.py_ms), widths[5]) + '  ' +
        pad(`${r.ratio.toFixed(1)}×`, widths[6])
    );
}
console.log(
    '-'.repeat(widths[0]) + '  ' +
    '-'.repeat(widths[1]) + '  ' +
    '-'.repeat(widths[2]) + '  ' +
    '-'.repeat(widths[3]) + '  ' +
    '-'.repeat(widths[4]) + '  ' +
    '-'.repeat(widths[5]) + '  ' +
    '-'.repeat(widths[6])
);
console.log(
    padR('TOTAL', widths[0]) + '  ' +
    pad(jsTotalBytes.toString(), widths[1]) + '  ' +
    pad(jsTotalBest.toFixed(2), widths[2]) + '  ' +
    pad(pyTotalBest.toFixed(2), widths[3]) + '  ' +
    pad(throughput(jsTotalBytes, jsTotalBest), widths[4]) + '  ' +
    pad(throughput(jsTotalBytes, pyTotalBest), widths[5]) + '  ' +
    pad(`${(pyTotalBest / jsTotalBest).toFixed(1)}×`, widths[6])
);
console.log('');
