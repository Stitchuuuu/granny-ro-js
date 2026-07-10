#!/usr/bin/env node
/**
 * perf-load.mjs — true full-load timings on the 21 .gr2 fixtures.
 *
 * Where `perf.mjs` times Oodle0 decompression only (`parseGR2File` +
 * `decompressSection`), this script times the **whole consumer flow** a
 * real caller pays :
 *   - models (6)     : `parseTextured(buf)` — parse + skeleton + mesh +
 *                      **decode every texture (incl. BigInt-heavy IGC)**.
 *   - anim packs (15): `parseAnimated(buf)` — parse + skeleton + mesh +
 *                      animation extraction.
 *
 * Usage : node scripts/perf-load.mjs [warmIterations] [--save]
 *         (or `npm run perf:load`)   default warmIterations = 20
 *         `--save` also archives the report to
 *         docs/perf-profile/full-load/runs/<shortsha>[-dirty]-NN.txt
 *         (SHA groups by code version ; NN indexes repeated runs, so you
 *         can run it several times and keep every sample). Re-run the
 *         whole script (fresh process) for an honest cold measurement.
 *
 * Methodology :
 * - Per fixture : 1 **cold** call (JIT unwarmed) recorded on its own,
 *   then N **warm** calls reported as mean / p50 / p95 / best-of-N.
 *   Web consumers pay the cold cost, so it is printed separately.
 * - Cold caveat : only the first fixture's cold is truly JIT-cold for the
 *   parse path ; the first *model's* cold is the truly JIT-cold IGC path
 *   (anims sort first, models second). Later fixtures reuse warm JIT.
 * - For models, `parseModel(buf)` (parse-only) is also timed so the
 *   texture-decode share (`full − parse`) is explicit — that IGC delta is
 *   the blind spot the S3.19b optimization pass targets.
 * - MB/s basis : **input `.gr2` bytes** (what the consumer feeds in), at
 *   warm-best. NOT the decompressed-bytes basis `perf.mjs` uses.
 * - Bytes are preloaded before timing — no I/O in the timed region.
 *
 * For a v8 sample profile of this same workload, run
 * `npm run perf:load:profile` and post-process with `node --prof-process`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { parseModel, parseAnimated, parseTextured } from '../src/Granny.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const FIXTURE_SOURCE = join(PKG, 'tests', 'fixtures', 'source');
const RUNS_DIR = join(PKG, 'docs', 'perf-profile', 'full-load', 'runs');

// Animation-only fixtures : numeric prefix + `_attack|_damage|_dead|_move`.
// Model fixtures : every other `.gr2` (matches tests/unit/*.test.js).
const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;

const args = process.argv.slice(2);
const save = args.includes('--save');
const warmIters = Math.max(1, parseInt(args.find((a) => /^\d+$/.test(a)) ?? '20', 10));
// Runtime target label. Only `node` exists today ; browser-dist + wasm
// benches (S3.19d) will pass --target=browser / --target=wasm and land in
// the same runs/ dir — perf-load-compare groups by `<target>:<sha>`.
const targetArg = args.find((a) => a.startsWith('--target='));
const target = targetArg ? targetArg.slice('--target='.length) : 'node';

if (!existsSync(FIXTURE_SOURCE)) {
    console.error(`[perf-load] tests/fixtures/source/ missing — run \`npm run bake\` first`);
    process.exit(2);
}

const fixtures = readdirSync(FIXTURE_SOURCE).filter((n) => n.endsWith('.gr2')).sort();
if (fixtures.length === 0) {
    console.error(`[perf-load] no .gr2 in ${FIXTURE_SOURCE}`);
    process.exit(2);
}

function throughput(bytes, ms) {
    return ((bytes / (1024 * 1024)) / (ms / 1000)).toFixed(1);
}

// mean / p50 / p95 / best over a samples array (ms) ; percentiles by
// nearest-rank on a sorted copy.
function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = samples.reduce((s, x) => s + x, 0) / n;
    const rank = (p) => sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)];
    return { mean, p50: rank(50), p95: rank(95), best: sorted[0] };
}

// Time one thunk once, return elapsed ms.
function timeOnce(fn) {
    const t0 = performance.now();
    fn();
    return performance.now() - t0;
}

// Time one thunk once, returning both elapsed ms and the produced value
// (used for the cold call so we can smoke-check the lib's output without
// spending an extra untimed call that would warm the JIT).
function timeOnceCapture(fn) {
    const t0 = performance.now();
    const value = fn();
    return { ms: performance.now() - t0, value };
}

// Smoke-check that the lib actually produced usable output — a broken
// optimization that returns empty arrays must fail loudly here, not get
// celebrated as a "speedup". Byte-exactness is verified by `npm test` ;
// this is the fast fail for the perf loop.
function assertOutput(name, kind, res) {
    const ok =
        kind === 'model'
            ? Array.isArray(res?.meshes) && res.meshes.length > 0 && Array.isArray(res?.textures)
            : Array.isArray(res?.animations) && res.animations.length > 0;
    if (!ok) {
        console.error(`[perf-load] correctness FAIL — ${name} (${kind}) returned empty/invalid output`);
        process.exit(3);
    }
}

// Preload every fixture buffer + classify (no I/O in the timed region).
const corpus = fixtures.map((name) => ({
    name,
    kind: ANIMATION_RX.test(name) ? 'anim' : 'model',
    bytes: readFileSync(join(FIXTURE_SOURCE, name)),
}));

const rows = [];
for (const { name, kind, bytes } of corpus) {
    const fullOp = kind === 'model' ? () => parseTextured(bytes) : () => parseAnimated(bytes);
    const coldRun = timeOnceCapture(fullOp);
    assertOutput(name, kind, coldRun.value);
    const cold = coldRun.ms;
    const warmFull = [];
    for (let i = 0; i < warmIters; i++) warmFull.push(timeOnce(fullOp));
    const s = stats(warmFull);
    /** @type {ReturnType<typeof stats> & { name: string, kind: string, bytes: number, cold: number, parseBest?: number, texDelta?: number }} */
    const row = { name, kind, bytes: bytes.length, cold, ...s };
    if (kind === 'model') {
        const warmParse = [];
        for (let i = 0; i < warmIters; i++) warmParse.push(timeOnce(() => parseModel(bytes)));
        row.parseBest = Math.min(...warmParse);
        row.texDelta = s.best - row.parseBest; // IGC / texture-decode share of a model load
    }
    rows.push(row);
}

