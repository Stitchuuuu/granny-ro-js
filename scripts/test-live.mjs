#!/usr/bin/env node
/**
 * test-live.mjs — live wine-vs-JS parity check.
 *
 * Chains :
 *   1. `regenerate-manifest.mjs --run-bake --out tests/fixtures/manifest.live.json`
 *      → runs `npm run bake` (wine + gr2_decompress.exe on sections) and
 *        `npm run bake:textures` (wine + gr2_igc_export.exe on IGC), then
 *        merges those outputs with JS structural extracts (meshes,
 *        skeletons, animations, materials) into a content-addressed v2
 *        manifest at `tests/fixtures/manifest.live.json` (gitignored).
 *   2. `test-js.mjs --manifest tests/fixtures/manifest.live.json`
 *      → JS-decompresses every fixture and sha-compares element-by-
 *        element against the wine-truth values from step 1.
 *
 * Green = JS port reproduces wine + DLL output byte-for-byte AT THIS
 * MOMENT.
 *
 * Cost : ~3 min cold (21-fixture wine bake), seconds warm.
 *
 * Prerequisites :
 *   - Wine 8+ on Linux / qemu-i386 OR Wine 9+ on macOS OR Windows native
 *   - RO_FOLDER pointing at iRO ver12 client (data.grf + granny2.dll)
 *
 * For the no-wine JS-only contract check, use `npm test` instead — it
 * verifies the JS port against the committed content-manifest.json.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const LIVE_MANIFEST = resolve(PKG_ROOT, 'tests/fixtures/manifest.live.json');

const argv = process.argv.slice(2);

function step(cmd, args) {
    process.stderr.write('[test-live] $ ' + cmd + ' ' + args.join(' ') + '\n');
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) {
        process.stderr.write(`[test-live] step failed : ${cmd} (exit=${r.status})\n`);
        process.exit(r.status ?? 1);
    }
}

step('node', [
    resolve(__dirname, 'regenerate-manifest.mjs'),
    '--run-bake',
    '--out', LIVE_MANIFEST,
    ...argv,
]);

step('node', [
    resolve(__dirname, 'test-js.mjs'),
    '--manifest', LIVE_MANIFEST,
]);

process.stderr.write('[test-live] wine bake + JS verify : green\n');
