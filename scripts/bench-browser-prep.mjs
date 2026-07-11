#!/usr/bin/env node
/**
 * bench-browser-prep.mjs — stage the self-contained browser bench.
 *
 * The browser harness under `bench/browser/` runs with **no build step** —
 * a plain `<script type="module">` served by any static server. But it needs
 * two things the page can't produce itself : the built ESM bundle to import,
 * and a corpus of `.gr2` to `fetch()`. This bench targets **real client
 * assets** (not the test fixtures) so the numbers reflect a real load, so you
 * must point it at a folder of extracted `.gr2` :
 *
 *     GR2_FOLDER=/path/to/extracted/gr2 npm run bench:browser
 *     # or: node scripts/bench-browser-prep.mjs --gr2-folder=/path/to/gr2
 *
 * It globs `.gr2` recursively from GR2_FOLDER, copies them (preserving relative
 * paths) into `bench/browser/fixtures/`, copies the ESM bundle, writes a
 * `fixtures.json` index (browsers can't list a directory), and prints the
 * serve command. Everything it writes into `bench/browser/` is a regenerated,
 * gitignored artifact — re-run any time the bundle or GR2_FOLDER changes.
 *
 * `.gr2` must be loose/extracted files ; assets still inside a GRF need a
 * separate extraction pass first.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const BENCH_DIR = join(PKG, 'bench', 'browser');
const BENCH_FIXTURES = join(BENCH_DIR, 'fixtures');
const PORT = 8888;

const argOf = (name) => {
    const a = process.argv.slice(2).find((x) => x.startsWith(`--${name}=`));
    return a ? a.slice(name.length + 3) : null;
};
const GR2_FOLDER = (argOf('gr2-folder') ?? process.env.GR2_FOLDER) ?? '';
// --label=<name> : human label recorded in meta.json so a downloaded batch says
//   which version it measured (mirrors perf-load --label; e.g. --label=v1.2.0).
// --ref=<gitref> : build THAT ref's bundle in a throwaway git worktree instead of
//   the working tree's dist/. You A/B a release vs your branch WITHOUT ever
//   `git checkout`-ing — your branch and this tooling never move (defaults the
//   label to the ref).
const REF = argOf('ref');
const LABEL = argOf('label') ?? REF;

function die(msg, code = 2) {
    console.error(`[bench:browser] ${msg}`);
    process.exit(code);
}

// Resolve which dist/ to stage + its version stamp.
let DIST_DIR = join(PKG, 'dist');
let metaSha = 'nogit';
let metaDirty = false;
let worktree = null;
try {
    metaSha = execFileSync('git', ['rev-parse', '--short', REF ?? 'HEAD'], { cwd: PKG }).toString().trim();
    if (!REF) metaDirty = execFileSync('git', ['status', '--porcelain'], { cwd: PKG }).toString().trim().length > 0;
} catch {
    /* not a git checkout — metaSha stays 'nogit' */
}

if (REF) {
    worktree = join(tmpdir(), `gr2-bench-${metaSha}-${process.pid}`);
    // Remove the worktree even on die()/throw.
    process.on('exit', () => {
        try {
            execFileSync('git', ['worktree', 'remove', '--force', worktree], { cwd: PKG });
        } catch {
            try {
                rmSync(worktree, { recursive: true, force: true });
                execFileSync('git', ['worktree', 'prune'], { cwd: PKG });
            } catch {
                /* best effort */
            }
        }
    });
    console.log(`[bench:browser] building ${REF} (${metaSha}) in a throwaway worktree — no checkout…`);
    execFileSync('git', ['worktree', 'add', '--detach', '--force', worktree, REF], { cwd: PKG, stdio: 'inherit' });
    symlinkSync(join(PKG, 'node_modules'), join(worktree, 'node_modules')); // reuse installed deps
    execFileSync('npm', ['run', 'build'], { cwd: worktree, stdio: 'inherit' });
    DIST_DIR = join(worktree, 'dist');
}

