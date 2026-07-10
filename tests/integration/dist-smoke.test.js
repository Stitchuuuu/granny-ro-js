/**
 * tests/integration/dist-smoke.test.js — dual-publish smoke gate.
 *
 * Imports the built distribution (ESM + CJS + code-split), runs the public
 * flow (`Granny.ready()` → `parseTextured`), decodes one IGC texture and
 * asserts its RGBA sha256 matches the pinned content manifest. Catches
 * dual-publish breakage (a bundler swallowing an export, a broken CJS interop,
 * a mis-wired code-split chunk) in one gate.
 *
 * Skips cleanly when `npm run build` hasn't run or the gitignored fixture
 * corpus is absent — same guard shape as manifest.test.js.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const DIST_ESM = resolve(ROOT, 'dist/granny-ro.esm.js');
const DIST_CJS = resolve(ROOT, 'dist/granny-ro.cjs');
const DIST_GLOBAL = resolve(ROOT, 'dist/granny-ro.global.js');
const DIST_SPLIT = resolve(ROOT, 'dist/granny-ro.split.esm.js');
const MANIFEST = resolve(ROOT, 'tests/fixtures/content-manifest.json');
const FIXTURE = resolve(ROOT, 'tests/fixtures/source/empelium90_0.gr2');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function distAndFixturesPresent() {
    return (
        existsSync(DIST_ESM) &&
        existsSync(DIST_CJS) &&
        existsSync(DIST_GLOBAL) &&
        existsSync(DIST_SPLIT) &&
        existsSync(MANIFEST) &&
        existsSync(FIXTURE)
    );
}

describe('dist-smoke : built-package parity', () => {
    if (!distAndFixturesPresent()) {
        it.skip('skipped : run `npm run build` and provide tests/fixtures/source/', () => {});
        return;
    }

    const bytes = new Uint8Array(readFileSync(FIXTURE));
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
    const entry = manifest.fixtures[sha256(readFileSync(FIXTURE))];
    // First IGC (encoding=3) texture record — the one that exercises the
    // ~2 000-line decoder that the code-split build lazy-loads.
    const expected = entry.textures.find((t) => t.encoding === 3);

    function decodedIGCSha(mod) {
        const res = mod.parseTextured(bytes);
        const rec = res.textures.find(
            (t) =>
                t.texIdx === expected.texIdx &&
                t.imgIdx === expected.imgIdx &&
                t.mipIdx === expected.mipIdx,
        );
        return sha256(rec.pixels);
    }

    it('ESM build : Granny.ready() resolves + IGC sha matches manifest', async () => {
        const mod = await import(pathToFileURL(DIST_ESM).href);
        await expect(mod.Granny.ready()).resolves.toBeUndefined();
        await mod.loadTextureCodec(); // no-op in the default build (IGC inlined)
        expect(decodedIGCSha(mod)).toBe(expected.rgbaSha256);
    });

    it('IIFE global build : window.GrannyRO + IGC sha matches manifest', () => {
        // Load exactly like a browser `<script src>` : eval at a scope where
        // the IIFE's top-level `var GrannyRO` becomes reachable.
        const scope = {};
        new Function('globalThis', readFileSync(DIST_GLOBAL, 'utf8') + '\nglobalThis.__g = GrannyRO;')(scope);
        const mod = scope.__g;
        expect(typeof mod).toBe('object');
        expect(decodedIGCSha(mod)).toBe(expected.rgbaSha256);
    });

    it('CJS build : require() interop + IGC sha matches manifest', async () => {
        const require = createRequire(import.meta.url);
        const mod = require(DIST_CJS);
        await mod.Granny.ready();
        expect(decodedIGCSha(mod)).toBe(expected.rgbaSha256);
    });

    it('code-split build : IGC throws before warmup, matches after loadTextureCodec()', async () => {
        const mod = await import(pathToFileURL(DIST_SPLIT).href);
        // anim-only / pre-warmup : the lazy codec refuses rather than returning garbage.
        expect(() => mod.parseTextured(bytes)).toThrow(/loadTextureCodec/);
        await mod.loadTextureCodec();
        expect(decodedIGCSha(mod)).toBe(expected.rgbaSha256);
    });
});
