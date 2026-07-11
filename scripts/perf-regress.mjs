#!/usr/bin/env node
/**
 * perf-regress.mjs — one-command full-load non-regression compare between two
 * code versions, measured with the SAME (current) bench harness.
 *
 * It runs `perf-load --save` N times on the working tree ("current"), then
 * swaps only the source files that differ into a baseline git-ref, runs N more,
 * restores the tree byte-for-byte, and prints the Δ% table from
 * perf-load-compare. Both batches are measured by the current perf-load.mjs, so
 * only the library code differs — apples-to-apples.
 *
 *   node scripts/perf-regress.mjs [--baseline=<ref>] [--runs=<N>]
 *                                 [--label-current=<name>] [--label-baseline=<name>]
 *
 *   --baseline        git ref for the "without-changes" side   (default v1.2.0)
 *   --runs            perf-load invocations per side            (default 12)
 *   --label-current   batch label for the working tree         (default now)
 *   --label-baseline  batch label for the baseline ref         (default <ref>)
 *
 * Why source-swap and not `git checkout <ref>` : the baseline may predate this
 * harness (different perf-load output schema), and the working tree carries
 * uncommitted changes we must measure and then restore exactly. Copy-backup +
 * `git show <ref>:<file>` keeps the harness constant and the restore lossless.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const RUNS_DIR = join(PKG, 'docs', 'perf-profile', 'full-load', 'runs');

// ---- args ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opt = (name, def) => {
    const a = argv.find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : def;
};
const baselineRef = opt('baseline', 'v1.2.0');
const runs = Math.max(1, parseInt(opt('runs', '12'), 10));
const sanitize = (s) => s.replace(/[^A-Za-z0-9._-]/g, '-');
const labelCurrent = sanitize(opt('label-current', 'now'));
const labelBaseline = sanitize(opt('label-baseline', baselineRef));

const git = (args) => execFileSync('git', args, { cwd: PKG }).toString();

function die(msg) {
    console.error(`[perf-regress] ${msg}`);
    process.exit(1);
}

if (labelCurrent === labelBaseline) die('current and baseline labels must differ');
let baseSha;
try {
    baseSha = git(['rev-parse', '--short', baselineRef]).trim();
} catch {
    die(`baseline ref '${baselineRef}' does not resolve — pass an existing tag/commit`);
}

// ---- source files that differ between the ref and the working tree --------
// Union of committed diff (ref → HEAD) and uncommitted working-tree diff, both
// scoped to src/. These are the only files whose bytes change between the two
// measured states, so they're all we swap (and back up).
const committed = git(['diff', '--name-only', baselineRef, 'HEAD', '--', 'src']).split('\n');
const working = git(['diff', '--name-only', '--', 'src']).split('\n');
const files = [...new Set([...committed, ...working])].filter(Boolean).sort();
if (files.length === 0) die(`no src/ files differ between ${baselineRef} and the working tree — nothing to compare`);

// Every differing file must exist at the ref (else the lib structure diverged
// too far for a clean swap — bail rather than mis-measure a half-baseline).
for (const f of files) {
    try {
        git(['cat-file', '-e', `${baselineRef}:${f}`]);
    } catch {
        die(`'${f}' does not exist at ${baselineRef} — structure diverged, can't source-swap cleanly`);
    }
}

console.log(`[perf-regress] baseline ${baselineRef} (${baseSha}) vs working tree`);
console.log(`[perf-regress] ${runs} runs/side · swapping ${files.length} file(s):`);
for (const f of files) console.log(`               ${f}`);

// ---- helpers -------------------------------------------------------------
const statusSnapshot = () => git(['status', '--porcelain']).trim();
const preStatus = statusSnapshot();

// Remove any prior runs for our two labels so each invocation is a clean batch.
function purgeLabel(label) {
    let removed = 0;
    for (const n of safeReaddir(RUNS_DIR)) {
        if (n.startsWith(`${label}-`) && (n.endsWith('.json') || n.endsWith('.txt'))) {
            rmSync(join(RUNS_DIR, n));
            removed++;
        }
    }
    return removed;
}
function safeReaddir(dir) {
    try {
        return readdirSync(dir);
    } catch {
        return [];
    }
}

function runBatch(label) {
    for (let i = 1; i <= runs; i++) {
        process.stdout.write(`\r[perf-regress] ${label}: run ${i}/${runs}   `);
        execFileSync('node', ['scripts/perf-load.mjs', '--save', `--label=${label}`], {
            cwd: PKG,
            stdio: ['ignore', 'ignore', 'inherit'],
        });
    }
    process.stdout.write('\n');
}

// ---- backup working-tree copies of the swap set --------------------------
const backupDir = mkdtempSync(join(tmpdir(), 'perf-regress-'));
const backupOf = (f) => join(backupDir, sanitize(f));
for (const f of files) copyFileSync(join(PKG, f), backupOf(f));

function restore() {
    for (const f of files) copyFileSync(backupOf(f), join(PKG, f));
}

// ---- run ------------------------------------------------------------------
let ok = false;
try {
    purgeLabel(labelCurrent);
    purgeLabel(labelBaseline);

    console.log(`\n[perf-regress] measuring CURRENT (working tree) → label '${labelCurrent}'`);
    runBatch(labelCurrent);

    console.log(`[perf-regress] swapping ${files.length} file(s) to ${baselineRef}`);
    for (const f of files) writeFileSync(join(PKG, f), git(['show', `${baselineRef}:${f}`]));

    console.log(`[perf-regress] measuring BASELINE (${baselineRef}) → label '${labelBaseline}'`);
    runBatch(labelBaseline);
    ok = true;
} finally {
    restore();
    rmSync(backupDir, { recursive: true, force: true });
    const postStatus = statusSnapshot();
    if (postStatus === preStatus) {
        console.log('[perf-regress] working tree restored ✓ (git status unchanged)');
    } else {
        console.error('[perf-regress] WARNING — git status differs after restore; inspect manually:');
        console.error(`  before:\n${preStatus}\n  after:\n${postStatus}`);
    }
}

if (!ok) die('a measurement run failed — see output above (tree was restored)');

// ---- compare --------------------------------------------------------------
console.log(`\n[perf-regress] compare '${labelCurrent}' (current) vs '${labelBaseline}' (${baselineRef}):\n`);
execFileSync('node', ['scripts/perf-load-compare.mjs', `--current=${labelCurrent}`, `--baseline=${labelBaseline}`], {
    cwd: PKG,
    stdio: 'inherit',
});
