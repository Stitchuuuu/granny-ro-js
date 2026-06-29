// Live triple-oracle integration test : JS port vs Wine-shim (canonical
// RAD granny2.dll) vs Python (Rasetsuu/blendergranny clean-room).
//
// Opt-in : runs when both
//   1. `GRANNY_LIVE_ORACLE=1` is set (matches `npm run test:live`)
//   2. the full chain is available — wine, python3, blendergranny clone,
//      gr2_decompress.exe shim, .gr2 source fixtures
//
// Skips with a clean `it.skip` carrying the reason otherwise — so CI runs
// without Wine still see a green file with a clear "live triple-oracle :
// skipped (missing: wine)" message.
//
// Cost when active : ~30-60 s on first run (Wine bake cache cold), ~10 s
// on subsequent runs (baked files cached, only Python re-runs).

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    existsSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGR2File } from '../../src/GrannyFile.js';
import { decompressSection } from '../../src/Granny.js';
import { parseBakedSections } from '../../scripts/lib/baked.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..', '..');
const FIXTURE_SOURCE = join(PKG, 'tests', 'fixtures', 'source');
const FIXTURE_BAKED  = join(PKG, 'tests', 'fixtures', 'baked');
const PYTHON_ORACLE  = join(PKG, 'scripts', 'python-oracle.py');
const SHIM_EXE       = process.env.GR2_DECOMPRESS_EXE || '';
const SHIM_DLL       = SHIM_EXE ? join(dirname(SHIM_EXE), 'granny2.dll') : '';
const BLENDERGRANNY  = process.env.BLENDERGRANNY_PATH || join(homedir(), '.cache', 'granny-ro-js', 'blendergranny');

/** Hex-encoded SHA-256 of a buffer. */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Returns `true` iff `cmd` is on `PATH` (i.e. callable as a child process). */
function commandExists(cmd) {
    const r = spawnSync('sh', ['-c', `command -v ${cmd}`], {
        stdio: 'ignore',
    });
    return r.status === 0;
}

/** Sorted list of `.gr2` basenames under `dir` ; empty array if dir missing. */
function listGR2(dir) {
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => n.endsWith('.gr2')).sort();
}

// --- gating ------------------------------------------------------------

const liveRequested = process.env.GRANNY_LIVE_ORACLE === '1';
const haveWine    = commandExists('wine');
const havePython  = commandExists('python3');
const haveShim    = existsSync(SHIM_EXE);
const haveDLL     = existsSync(SHIM_DLL);
const haveBlender = existsSync(BLENDERGRANNY);
const fixtures    = listGR2(FIXTURE_SOURCE);
const haveFixtures = fixtures.length > 0;

const reasons = [];
if (!liveRequested) reasons.push('GRANNY_LIVE_ORACLE!=1 (set GRANNY_LIVE_ORACLE=1 or use `npm run test:live`)');
if (!haveWine)      reasons.push('wine not in PATH');
if (!havePython)    reasons.push('python3 not in PATH');
if (!haveShim)      reasons.push(`shim missing at ${SHIM_EXE}`);
if (!haveDLL)       reasons.push(`granny2.dll missing at ${SHIM_DLL}`);
if (!haveBlender)   reasons.push(`blendergranny missing at ${BLENDERGRANNY}`);
if (!haveFixtures)  reasons.push(`no .gr2 fixtures under ${FIXTURE_SOURCE} (run \`npm run bake\` first)`);

const live = liveRequested && haveWine && havePython && haveShim && haveDLL && haveBlender && haveFixtures;

if (!live) {
    describe('GrannyOodle0 — live triple-oracle', () => {
        it.skip(`skipped : ${reasons.join(' ; ')}`, () => {
        });
    });
}

// --- live suite --------------------------------------------------------

