/**
 * tests/integration/wasm-corpus.test.js — whole-corpus IGC sha gate for the
 * WASM build.
 *
 * dist-smoke.test.js proves the wasm build wires up (one fixture / one
 * texture). This gate goes wide : it decodes EVERY IGC (encoding=3) texture in
 * EVERY present fixture through the built `dist/granny-ro.wasm.esm.js` and
 * asserts each RGBA sha256 matches the pinned content manifest — the same
 * oracle `manifest.test.js` checks for the raw-JS source. As sessions 2-4 move
 * more kernels into WASM, this catches any per-fixture byte drift immediately.
 *
 * Skips cleanly when `npm run build` hasn't run or the gitignored fixture
 * corpus is absent — same guard shape as manifest.test.js / dist-smoke.test.js.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');

const DIST_WASM = resolve(ROOT, 'dist/granny-ro.wasm.esm.js');
const MANIFEST = resolve(ROOT, 'tests/fixtures/content-manifest.json');
const SRC_DIR = resolve(ROOT, 'tests/fixtures/source');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function present() {
    return existsSync(DIST_WASM) && existsSync(MANIFEST) && existsSync(SRC_DIR);
}

describe('wasm-corpus : IGC decode sha parity vs manifest (whole corpus)', () => {
    if (!present()) {
        it.skip('skipped : run `npm run build` and provide tests/fixtures/source/', () => {});
        return;
    }

    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

    // Every present .gr2 that (a) has a manifest entry and (b) carries at least
    // one IGC texture. Maps a source file to its manifest entry by hashing the
    // bytes, exactly like dist-smoke / test-js.
    const cases = [];
    let igcTextureTotal = 0;
    for (const f of readdirSync(SRC_DIR)) {
        if (!f.endsWith('.gr2')) continue;
        const bytes = new Uint8Array(readFileSync(resolve(SRC_DIR, f)));
        const entry = manifest.fixtures[sha256(bytes)];
        if (!entry) continue;
        const igc = (entry.textures ?? []).filter((t) => t.encoding === 3);
        if (igc.length === 0) continue;
        cases.push({ file: f, bytes, igc });
        igcTextureTotal += igc.length;
    }

    /** @type {any} */
    let mod;
    beforeAll(async () => {
        mod = await import(pathToFileURL(DIST_WASM).href);
        await mod.Granny.ready(); // real WASM instantiation
        if (typeof mod.loadTextureCodec === 'function') await mod.loadTextureCodec();
    });

    it('finds at least one IGC-bearing fixture in the corpus', () => {
        expect(cases.length).toBeGreaterThan(0);
        expect(igcTextureTotal).toBeGreaterThan(0);
    });

    for (const c of cases) {
        it(`${c.file} : ${c.igc.length} IGC texture(s) — wasm RGBA sha === manifest`, () => {
            const res = mod.parseTextured(c.bytes);
            for (const exp of c.igc) {
                const rec = res.textures.find(
                    (t) =>
                        t.texIdx === exp.texIdx &&
                        t.imgIdx === exp.imgIdx &&
                        t.mipIdx === exp.mipIdx,
                );
                expect(rec, `${c.file}: missing tex ${exp.texIdx}/${exp.imgIdx}/${exp.mipIdx}`).toBeTruthy();
                expect(sha256(rec.pixels), `${c.file} tex${exp.texIdx}/${exp.imgIdx}/${exp.mipIdx}`).toBe(
                    exp.rgbaSha256,
                );
            }
        });
    }
});
