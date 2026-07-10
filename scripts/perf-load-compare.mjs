#!/usr/bin/env node
/**
 * perf-load-compare.mjs — average the archived `perf-load --save` runs
 * per commit SHA and compare the current commit against the others.
 *
 * Runs are grouped by their `tag` (short SHA, `-dirty` when the tree was
 * dirty). For each tag we average the TOTAL warm-best across every run of
 * that commit (σ shows run-to-run noise), then diff the current commit's
 * average against each other commit — so you can see, at a glance,
 * whether HEAD is faster or slower than any previously benched revision.
 *
 * Usage : node scripts/perf-load-compare.mjs
 *         (or `npm run perf:load:compare`)
 *
 * Prereq : one or more `docs/perf-profile/full-load/runs/<tag>-NN.json`,
 * written by `npm run perf:load -- --save` (run it a few times per commit
 * for a meaningful average).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const RUNS_DIR = join(PKG, 'docs', 'perf-profile', 'full-load', 'runs');

if (!existsSync(RUNS_DIR)) {
    console.error('[perf-load-compare] no runs/ dir — run `npm run perf:load -- --save` first');
    process.exit(2);
}
const files = readdirSync(RUNS_DIR).filter((n) => n.endsWith('.json'));
if (files.length === 0) {
    console.error('[perf-load-compare] no *.json runs — run `npm run perf:load -- --save` first');
    process.exit(2);
}

// Group every archived run by `<target>:<commit tag>` so a browser / wasm
// run of the same SHA (S3.19d) stays a distinct series from the node one.
const groups = {};
for (const f of files) {
    const rec = JSON.parse(readFileSync(join(RUNS_DIR, f), 'utf8'));
    const key = `${rec.target ?? 'node'}:${rec.tag}`;
    (groups[key] ??= []).push(rec);
}

// Current series = node target on HEAD (same tag derivation as --save).
let current = null;
try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: PKG }).toString().trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: PKG }).toString().trim().length > 0;
    current = `node:${dirty ? `${sha}-dirty` : sha}`;
} catch {
    /* no git — current stays null, nothing gets the ◀ marker */
}

const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
const stddev = (xs) => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

// Per-tag aggregate : average TOTAL best + cold across runs, plus a
// per-fixture mean-best map for the detailed diff.
const agg = {};
for (const tag in groups) {
    const runs = groups[tag];
    const bests = runs.map((r) => r.total.bestSum);
    const colds = runs.map((r) => r.total.cold);
    const bytes = runs[0].total.bytes;
    const latest = runs.reduce((a, b) => (a.timestamp > b.timestamp ? a : b)).timestamp;
    const perFix = {};
    for (const r of runs) for (const fx of r.fixtures) (perFix[fx.name] ??= []).push(fx.best);
    const fixMean = {};
    for (const n in perFix) fixMean[n] = mean(perFix[n]);
    agg[tag] = {
        n: runs.length,
        meanBest: mean(bests),
        sdBest: stddev(bests),
        meanCold: mean(colds),
        mbps: bytes / (1024 * 1024) / (mean(bests) / 1000),
        latest,
        fixMean,
    };
}

// Order : current commit first, then the rest most-recent-first.
const tags = Object.keys(agg).sort((a, b) => {
    if (a === current) return -1;
    if (b === current) return 1;
    return agg[b].latest.localeCompare(agg[a].latest);
});

function printTable(headers, rows, aligns) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (cells) =>
        cells.map((c, i) => (aligns[i] === 'l' ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
    console.log(fmt(headers));
    console.log(widths.map((w) => '-'.repeat(w)).join('  '));
    for (const r of rows) console.log(fmt(r));
}

const cur = current && agg[current] ? agg[current] : null;
const delta = (v, base) => (base ? `${v > base ? '+' : ''}${(((v - base) / base) * 100).toFixed(1)}%` : '—');
const split = (key) => {
    const i = key.indexOf(':');
    return [key.slice(0, i), key.slice(i + 1)]; // [target, commit]
};

console.log(`\nperf-load-compare — full-load warm-best, averaged per <target>:<commit>`);
console.log(`  series : ${tags.length}   runs total : ${files.length}`);
console.log(`  current : ${current ?? '(no git)'}   Δ% = vs current series`);
console.log('');

printTable(
    ['target', 'commit', 'runs', 'mean best ms', 'σ ms', 'MB/s', 'cold ms', 'Δ% best'],
    tags.map((t) => {
        const a = agg[t];
        const [tgt, commit] = split(t);
        return [
            tgt,
            t === current ? `${commit} ◀` : commit,
            String(a.n),
            a.meanBest.toFixed(2),
            a.sdBest.toFixed(2),
            a.mbps.toFixed(1),
            a.meanCold.toFixed(2),
            t === current ? '—' : delta(a.meanBest, cur?.meanBest),
        ];
    }),
    ['l', 'l', 'r', 'r', 'r', 'r', 'r', 'r'],
);

// Per-fixture diff : current vs the most recent OTHER commit.
const baselineTag = tags.find((t) => t !== current);
if (cur && baselineTag) {
    const base = agg[baselineTag];
    console.log(`\nper-fixture warm-best — ${current} vs ${baselineTag} (Δ% = current vs baseline)`);
    console.log('');
    const names = Object.keys(cur.fixMean).filter((n) => n in base.fixMean).sort();
    printTable(
        ['fixture', 'cur ms', `${baselineTag} ms`, 'Δ%'],
        names.map((n) => [n, cur.fixMean[n].toFixed(2), base.fixMean[n].toFixed(2), delta(cur.fixMean[n], base.fixMean[n])]),
        ['l', 'r', 'r', 'r'],
    );
} else if (!baselineTag) {
    console.log(`\n(only one commit benched so far — bench another revision to get a comparison)`);
}
console.log('');
