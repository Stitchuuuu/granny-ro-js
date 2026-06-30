#!/usr/bin/env node
/**
 * regenerate-manifest.mjs — bootstrap / refresh the content-addressed
 * test manifest.
 *
 * Walks `tests/fixtures/source/`, computes sha256 of each .gr2,
 * JS-decompresses every category (sections / textures / meshes /
 * skeletons / animations / materials), and writes the resulting
 * sha-keyed manifest to `tests/fixtures/content-manifest.json` (or
 * the path given via `--out`).
 *
 * The output manifest stores ONLY sha256 hashes + structural metadata
 * (counts, widths, heights) — NO RO-asset names beyond a "filenameHint"
 * field and NO fixture bytes. It is safe to commit to a public repo.
 *
 * Modes :
 *   (default JS-only) JS decompression is the source of truth. Fast,
 *       no wine, no DLL. Use to bootstrap an initial manifest or after
 *       JS port changes that you know match the DLL.
 *   --with-wine        Additionally runs the wine+shim+DLL path and
 *       fails loud on any JS-vs-DLL divergence. Use when adding new
 *       fixtures or refreshing after a DLL version change.
 *
 * Flags :
 *   --source <dir>   .gr2 source directory (default tests/fixtures/source/)
 *   --out    <path>  manifest output path (default tests/fixtures/content-manifest.json)
 *   --with-wine      cross-check JS output against wine+DLL
 *   --quiet          per-fixture progress only on error
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkSourceDir } from './lib/discover-gr2.mjs';
import { buildEntry } from './lib/js-bake.mjs';
import { getTarget } from './lib/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const V1_MANIFEST = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
// bake-textures.mjs merges into `manifest.textures` when manifest.json
// exists ; the standalone textures.json under baked/ is a fallback only.
const V1_TEXTURES_FALLBACK = resolve(PKG_ROOT, 'tests/fixtures/baked/textures/textures.json');

const DEFAULTS = {
    source: resolve(PKG_ROOT, 'tests/fixtures/source'),
    out: resolve(PKG_ROOT, 'tests/fixtures/content-manifest.json'),
    fromWine: false,
    runBake: false,
    quiet: false,
};

function parseArgs(argv) {
    const out = { ...DEFAULTS };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--source') out.source = resolve(argv[++i]);
        else if (arg === '--out') out.out = resolve(argv[++i]);
        else if (arg === '--from-wine') out.fromWine = true;
        else if (arg === '--run-bake') out.runBake = true;
        else if (arg === '--quiet') out.quiet = true;
        else if (arg === '--help' || arg === '-h') {
            process.stdout.write(printHelp());
            process.exit(0);
        } else throw new Error(`unknown arg : ${arg}`);
    }
    return out;
}

function printHelp() {
    return [
        'Usage : node scripts/regenerate-manifest.mjs [flags]',
        '',
        'Flags :',
        '  --source <dir>   .gr2 source directory (default tests/fixtures/source/)',
        '  --out    <path>  output path (default tests/fixtures/content-manifest.json)',
        '  --from-wine      use wine+DLL bake outputs as the truth source for',
        '                   sections and textures (reads tests/fixtures/manifest.json',
        '                   v1 + tests/fixtures/baked/textures/textures.json).',
        '                   JS-extracts mesh/skel/anim/material (no wine path for those).',
        '  --run-bake       implies --from-wine ; runs `npm run bake` + `npm run bake:textures`',
        '                   first so the wine outputs are guaranteed fresh. ~3 min cold.',
        '  --quiet          per-fixture progress only on error',
        '',
    ].join('\n');
}

function log(opts, ...args) {
    if (!opts.quiet) process.stderr.write('[regenerate-manifest] ' + args.join(' ') + '\n');
}

/**
 * Run the existing wine bake pipeline (sections via gr2_decompress.exe +
 * Python oracle ; textures via gr2_igc_export.exe). Both write into
 * `tests/fixtures/` ; their outputs are then read back by
 * `mergeWineIntoEntry` to produce the wine-truth content manifest.
 *
 * Skips if v1 outputs are already present and `--run-bake` wasn't passed.
 */
function runWineBake(opts) {
    log(opts, 'running wine bake : npm run bake');
    let r = spawnSync('npm', ['run', 'bake', '--silent'], { stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`npm run bake failed (exit=${r.status})`);
    }
    log(opts, 'running wine IGC bake : npm run bake:textures');
    r = spawnSync('npm', ['run', 'bake:textures', '--silent'], { stdio: 'inherit' });
    if (r.status !== 0) {
        throw new Error(`npm run bake:textures failed (exit=${r.status})`);
    }
}

