#!/usr/bin/env node
/**
 * bake-all.mjs — one-shot fixture pre-bake for granny-ro-js tests.
 *
 *  1. Ensure /tmp/gr2-ver12/ has the 21 .gr2 fixtures (re-extract from
 *     data.grf via the vendored grf-inspect tool if not).
 *  2. Ensure /tmp/granny-audit/blendergranny/ exists (re-clone if not).
 *  3. Copy each fixture into tests/fixtures/source/.
 *  4. For each fixture : run the Wine + qemu-i386 + granny2.dll shim to
 *     produce a "baked" .gr2 with every section decompressed.
 *  5. Run the Python clean-room oracle over every fixture, capture per-
 *     section SHA-256s.
 *  6. Cross-check : every section's shim sha256 MUST equal Python sha256.
 *     Fail loud + exit non-zero if any mismatch (no green oracle ⇒ port
 *     can't be validated, S3' is blocked).
 *  7. Write tests/fixtures/manifest.json with per-section sha256s ; the
 *     vitest harness loads it and asserts JS output == manifest.
 *
 * Re-run cost : Wine bake is ~3-8 s per fixture under qemu-i386-static
 * on aarch64, so ~1-3 min total. Manifest is cached ; bake is one-shot
 * per container.
 */

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBakedSections } from './lib/baked.mjs';
import { spawnShim } from './lib/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const TESTS_FIXTURES = join(PKG, 'tests', 'fixtures');
const FIXTURE_SOURCE = join(TESTS_FIXTURES, 'source');
const FIXTURE_BAKED = join(TESTS_FIXTURES, 'baked');
const MANIFEST = join(TESTS_FIXTURES, 'manifest.json');
const PYTHON_ORACLE = join(__dirname, 'python-oracle.py');

// Vendored GRF inspector — self-contained, only node built-ins.
const GRF_INSPECT = join(__dirname, 'lib', 'grf-inspect.mjs');

// Env-driven paths. See .env.example for the contract.
//
//   RO_FOLDER             — host path to the user's iRO ver12 client
//                           (must contain data.grf + granny2.dll).
//   BLENDERGRANNY_PATH    — local checkout of Rasetsuu/blendergranny.
//                           Defaults to ~/.cache/granny-ro-js/blendergranny ;
//                           cloned by `npm run setup:oracle` if missing.
//   GR2_DECOMPRESS_EXE    — Wine shim binary built from shim/gr2_decompress.c.
//                           Same dir is expected to contain granny2.dll
//                           (typically a symlink into RO_FOLDER).
const DEFAULT_BLENDERGRANNY = join(homedir(), '.cache', 'granny-ro-js', 'blendergranny');

const RO_FOLDER = process.env.RO_FOLDER;
const BLENDERGRANNY = process.env.BLENDERGRANNY_PATH || DEFAULT_BLENDERGRANNY;
const SHIM_EXE = process.env.GR2_DECOMPRESS_EXE;

function requireEnv(name, value) {
    if (!value) {
        throw new Error(
            `missing ${name} env var — see .env.example for setup. ` +
            `Cannot bake without it.`
        );
    }
    return value;
}

const BLENDERGRANNY_REPO = 'https://github.com/Rasetsuu/blendergranny';
const EXTRACT_TMP = process.env.EXTRACT_TMP || '/tmp/gr2-ver12';

/** Tagged stderr logger so bake output is greppable in CI / dev-log. */
function log(...args) { console.error('[bake]', ...args); }

/**
 * Make sure `${EXTRACT_TMP}` carries the 21 .gr2 fixtures. Re-extracts
 * them from `${RO_FOLDER}/data.grf` via the vendored grf-inspect tool
 * if missing (e.g. after a container rebuild wiped `/tmp`).
 */
function ensureExtracted() {
    if (existsSync(EXTRACT_TMP) && listGR2(EXTRACT_TMP).length >= 21) return;
    const dataGrf = join(requireEnv('RO_FOLDER', RO_FOLDER), 'data.grf');
    log('extracting .gr2 fixtures from', dataGrf, '→', EXTRACT_TMP);
    if (!existsSync(dataGrf)) {
        throw new Error(`missing data.grf at ${dataGrf} — bake cannot proceed`);
    }
    execFileSync(
        'node',
        [GRF_INSPECT, dataGrf, '--filter', '\\.gr2$', '--extract-all', EXTRACT_TMP],
        {
            stdio: 'inherit',
        },
    );
}