// ---- report building : collect lines so we can print AND archive them ----
const lines = [];
const out = (s = '') => lines.push(s);

// fixed-width table printing (mirrors perf.mjs's hand-rolled style).
function printTable(headers, dataRows, aligns, totalRow) {
    const all = totalRow ? [...dataRows, totalRow] : dataRows;
    const widths = headers.map((h, i) => Math.max(h.length, ...all.map((r) => r[i].length)));
    const fmt = (cells) =>
        cells.map((c, i) => (aligns[i] === 'l' ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
    const sep = () => widths.map((w) => '-'.repeat(w)).join('  ');
    out(fmt(headers));
    out(sep());
    for (const r of dataRows) out(fmt(r));
    if (totalRow) {
        out(sep());
        out(fmt(totalRow));
    }
}

const kb = (b) => (b / 1024).toFixed(1);
const ms = (v) => v.toFixed(2);
const modelCount = rows.filter((r) => r.kind === 'model').length;
const animCount = rows.length - modelCount;

out(`perf-load — full consumer flow (parseTextured / parseAnimated)`);
out(`  target                      : ${target}`);
out(`  warm iterations per fixture : ${warmIters} (+ 1 cold call, reported separately)`);
out(`  fixtures                    : ${rows.length} (${modelCount} models, ${animCount} anim packs)`);
out(`  MB/s basis                  : input .gr2 bytes, at warm-best`);
out('');

const mainHeaders = ['fixture', 'kind', 'in KB', 'cold ms', 'warm mean', 'warm p50', 'warm p95', 'warm best', 'MB/s'];
const mainAligns = ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];
const mainRows = rows.map((r) => [
    r.name,
    r.kind,
    kb(r.bytes),
    ms(r.cold),
    ms(r.mean),
    ms(r.p50),
    ms(r.p95),
    ms(r.best),
    throughput(r.bytes, r.best),
]);

const totBytes = rows.reduce((s, r) => s + r.bytes, 0);
const totCold = rows.reduce((s, r) => s + r.cold, 0);
const totMean = rows.reduce((s, r) => s + r.mean, 0);
const totBest = rows.reduce((s, r) => s + r.best, 0);
// p50/p95 of a corpus total is ill-defined (percentile of a sum) → blank.
const totalRow = ['TOTAL', '', kb(totBytes), ms(totCold), ms(totMean), '—', '—', ms(totBest), throughput(totBytes, totBest)];

printTable(mainHeaders, mainRows, mainAligns, totalRow);

// ---- model breakdown : how much of a model load is texture (IGC) decode ----
const modelRows = rows.filter((r) => r.kind === 'model');
if (modelRows.length > 0) {
    out('');
    out(`model breakdown — parse-only vs full (warm best) ; +tex = texture/IGC decode`);
    out('');
    const bHeaders = ['model', 'in KB', 'parse ms', 'full ms', '+tex ms', 'tex %'];
    const bAligns = ['l', 'r', 'r', 'r', 'r', 'r'];
    const bRows = modelRows.map((r) => [
        r.name,
        kb(r.bytes),
        ms(r.parseBest),
        ms(r.best),
        ms(r.texDelta),
        `${((r.texDelta / r.best) * 100).toFixed(1)}%`,
    ]);
    const bParse = modelRows.reduce((s, r) => s + r.parseBest, 0);
    const bFull = modelRows.reduce((s, r) => s + r.best, 0);
    const bTex = modelRows.reduce((s, r) => s + r.texDelta, 0);
    const bBytes = modelRows.reduce((s, r) => s + r.bytes, 0);
    const bTotal = ['TOTAL', kb(bBytes), ms(bParse), ms(bFull), ms(bTex), `${((bTex / bFull) * 100).toFixed(1)}%`];
    printTable(bHeaders, bRows, bAligns, bTotal);
}

const report = lines.join('\n');
process.stdout.write('\n' + report + '\n');

// ---- optional archive : one file per run, keyed by commit SHA ----------
if (save) {
    // `<shortsha>[-dirty]` groups runs by code version ; a zero-padded NN
    // suffix indexes repeats so multiple runs of the same commit coexist.
    let tag;
    try {
        const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG }).toString().trim();
        const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PKG }).toString().trim().length > 0;
        tag = dirty ? `${sha}-dirty` : sha;
    } catch {
        tag = 'nogit';
    }
    mkdirSync(RUNS_DIR, { recursive: true });
    const taken = new Set(readdirSync(RUNS_DIR).filter((n) => n.startsWith(`${tag}-`) && n.endsWith('.txt')));
    let nn = 1;
    while (taken.has(`${tag}-${String(nn).padStart(2, '0')}.txt`)) nn++;
    const nnStr = String(nn).padStart(2, '0');
    const base = `${tag}-${nnStr}`;
    const stamp = new Date().toISOString();
    // Human-readable .txt (git-diff friendly) + machine-readable .json
    // (consumed by perf-load-compare.mjs to average + diff across SHAs).
    const header = `# perf-load run — ${target}:${tag} #${nnStr}\n# ${stamp} · node ${process.version} · warmIters=${warmIters}\n\n`;
    writeFileSync(join(RUNS_DIR, `${base}.txt`), header + report + '\n');
    writeFileSync(
        join(RUNS_DIR, `${base}.json`),
        JSON.stringify(
            {
                tag,
                target,
                run: nn,
                timestamp: stamp,
                node: process.version,
                warmIters,
                total: { bytes: totBytes, cold: totCold, meanSum: totMean, bestSum: totBest },
                fixtures: rows,
            },
            null,
            2,
        ) + '\n',
    );
    process.stdout.write(`\n[perf-load] archived → docs/perf-profile/full-load/runs/${base}.{txt,json}\n`);
}