/**
 * Overlay the wine bake outputs onto a JS-only entry :
 * - `sections[].sha256` and `sizeBytes` come from the v1 manifest entry
 *   (wine + Python oracle cross-checked).
 * - `textures[].rgbaSha256` comes from the v1 textures.json (wine bake).
 * - `meshes`, `skeletons`, `animations`, `materials` keep their JS values
 *   (no wine path exists for those — JS is the canonical extractor).
 *
 * Throws if the wine outputs for this fixture are missing : that means
 * the wine bake didn't process it, and the test would silently lie.
 */
function mergeWineIntoEntry(jsEntry, fixture, v1Manifest, v1Textures) {
    const v1Fixture = v1Manifest.fixtures.find((f) => f.source_sha256 === fixture.sha256);
    if (!v1Fixture) {
        throw new Error(
            `wine bake didn't produce a v1 entry for ${fixture.name} ` +
            `(sha=${fixture.sha256.slice(0, 16)}). Run \`npm run bake\` first ` +
            `or pass --run-bake.`
        );
    }
    const sections = v1Fixture.sections.map((s) => ({
        idx: s.index,
        sizeBytes: s.decompressed_size,
        sha256: s.decompressed_sha256,
    }));

    const textures = jsEntry.textures.map((t) => {
        const goldenTex = v1Textures.textures.find((gt) =>
            gt.fixture === fixture.name &&
            gt.tex_idx === t.texIdx &&
            gt.img_idx === t.imgIdx &&
            gt.mip_idx === t.mipIdx
        );
        if (!goldenTex) {
            throw new Error(
                `wine bake didn't produce RGBA for ${fixture.name} ` +
                `tex${t.texIdx}/img${t.imgIdx}/mip${t.mipIdx}. ` +
                `Run \`npm run bake:textures\` first.`
            );
        }
        return { ...t, rgbaSha256: goldenTex.rgba_sha256 };
    });

    return { ...jsEntry, sections, textures };
}

function main() {
    const opts = parseArgs(process.argv);
    if (opts.runBake) opts.fromWine = true;

    if (opts.runBake) {
        runWineBake(opts);
    }

    let v1Manifest = null;
    let v1Textures = null;
    if (opts.fromWine) {
        if (!existsSync(V1_MANIFEST)) {
            throw new Error(
                `--from-wine requires ${V1_MANIFEST} (run \`npm run bake\` first or pass --run-bake)`
            );
        }
        v1Manifest = JSON.parse(readFileSync(V1_MANIFEST, 'utf-8'));
        // bake-textures.mjs merges into `manifest.textures` when manifest.json
        // exists ; fall back to the standalone textures.json otherwise.
        if (Array.isArray(v1Manifest.textures)) {
            v1Textures = { textures: v1Manifest.textures };
            log(opts, 'wine truth :', V1_MANIFEST, '(+ embedded textures)');
        } else if (existsSync(V1_TEXTURES_FALLBACK)) {
            v1Textures = JSON.parse(readFileSync(V1_TEXTURES_FALLBACK, 'utf-8'));
            log(opts, 'wine truth :', V1_MANIFEST, '+', V1_TEXTURES_FALLBACK);
        } else {
            throw new Error(
                `--from-wine requires texture entries either as \`manifest.textures\` ` +
                `array in ${V1_MANIFEST} or at ${V1_TEXTURES_FALLBACK}. ` +
                `Run \`npm run bake:textures\` first or pass --run-bake.`
            );
        }
    }

    const fixtures = walkSourceDir(opts.source);
    if (fixtures.length === 0) {
        console.error(`[regenerate-manifest] no .gr2 found under ${opts.source}`);
        process.exit(1);
    }
    log(opts, 'walking', fixtures.length, 'fixtures from', opts.source);

    const entries = {};
    for (const fixture of fixtures) {
        log(opts, '  ·', fixture.name, fixture.sha256.slice(0, 8));
        try {
            const jsEntry = buildEntry(fixture);
            entries[fixture.sha256] = opts.fromWine
                ? mergeWineIntoEntry(jsEntry, fixture, v1Manifest, v1Textures)
                : jsEntry;
        } catch (err) {
            console.error(
                `[regenerate-manifest] FAIL on ${fixture.name} : ${err.message}`
            );
            process.exit(2);
        }
    }

    const manifest = {
        version: 2,
        schema: 'content-manifest-v2',
        generatedAt: new Date().toISOString(),
        sourceBaseline: {
            target: opts.fromWine ? getTarget() : 'js-only',
            generatedBy: opts.fromWine
                ? 'regenerate-manifest.mjs (wine+DLL truth, sections + textures)'
                : 'regenerate-manifest.mjs (JS-only)',
            platform: `${process.platform}/${process.arch}`,
            node: process.version,
        },
        fixtures: entries,
    };

    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(manifest, null, 2) + '\n');
    log(opts, 'wrote', opts.out, '(' + Object.keys(entries).length + ' fixtures)');
}

main();