/**
 * Make sure the Rasetsuu/blendergranny clean-room Python decoder is
 * present at `${BLENDERGRANNY_PATH}`. Delegates to the dedicated
 * `setup:oracle` script, which is idempotent (clones if missing, no-op
 * otherwise).
 */
function ensureBlendergranny() {
    const setupScript = join(__dirname, 'setup-blendergranny.mjs');
    execFileSync('node', [setupScript], { stdio: 'inherit' });
}

/**
 * Make sure the Wine shim (`gr2_decompress.exe` + colocated `granny2.dll`)
 * is in place. The shim binary is built from `shim/gr2_decompress.c` at
 * Docker image build time ; outside Docker, contributors build it
 * themselves (see CONTRIBUTING.md). `granny2.dll` is provided by the
 * user's iRO client and typically symlinked next to the shim binary.
 */
function ensureShim() {
    requireEnv('GR2_DECOMPRESS_EXE', SHIM_EXE);
    if (!existsSync(SHIM_EXE)) {
        throw new Error(
            `missing shim at ${SHIM_EXE} — build it from shim/gr2_decompress.c ` +
            `(mingw + Wine) or use the bundled Docker image. See CONTRIBUTING.md.`
        );
    }
    // Wine resolves DLLs by bare name from the .exe's directory : symlink
    // granny2.dll next to the shim if missing. Source is the user's iRO
    // client (granny2.dll is RAD copyright, never shipped here).
    const grannyDll = join(dirname(SHIM_EXE), 'granny2.dll');
    if (!existsSync(grannyDll)) {
        const source = join(requireEnv('RO_FOLDER', RO_FOLDER), 'granny2.dll');
        if (!existsSync(source)) {
            throw new Error(
                `missing granny2.dll : neither ${grannyDll} nor ${source} exist. ` +
                `Copy or symlink granny2.dll from your iRO client into ${dirname(SHIM_EXE)}/.`
            );
        }
        log('symlinking granny2.dll →', grannyDll, '(source:', source + ')');
        symlinkSync(source, grannyDll);
    }
}

/** Recursively list every `*.gr2` under `dir`. Returns absolute paths. */
function listGR2(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) out.push(...listGR2(full));
        else if (name.endsWith('.gr2')) out.push(full);
    }
    return out;
}

/** Hex-encoded SHA-256 of a buffer. */
function sha256(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// --- shim bake ----------------------------------------------------------

/**
 * Run the Wine shim on `sourcePath` → `bakedPath`, skipping if the baked
 * output is already at-or-newer-than the source (caches across runs).
 *
 * The shim binary's directory becomes Wine's working dir, so it can
 * `LoadLibrary("granny2.dll")` by bare name (granny2.dll lives next to
 * the exe).
 */
function runShim(sourcePath, bakedPath) {
    if (existsSync(bakedPath) &&
        statSync(bakedPath).mtimeMs >= statSync(sourcePath).mtimeMs) {
        return;  // cached
    }
    const result = spawnShim(SHIM_EXE, [sourcePath, bakedPath]);
    if (result.status !== 0) {
        throw new Error(
            `wine shim failed on ${basename(sourcePath)} : ` +
            `exit=${result.status} stderr=${result.stderr?.toString()}`
        );
    }
}

// --- python oracle ------------------------------------------------------

/**
 * Run `python-oracle.py` against every fixture path in one batched
 * subprocess and parse its JSONL stdout into `{ filename: sections[] }`.
 * Throws if the subprocess exits non-zero.
 */
function runPythonOracle(fixturePaths) {
    log('running Python oracle on', fixturePaths.length, 'fixtures');
    const result = spawnSync(
        'python3',
        [PYTHON_ORACLE, ...fixturePaths],
        {
            stdio: ['ignore', 'pipe', 'inherit'],
        },
    );
    if (result.status !== 0) {
        throw new Error(`python-oracle.py failed : exit=${result.status}`);
    }
    const byName = {};
    for (const line of result.stdout.toString().split('\n')) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        byName[obj.file] = obj.sections;
    }
    return byName;
}

// --- main pipeline ------------------------------------------------------

