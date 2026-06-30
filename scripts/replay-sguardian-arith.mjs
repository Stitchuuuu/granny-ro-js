// S3.17 driver — load wine arith JSONL trace into `globalThis.__igcTrace`,
// decode `sguardian90_9:tex[0]`, and report divergences caught by the
// in-source assertion at GrannyTextureIGC.js:772-803.
//
// The wine trace was produced by the in-process detour shim
// `granny-ro-js/shim/gr2_igc_export_trace.c` (hooks `fcn.1000e6f0` =
// `arithDecompress(a, ab)`) running granny2.dll under macOS-wine. Each
// JSONL line captures the arith state BEFORE the call : `{call, ctx,
// cum[16], sL, bB, sD, bS, uC, abH, abL, abT}`.
//
// Usage : node scripts/replay-sguardian-arith.mjs
//
// Env :
//   IGC_STRICT=1   throw on first divergence (vs. collect-all default)
//   IGC_LIMIT=N    print only the first N divergences (default 20)
//   TRACE_PATH=…   override wine trace location

import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGR2File } from '../src/GrannyFile.js';
import { loadGR2 } from '../src/GrannyTypeTree.js';
import { walkTextureImages } from '../src/GrannyTexture.js';
import { decodeIGCTexture } from '../src/GrannyTextureIGC.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');

const FIXTURE = resolve(PKG_ROOT, 'tests/fixtures/source/sguardian90_9.gr2');
const DEFAULT_TRACE = '/workspace/iRO_ver12.0-full-client-data/RE/granny2/shim/macos-wine-out/sguardian-tex0/sguardian-tex0-arith-trace.jsonl';
const TRACE_PATH = process.env.TRACE_PATH || DEFAULT_TRACE;
const LIMIT = Number(process.env.IGC_LIMIT || 20);

if (!existsSync(FIXTURE)) {
    console.error(`fixture missing: ${FIXTURE}`);
    process.exit(1);
}
if (!existsSync(TRACE_PATH)) {
    console.error(`wine trace missing: ${TRACE_PATH}`);
    process.exit(1);
}

process.stderr.write(`loading wine trace: ${TRACE_PATH}\n`);
const raw = readFileSync(TRACE_PATH, 'utf8');
const lines = raw.split('\n');
const trace = new Array(lines.length);
let n = 0;
for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.length === 0) continue;
    trace[n++] = JSON.parse(ln);
}
trace.length = n;
process.stderr.write(`trace loaded: ${n} arith calls\n`);

// Normalize wine ctx pointer hex string → stable per-pointer ID (1, 2, …)
// in first-seen order. This lets the in-source assertion (which doesn't
// check ctx identity per-se) be extended later if needed ; for now it's
// just informational. We also annotate each row with its ctxId for log
// readability.
{
    const idByPtr = {};
    let next = 1;
    for (let i = 0; i < n; i++) {
        const ptr = trace[i].ctx;
        let id = idByPtr[ptr];
        if (!id) { id = idByPtr[ptr] = next++; }
        trace[i].ctxId = id;
    }
    process.stderr.write(`unique ctx pointers: ${next - 1}\n`);
}

globalThis.__igcTrace = trace;
globalThis.__igcTraceIdx = 0;
globalThis.__igcDivergences = [];
globalThis.__igcStrictThrow = process.env.IGC_STRICT === '1';

process.stderr.write(`decoding sguardian90_9:tex[0]…\n`);

const buf = readFileSync(FIXTURE);
const file = parseGR2File(buf);
const loaded = loadGR2(file);
const records = walkTextureImages(loaded);
const tex0 = records.find((r) => r.texIdx === 0 && r.imgIdx === 0 && r.mipIdx === 0);
if (!tex0) {
    console.error('sguardian90_9: tex[0] image[0] mip[0] not found');
    process.exit(1);
}

const t0 = Date.now();
try {
    decodeIGCTexture({
        Width: tex0.width,
        Height: tex0.height,
        Alpha: tex0.alpha,
        ImageData: tex0.pixelBytes,
    });
} catch (e) {
    process.stderr.write(`decode threw: ${e.message}\n`);
}
const elapsed = Date.now() - t0;

const div = globalThis.__igcDivergences || [];
const consumed = globalThis.__igcTraceIdx | 0;

process.stderr.write(`\n=== replay summary ===\n`);
process.stderr.write(`elapsed       : ${elapsed} ms\n`);
process.stderr.write(`trace lines   : ${n}\n`);
process.stderr.write(`arith calls JS: ${consumed}\n`);
process.stderr.write(`divergences   : ${div.length}\n`);

if (div.length === 0) {
    process.stderr.write(`\nOK — JS arith state matches wine for all ${consumed} calls.\n`);
    if (consumed !== n) {
        process.stderr.write(`!! BUT call-count differs (${consumed} vs ${n}). Loop-control bug — case B.\n`);
        process.exit(2);
    }
    process.exit(0);
}

const printed = Math.min(div.length, LIMIT);
process.stderr.write(`\nfirst ${printed} divergence(s):\n`);
for (let i = 0; i < printed; i++) {
    const d = div[i];
    process.stderr.write(`  call #${d.call}\n`);
    for (const e of d.errs) process.stderr.write(`    ${e}\n`);
}
process.exit(1);
