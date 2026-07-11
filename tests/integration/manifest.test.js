/**
 * tests/integration/manifest.test.js — vitest wrapper around test-js.mjs
 * so `npm test` covers the content-addressed parity check alongside the
 * unit tests.
 *
 * What this guarantees :
 *   - Every .gr2 in `tests/fixtures/source/` (if present locally) — or,
 *     when that dir is empty and `RO_FOLDER` points at a client, the .gr2
 *     extracted from `${RO_FOLDER}/data.grf` — is looked up by sha256 in
 *     the committed content-manifest.json.
 *   - For every fixture that matches the manifest, every section /
 *     texture / mesh / skeleton / animation / material output sha is
 *     compared element-by-element vs the pinned value.
 *   - Any byte-level regression in the JS port = red test.
 *   - Unknown fixtures (not in the manifest) are reported but don't
 *     fail the test ; they're contributor opportunities to add via
 *     `npm run regenerate-manifest`.
 *
 * No wine, no DLL, no data.grf needed.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..', '..');
const SOURCE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const MANIFEST = resolve(PKG_ROOT, 'tests/fixtures/content-manifest.json');
const TEST_JS = resolve(PKG_ROOT, 'scripts/test-js.mjs');

function sourceDirHasGr2() {
    return existsSync(SOURCE_DIR) && readdirSync(SOURCE_DIR).some((n) => n.endsWith('.gr2'));
}

function roFolderHasGrf() {
    return !!process.env.RO_FOLDER && existsSync(resolve(process.env.RO_FOLDER, 'data.grf'));
}

// Runs when the manifest is present AND we have a .gr2 source : either the
// committed-style tests/fixtures/source/ dir, or a client's data.grf via
// RO_FOLDER (test-js.mjs auto-extracts from it when source/ is empty).
function hasManifestAndSource() {
    return existsSync(MANIFEST) && (sourceDirHasGr2() || roFolderHasGrf());
}

describe('content-addressed manifest parity', () => {
    if (!hasManifestAndSource()) {
        // Loud, not a quiet skip : this IS the byte-exact decode gate, so a
        // silent skip reads as "all good" when nothing was actually verified.
        console.warn(
            '\n⚠️  ══════════════════════════════════════════════════════════════════\n' +
                '⚠️  IGC sha256 parity test SKIPPED — no .gr2 fixtures found.\n' +
                '⚠️  This is the byte-exact decode gate ; nothing was verified.\n' +
                '⚠️  Enable it by supplying .gr2 one of two ways :\n' +
                '⚠️    • drop them into  tests/fixtures/source/ , or\n' +
                '⚠️    • set  RO_FOLDER=/path/to/iRO_client  (dir with data.grf)\n' +
                '⚠️      → the .gr2 are auto-extracted for the run.\n' +
                (existsSync(MANIFEST) ? '' : '⚠️  (also missing : tests/fixtures/content-manifest.json)\n') +
                '⚠️  ══════════════════════════════════════════════════════════════════\n',
        );
        it.skip('IGC sha256 parity — no .gr2 (see the ⚠️ warning above to enable)', () => {});
        return;
    }

    it('JS port reproduces every pinned sha element-by-element', () => {
        const r = spawnSync(
            'node',
            [TEST_JS, '--manifest', MANIFEST, '--source', SOURCE_DIR, '--json'],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        const stdout = r.stdout?.toString() ?? '';
        const stderr = r.stderr?.toString() ?? '';
        if (r.status !== 0) {
            throw new Error(
                `test-js failed (exit=${r.status})\nstdout:\n${stdout}\nstderr:\n${stderr}`
            );
        }
        const summary = JSON.parse(stdout);
        expect(summary.ok).toBe(true);
        expect(summary.totals.matched).toBeGreaterThan(0);
        expect(summary.totals.failed).toBe(0);
        for (const result of summary.results) {
            if (result.status === 'unknown') continue;
            expect(
                result.status,
                `fixture ${result.fixture} (${result.sha256.slice(0, 8)}) : ${JSON.stringify(result, null, 2)}`,
            ).toBe('pass');
        }
    });
});