/**
 * Main bake driver — orchestrates extraction, shim bake, Python oracle,
 * cross-check + manifest write. Exits 2 if oracles disagree on any
 * section (S3' can't proceed without both oracles green).
 */
function main() {
    ensureShim();
    ensureBlendergranny();
    ensureExtracted();

    const sourceGR2 = listGR2(EXTRACT_TMP).sort();
    log('found', sourceGR2.length, '.gr2 fixtures in', EXTRACT_TMP);

    mkdirSync(FIXTURE_SOURCE, {
        recursive: true,
    });
    mkdirSync(FIXTURE_BAKED, {
        recursive: true,
    });

    // Copy + shim-bake each fixture.
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
        runShim(dstSource, dstBaked);
        fixtures.push({
            name,
            sourcePath: dstSource,
            bakedPath: dstBaked,
        });
    }

    // Run the Python oracle in one batch.
    const pythonByName = runPythonOracle(fixtures.map((f) => f.sourcePath));

    // Compare + assemble manifest.
    const manifest = {
        generated_at: new Date().toISOString(),
        fixture_count: fixtures.length,
        fixtures: [],
    };
    let mismatchCount = 0;
    for (const f of fixtures) {
        const shimSections = parseBakedSections(f.bakedPath);
        const pythonSections = pythonByName[f.name];
        if (!pythonSections) {
            throw new Error(`python-oracle produced no row for ${f.name}`);
        }
        if (shimSections.length !== pythonSections.length) {
            throw new Error(
                `${f.name} : section count mismatch shim=${shimSections.length} ` +
                `python=${pythonSections.length}`
            );
        }
        const merged = [];
        for (let i = 0; i < shimSections.length; i++) {
            const shim = shimSections[i];
            const py = pythonSections[i];
            if (shim.sha256 !== py.sha256) {
                mismatchCount += 1;
                log('MISMATCH', f.name, 'section', i,
                    `shim=${shim.sha256.slice(0, 16)}…`,
                    `python=${py.sha256.slice(0, 16)}…`);
            }
            if (shim.decompressed_size !== py.decompressed_size) {
                throw new Error(
                    `${f.name} section ${i} size mismatch shim=${shim.decompressed_size} ` +
                    `python=${py.decompressed_size}`
                );
            }
            merged.push({
                index: i,
                compression: py.compression,
                decompressed_size: py.decompressed_size,
                decompressed_sha256: py.sha256,
            });
        }
        manifest.fixtures.push({
            name: f.name,
            source_sha256: sha256(readFileSync(f.sourcePath)),
            baked_sha256: sha256(readFileSync(f.bakedPath)),
            sections: merged,
        });
    }

    if (mismatchCount > 0) {
        log('FAIL — ', mismatchCount, 'oracle disagreements. Manifest NOT written.');
        process.exit(2);
    }

    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
    const totalSections = manifest.fixtures.reduce((acc, f) => acc + f.sections.length, 0);
    const oodleCount = manifest.fixtures.reduce(
        (acc, f) => acc + f.sections.filter((s) => s.compression === 'oodle0').length,
        0,
    );
    const noneCount = manifest.fixtures.reduce(
        (acc, f) => acc + f.sections.filter((s) => s.compression === 'none').length,
        0,
    );
    log('OK —', manifest.fixtures.length, 'fixtures /', totalSections, 'sections',
        `(oodle0=${oodleCount}, none=${noneCount})`,
        '→', MANIFEST);

    // Chain the texture bake — runs the Wine shim over each fixture's
    // textures and appends a `textures` array to manifest.json. Skipped
    // automatically when GR2_IGC_EXPORT_EXE is unset / missing (e.g.
    // bake-free unit-test path) by bake-textures.mjs's own preflight.
    if (process.env.GR2_IGC_EXPORT_EXE && existsSync(process.env.GR2_IGC_EXPORT_EXE)) {
        log('chaining bake-textures.mjs (GR2_IGC_EXPORT_EXE='
            + process.env.GR2_IGC_EXPORT_EXE + ')');
        const child = spawnSync('node', [join(__dirname, 'bake-textures.mjs')], {
            stdio: 'inherit',
        });
        if (child.status !== 0) {
            throw new Error(`bake-textures.mjs failed : exit=${child.status}`);
        }
    } else {
        log('skipping texture bake — set GR2_IGC_EXPORT_EXE to enable');
    }
}

main();