const DIST_ESM = join(DIST_DIR, 'granny-ro.esm.js');
const DIST_WASM_ESM = join(DIST_DIR, 'granny-ro.wasm.esm.js');
if (!existsSync(DIST_ESM)) die(REF ? `build of ${REF} produced no granny-ro.esm.js` : 'dist/granny-ro.esm.js missing — run `npm run build` first.');
if (!existsSync(DIST_WASM_ESM)) die(REF ? `build of ${REF} produced no granny-ro.wasm.esm.js` : 'dist/granny-ro.wasm.esm.js missing — run `npm run build` first.');
if (!GR2_FOLDER) {
    die(
        'GR2_FOLDER is required — this bench targets real client assets.\n' +
            '  GR2_FOLDER=/path/to/extracted/gr2 npm run bench:browser\n' +
            '  (or --gr2-folder=/path). Point it at a folder of loose .gr2 files.',
    );
}
const gr2Folder = resolve(GR2_FOLDER);
if (!existsSync(gr2Folder) || !statSync(gr2Folder).isDirectory()) die(`GR2_FOLDER not a directory : ${gr2Folder}`);

// Recursive glob of .gr2, relative paths preserved (real client trees nest
// models + anims in subdirs, and basenames can collide across subdirs).
const rels = readdirSync(gr2Folder, { recursive: true })
    .map(String)
    .filter((p) => p.endsWith('.gr2'))
    .sort();
if (rels.length === 0) die(`no .gr2 found under ${gr2Folder}`);

// Fresh fixtures dir so a re-point doesn't leave stale files behind.
rmSync(BENCH_FIXTURES, { recursive: true, force: true });
mkdirSync(BENCH_FIXTURES, { recursive: true });

// 1. the ESM bundles the page imports — pure-JS + the opt-in WASM build (the
//    bench runs both across its main / worker axes).
copyFileSync(DIST_ESM, join(BENCH_DIR, 'granny-ro.esm.js'));
copyFileSync(DIST_WASM_ESM, join(BENCH_DIR, 'granny-ro.wasm.esm.js'));

// 2. the corpus (paths preserved) + an index the page fetches.
const index = rels.map((rel) => {
    const dst = join(BENCH_FIXTURES, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(join(gr2Folder, rel), dst);
    return { path: rel, bytes: statSync(dst).size };
});
writeFileSync(join(BENCH_DIR, 'fixtures.json'), JSON.stringify(index, null, 2) + '\n');

// 3. version stamp — so a downloaded batch JSON records which code version /
//    corpus it measured (the browser can't read git itself). bench.js fetches
//    this and embeds it as payload.version. sha/dirty resolved above (the ref's
//    sha when --ref, else the working-tree HEAD).
const meta = {
    label: LABEL,
    sha: metaSha,
    dirty: metaDirty,
    builtAt: new Date().toISOString(),
    gr2Folder,
    fixtureCount: index.length,
};
writeFileSync(join(BENCH_DIR, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');

const totMB = (index.reduce((s, f) => s + f.bytes, 0) / (1024 * 1024)).toFixed(1);
console.log(`[bench:browser] staged bench/browser/ from ${gr2Folder}`);
console.log(`  granny-ro.esm.js       (pure-JS build)`);
console.log(`  granny-ro.wasm.esm.js  (opt-in WASM build)`);
console.log(`  fixtures/         ${index.length} .gr2 (${totMB} MB total, recursive)`);
console.log(`  fixtures.json     index`);
console.log(`  meta.json         version ${LABEL ? `${LABEL} · ` : ''}${metaSha}${metaDirty ? '-dirty' : ''}\n`);
console.log(`Serve it, then open the URL in Chrome / Firefox :`);
console.log(`  npx http-server bench/browser -p ${PORT}`);
console.log(`  # fallback if npx can't fetch http-server :`);
console.log(`  python3 -m http.server ${PORT} --directory bench/browser\n`);
console.log(`  → http://localhost:${PORT}`);
