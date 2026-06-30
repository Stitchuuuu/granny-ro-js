#!/usr/bin/env node
/**
 * test-live.mjs — live wine-vs-JS parity check, ephemeral.
 *
 * Pipeline (4 phases, ~3 min cold) :
 *
 *   [1/4] Section bake     : `npm run bake` (wine + gr2_decompress.exe on
 *                            21 fixtures → tests/fixtures/manifest.json)
 *   [2/4] Texture bake     : `npm run bake:textures` (wine + gr2_igc_export.exe
 *                            on 17 IGC textures → merged into manifest.json)
 *   [3/4] Manifest merge   : `regenerate-manifest --from-wine --out manifest.live.json`
 *                            (joins wine truth + JS structural extracts)
 *   [4/4] JS contract test : `test-js --manifest manifest.live.json`
 *
 * Green = JS port reproduces wine + DLL output byte-for-byte AT THIS
 * MOMENT. Doesn't touch the committed content-manifest.json.
 *
 * On green, ALL temp artifacts are cleaned (manifest.live.json, the v1
 * tests/fixtures/manifest.json, tests/fixtures/baked/, shim/runtime/).
 * On red, the artifacts are kept so you can inspect the divergence.
 *
 * Prerequisites :
 *   - Wine (Linux container has it ; macOS via Wine.app or brew)
 *   - RO_FOLDER set (data.grf + granny2.dll)
 *
 * For the no-wine JS-only contract check, use `npm test` instead.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const LIVE_MANIFEST = resolve(PKG_ROOT, 'tests/fixtures/manifest.live.json');
const V1_MANIFEST   = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const BAKED_DIR     = resolve(PKG_ROOT, 'tests/fixtures/baked');
const SHIM_RUNTIME  = resolve(PKG_ROOT, 'shim/runtime');

// ANSI colors — honor NO_COLOR + only emit on TTY (CI logs stay plain).
const isTTY = process.stderr.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold    = c('1');
const dim     = c('2');
const red     = c('31');
const green   = c('32');
const yellow  = c('33');
const cyan    = c('36');

const SYM_RUN  = isTTY ? '→' : '>';
const SYM_OK   = isTTY ? '✓' : 'OK';
const SYM_FAIL = isTTY ? '✗' : 'FAIL';
const TAG = bold(cyan('[test-live]'));

const PHASES = [
    {
        label: 'section bake (wine + gr2_decompress.exe → manifest.json)',
        cmd: 'npm', args: ['run', 'bake', '--silent'],
    },
    {
        label: 'texture bake (wine + gr2_igc_export.exe → 17 IGC RGBA)',
        cmd: 'npm', args: ['run', 'bake:textures', '--silent'],
    },
    {
        label: 'manifest merge (wine truth + JS structural extracts)',
        cmd: 'node', args: [
            resolve(__dirname, 'regenerate-manifest.mjs'),
            '--from-wine', '--out', LIVE_MANIFEST, '--quiet',
        ],
    },
    {
        label: 'JS test against the fresh manifest',
        cmd: 'node', args: [
            resolve(__dirname, 'test-js.mjs'),
            '--manifest', LIVE_MANIFEST, '--quiet',
        ],
    },
];

function fmtDuration(ms) {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    return `${Math.floor(ms / 60_000)} m ${Math.round((ms % 60_000) / 1000)} s`;
}

function runPhase(idx, total, phase, startedAt) {
    const head = `${TAG} ${cyan(SYM_RUN)} ${bold(`[${idx}/${total}]`)}`;
    const elapsed = Date.now() - startedAt;
    process.stderr.write(
        `${head} ${phase.label} ${dim(`(+${fmtDuration(elapsed)} elapsed)`)}\n`
    );
    const t0 = Date.now();
    const r = spawnSync(phase.cmd, phase.args, { stdio: 'inherit' });
    const dt = Date.now() - t0;
    if (r.status !== 0) {
        process.stderr.write(
            `${TAG} ${red(SYM_FAIL)} ${bold(`[${idx}/${total}]`)} ` +
            `${red('failed')} in ${fmtDuration(dt)} ${dim(`(exit=${r.status})`)}\n` +
            `${TAG} ${yellow('temp artifacts kept for inspection')}\n`
        );
        process.exit(r.status ?? 1);
    }
    process.stderr.write(
        `${TAG} ${green(SYM_OK)} ${bold(`[${idx}/${total}]`)} done in ${green(fmtDuration(dt))}\n`
    );
}

function cleanup() {
    process.stderr.write(`${TAG} ${dim('cleaning up temp artifacts...')}\n`);
    for (const path of [LIVE_MANIFEST, V1_MANIFEST, BAKED_DIR, SHIM_RUNTIME]) {
        if (existsSync(path)) rmSync(path, { recursive: true, force: true });
    }
}

const startedAt = Date.now();
process.stderr.write(
    `${TAG} pipeline started — ${bold(PHASES.length)} phases, ` +
    `${dim('~3 min cold, seconds warm')}\n`
);
for (let i = 0; i < PHASES.length; i++) {
    runPhase(i + 1, PHASES.length, PHASES[i], startedAt);
}

cleanup();

const total = Date.now() - startedAt;
process.stderr.write(
    `${TAG} ${green(SYM_OK)} ${green(bold('wine bake + JS verify : green'))} ` +
    `in ${green(fmtDuration(total))}\n`
);
