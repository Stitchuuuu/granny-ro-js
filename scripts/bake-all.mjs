#!/usr/bin/env node
/**
 * bake-all.mjs — section-level wine bake driver.
 *
 *  1. Ensure tests/fixtures/source/ carries the .gr2 fixtures (re-
 *     extract from `${RO_FOLDER}/data.grf` via the vendored grf-inspect
 *     tool if the dir is empty).
 *  2. Stage `granny2.dll` next to the prebuilt shim via platform.mjs.
 *  3. For each fixture : run wine + `gr2_decompress.exe` to produce a
 *     "baked" .gr2 with every section decompressed.
 *  4. Parse the baked sections and write tests/fixtures/manifest.json
 *     (v1 schema, keyed by filename + source_sha256, sections sha-d
 *     from the wine output).
 *  5. Chain bake-textures.mjs (wine + gr2_igc_export.exe → IGC RGBA).
 *
 * Consumed by `regenerate-manifest.mjs --from-wine` to produce the
 * content-addressed v2 manifest at tests/fixtures/manifest.live.json
 * (test-live.mjs orchestrates the chain).
 *
 * Re-run cost : ~3-8 s per fixture under qemu-i386-static on aarch64,
 * so ~1-3 min total for 21 fixtures. Outputs are cached by mtime ;
 * re-running is a no-op when sources haven't changed.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync,
    statSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseBakedSections } from './lib/baked.mjs';
import {
    findDecompressShim, findGranny2Dll, spawnShim, stageShimRuntime,
} from './lib/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const TESTS_FIXTURES = join(PKG, 'tests', 'fixtures');
const FIXTURE_SOURCE = join(TESTS_FIXTURES, 'source');
const FIXTURE_BAKED = join(TESTS_FIXTURES, 'baked');
const MANIFEST = join(TESTS_FIXTURES, 'manifest.json');
const GRF_INSPECT = join(__dirname, 'lib', 'grf-inspect.mjs');
const EXTRACT_TMP = process.env.EXTRACT_TMP || '/tmp/gr2-ver12';

const RO_FOLDER = process.env.RO_FOLDER;

function log(...args) { console.error('[bake]', ...args); }

function requireEnv(name, value) {
    if (!value) {
        throw new Error(
            `missing ${name} env var — see .env.example for setup. ` +
            `Cannot bake without it.`
        );
    }
    return value;
}

/**
 * Make sure source/ has .gr2 fixtures. If empty and `${RO_FOLDER}/data.grf`
 * is available, re-extracts via the vendored grf-inspect tool. Skipped
 * silently if source/ already populated.
 */
function ensureFixtures() {
    if (existsSync(FIXTURE_SOURCE) && listGR2(FIXTURE_SOURCE).length > 0) return;
    if (existsSync(EXTRACT_TMP) && listGR2(EXTRACT_TMP).length > 0) {
        return;  // EXTRACT_TMP already extracted ; main() will copy into source/
    }
    const dataGrf = join(requireEnv('RO_FOLDER', RO_FOLDER), 'data.grf');
    if (!existsSync(dataGrf)) {
        throw new Error(`missing data.grf at ${dataGrf} — bake cannot proceed`);
    }
    log('extracting .gr2 fixtures from', dataGrf, '→', EXTRACT_TMP);
    execFileSync(
        'node',
        [GRF_INSPECT, dataGrf, '--filter', '\\.gr2$', '--extract-all', EXTRACT_TMP],
        { stdio: 'inherit' },
    );
}

/** Recursively list every `*.gr2` under `dir`. Returns absolute paths. */
function listGR2(dir) {
    if (!existsSync(dir)) return [];
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...listGR2(full));
        else if (name.endsWith('.gr2')) out.push(full);
    }
    return out;
}

function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Run the wine shim on `sourcePath` → `bakedPath`, skipping if the
 * baked output is already at-or-newer-than the source.
 */
function runShim(shimExe, sourcePath, bakedPath) {
    if (existsSync(bakedPath) &&
        statSync(bakedPath).mtimeMs >= statSync(sourcePath).mtimeMs) {
        return;
    }
    const result = spawnShim(shimExe, [sourcePath, bakedPath]);
    if (result.status !== 0) {
        throw new Error(
            `wine shim failed on ${basename(sourcePath)} : ` +
            `exit=${result.status} stderr=${result.stderr?.toString()}`
        );
    }
}

function main() {
    // Stage shim + DLL into shim/runtime/ via platform.mjs (idempotent).
    const shimSrc = findDecompressShim();
    const runtimeExe = stageShimRuntime(shimSrc);
    log('shim runtime :', runtimeExe);
    log('granny2.dll  :', findGranny2Dll());

    ensureFixtures();

    mkdirSync(FIXTURE_SOURCE, { recursive: true });
    mkdirSync(FIXTURE_BAKED, { recursive: true });

    // Materialize source/ from EXTRACT_TMP if needed.
    const sourceGR2 = listGR2(FIXTURE_SOURCE).length > 0
        ? listGR2(FIXTURE_SOURCE).sort()
        : listGR2(EXTRACT_TMP).sort();
    log('found', sourceGR2.length, '.gr2 fixtures');

    const fixtures = [];
    for (const src of sourceGR2) {
        const name = basename(src);
        const dstSource = join(FIXTURE_SOURCE, name);
        const dstBaked = join(FIXTURE_BAKED, name);
        if (!existsSync(dstSource) ||
            statSync(dstSource).mtimeMs < statSync(src).mtimeMs) {
            copyFileSync(src, dstSource);
        }
        log('shim-bake', name);
        runShim(runtimeExe, dstSource, dstBaked);
        fixtures.push({
            name,
            sourcePath: dstSource,
            bakedPath: dstBaked,
        });
    }

    // Write the v1 manifest from wine truth (no Python oracle cross-check
    // — the content-addressed v2 manifest is the parity gate, and this v1
    // is just intermediate plumbing consumed by regenerate-manifest).
    const manifest = {
        generated_at: new Date().toISOString(),
        fixture_count: fixtures.length,
        fixtures: [],
    };
    for (const f of fixtures) {
        const sections = parseBakedSections(f.bakedPath).map((s, i) => ({
            index: i,
            compression: s.compression ?? 'oodle0',
            decompressed_size: s.decompressed_size,
            decompressed_sha256: s.sha256,
        }));
        manifest.fixtures.push({
            name: f.name,
            source_sha256: sha256(readFileSync(f.sourcePath)),
            baked_sha256: sha256(readFileSync(f.bakedPath)),
            sections,
        });
    }

    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    const totalSections = manifest.fixtures.reduce((acc, f) => acc + f.sections.length, 0);
    log('OK —', manifest.fixtures.length, 'fixtures /', totalSections, 'sections',
        '→', MANIFEST);

    // Chain the texture bake when the IGC shim is also available.
    if (process.env.GR2_IGC_EXPORT_EXE && existsSync(process.env.GR2_IGC_EXPORT_EXE)) {
        log('chaining bake-textures.mjs');
        const child = spawnSync('node', [join(__dirname, 'bake-textures.mjs')], {
            stdio: 'inherit',
        });
        if (child.status !== 0) {
            throw new Error(`bake-textures.mjs failed : exit=${child.status}`);
        }
    } else {
        log('skipping texture bake — GR2_IGC_EXPORT_EXE not set');
    }
}

main();
