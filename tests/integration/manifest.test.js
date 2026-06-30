/**
 * tests/integration/manifest.test.js — vitest wrapper around test-js.mjs
 * so `npm test` covers the content-addressed parity check alongside the
 * unit tests.
 *
 * What this guarantees :
 *   - Every .gr2 in `tests/fixtures/source/` (if present locally) is
 *     looked up by sha256 in the committed content-manifest.json.
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

function hasFixturesAndManifest() {
    if (!existsSync(MANIFEST)) return false;
    if (!existsSync(SOURCE_DIR)) return false;
    return readdirSync(SOURCE_DIR).some((n) => n.endsWith('.gr2'));
}

describe('content-addressed manifest parity', () => {
    if (!hasFixturesAndManifest()) {
        it.skip('skipped : tests/fixtures/source/ empty or no content-manifest.json', () => {});
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
