#!/usr/bin/env node
/**
 * test-live-wine.mjs — real wine-vs-JS live parity check.
 *
 * Chain :
 *   1. `regenerate-manifest.mjs --run-bake --out tests/fixtures/manifest.live.json`
 *      → runs `npm run bake` (wine + gr2_decompress.exe + Python oracle
 *        cross-check on sections) and `npm run bake:textures` (wine +
 *        gr2_igc_export.exe on IGC textures), then merges those outputs
 *        with JS structural extracts (meshes / skeletons / animations /
 *        materials) into a content-addressed v2 manifest.
 *   2. `test-js.mjs --manifest tests/fixtures/manifest.live.json`
 *      → JS-decompresses every fixture and sha-compares element-by-
 *        element against the wine-truth values from step 1.
 *
 * Green = JS port reproduces wine+DLL output byte-for-byte AT THIS MOMENT.
 *
 * Cost : ~3 min cold (wine bake of 21 fixtures), seconds warm. Heavy
 * compared to `npm run test:js` (which uses the committed manifest, ~700 ms).
 *
 * Prerequisites :
 *   - Wine + qemu-i386 (Linux) OR Wine 9+ (macOS) OR direct exec (Windows)
 *   - RO_FOLDER pointing at iRO ver12 client (data.grf + granny2.dll)
 *   - Python 3 for the section-level Oodle0 oracle cross-check
 *     (handled by setup:oracle / Dockerfile, or `pip install` locally)
 *
 * For a fast JS-only smoke check (no wine, no DLL), use `npm run test:live-regen`.
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const LIVE_MANIFEST = resolve(PKG_ROOT, 'tests/fixtures/manifest.live.json');

const argv = process.argv.slice(2);

function step(cmd, args) {
    process.stderr.write('[test-live-wine] $ ' + cmd + ' ' + args.join(' ') + '\n');
    const r = spawnSync(cmd, args, { stdio: 'inherit' });
    if (r.status !== 0) {
        process.stderr.write(`[test-live-wine] step failed : ${cmd} (exit=${r.status})\n`);
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

process.stderr.write('[test-live-wine] wine bake + JS verify : green\n');