describe.skipIf(!live)('GrannyOodle0 — live JS vs Wine-shim vs Python', () => {
    const shimByFixture = new Map();   // fixtureName → array of { index, sha256, decompressed_size, bytes }
    const pythonByFixture = new Map(); // fixtureName → array of { index, compression, sha256, decompressed_size }

    /**
     * One-time setup before any live test runs :
     *
     * 1. Shim-bake each source fixture (Wine + qemu + granny2.dll →
     *    a "baked" .gr2 where every section is decompressed). Cached
     *    when the baked file is at-or-newer-than the source.
     * 2. Run the Python clean-room oracle (one batched invocation over
     *    all fixtures) and parse its JSONL stdout into
     *    `pythonByFixture`.
     *
     * Throws if either oracle fails to produce a row for a fixture —
     * the live triple-oracle can't run without both witnesses.
     */
    beforeAll(() => {
        mkdirSync(FIXTURE_BAKED, {
            recursive: true,
        });

        // 1. shim-bake each source fixture (cached if baked file is fresh).
        for (const name of fixtures) {
            const src = join(FIXTURE_SOURCE, name);
            const baked = join(FIXTURE_BAKED, name);
            const stale = !existsSync(baked) || statSync(baked).mtimeMs < statSync(src).mtimeMs;
            if (stale) {
                const r = spawnSync('wine', [SHIM_EXE, src, baked], {
                    cwd: SHIM_DIR,
                    env: { ...process.env, WINEPREFIX: '/home/node/.wine' },
                    stdio: ['ignore', 'pipe', 'pipe'],
                });
                if (r.status !== 0) {
                    throw new Error(
                        `wine shim failed on ${name} : exit=${r.status} ` +
                        `stderr=${r.stderr?.toString()}`
                    );
                }
            }
            shimByFixture.set(name, parseBakedSections(baked));
        }

        // 2. Run the Python oracle in one batch over all 21 fixtures.
        const r = spawnSync(
            'python3',
            [PYTHON_ORACLE, ...fixtures.map((n) => join(FIXTURE_SOURCE, n))],
            {
                stdio: ['ignore', 'pipe', 'inherit'],
            },
        );
        if (r.status !== 0) {
            throw new Error(`python oracle failed : exit=${r.status}`);
        }
        for (const line of r.stdout.toString().split('\n')) {
            if (!line.trim()) continue;
            const obj = JSON.parse(line);
            pythonByFixture.set(obj.file, obj.sections);
        }
        for (const name of fixtures) {
            if (!pythonByFixture.has(name)) {
                throw new Error(`python oracle missed fixture ${name}`);
            }
        }
    }, /* timeout (ms) — Wine bake can take several minutes cold */ 10 * 60 * 1000);

    for (const fixtureName of fixtures) {
        describe(fixtureName, () => {
            let file;
            beforeAll(() => {
                const raw = readFileSync(join(FIXTURE_SOURCE, fixtureName));
                file = parseGR2File(raw);
            });

            // Every iRO ver12 .gr2 has exactly 6 sections (per EXISTING.md).
            for (let sectionIndex = 0; sectionIndex < 6; sectionIndex++) {
                it(`section ${sectionIndex} — JS === Wine-shim === Python`, () => {
                    const section = file.sections[sectionIndex];
                    const compressed = file.sectionBytes(section);
                    const jsBytes = decompressSection(section, compressed);
                    const jsSha = sha256(jsBytes);
                    const shim = shimByFixture.get(fixtureName)[sectionIndex];
                    const py = pythonByFixture.get(fixtureName)[sectionIndex];

                    expect(jsBytes.length, `${fixtureName} sec ${sectionIndex} length`).toBe(shim.decompressed_size);
                    expect(jsBytes.length).toBe(py.decompressed_size);

                    if (jsSha !== shim.sha256 || jsSha !== py.sha256) {
                        // Surface first byte-offset of divergence vs the shim
                        // (we have its bytes in memory). Per feedback_no_empirical_closure_re :
                        // pinpoint where it diverges, don't paper over.
                        const len = Math.min(jsBytes.length, shim.bytes.length);
                        let diffAt = -1;
                        for (let i = 0; i < len; i++) {
                            if (jsBytes[i] !== shim.bytes[i]) { diffAt = i; break; }
                        }
                        const offsetInfo = diffAt >= 0
                            ? `first JS-vs-shim byte diff at offset ${diffAt} : js=0x${jsBytes[diffAt].toString(16)} shim=0x${shim.bytes[diffAt].toString(16)}`
                            : `byte arrays equal up to len=${len} but length / sha differ — len_js=${jsBytes.length} len_shim=${shim.bytes.length}`;
                        throw new Error(
                            `${fixtureName} section ${sectionIndex} (${py.compression}) mismatch :\n` +
                            `  js     sha256 = ${jsSha}\n` +
                            `  shim   sha256 = ${shim.sha256}\n` +
                            `  python sha256 = ${py.sha256}\n` +
                            `  ${offsetInfo}`
                        );
                    }
                    expect(jsSha).toBe(shim.sha256);
                    expect(jsSha).toBe(py.sha256);
                });
            }
        });
    }
});
