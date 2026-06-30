#!/usr/bin/env node
/**
 * test-live.mjs — regenerate-then-test, ephemeral manifest.
 *
 * Chains :
 *   1. `regenerate-manifest.mjs --out tests/fixtures/manifest.live.json`
 *      → JS-decompresses every .gr2 in source/, writes a temp manifest.
 *   2. `test-js.mjs --manifest tests/fixtures/manifest.live.json`
 *      → JS-decompresses again, verifies sha-equality element-by-element.
 *
 * In strict JS-only mode this is a tautology (step 2 always passes if
 * step 1 succeeded, since both are pure JS on the same input). Its value
 * shows when `--with-wine` is passed : regen cross-checks JS vs the
 * wine+DLL shim and refuses to write divergent entries to the manifest,
 * so a green run proves JS+DLL agree byte-for-byte AT THIS MOMENT.
 *
 * Use cases :
 *   - After a DLL version bump : confirm JS+new-DLL still agree.
 *   - Contributor flow : test JS changes end-to-end without amending the
 *     pinned committed manifest in the same PR.
 *   - CI / multi-host : re-derive the manifest fresh on a contributor's
 *     box and verify locally.
 *
 * Flags forward to both children — see their --help.
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
    '--out', LIVE_MANIFEST,
    ...argv,
]);

step('node', [
    resolve(__dirname, 'test-js.mjs'),
    '--manifest', LIVE_MANIFEST,
]);

process.stderr.write('[test-live] live regen + verify : green\n');
