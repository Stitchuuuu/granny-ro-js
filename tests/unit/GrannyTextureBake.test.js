// Integration test for the granny-texture-igc S2 deliverable :
// the baked RGBA8888 golden data produced by `scripts/bake-textures.mjs`
// via the Wine shim at `shim/gr2_igc_export.c`.
//
// The bake artefacts live at `tests/fixtures/baked/textures/<fixture>/
// tex<I>-img<J>-mip<K>.rgba` with a manifest at either
// `tests/fixtures/manifest.json` (when bake-all.mjs chains the texture
// bake) or `tests/fixtures/baked/textures/textures.json` (when
// bake-textures.mjs runs standalone before bake-all).
//
// All-skipped when bake artefacts aren't present — keeps the bake-free
// CI path green (mirrors the [GrannyMesh.test.js](./GrannyMesh.test.js)
// describe.skipIf pattern).
//
// What this validates :
//   - manifest shape (textures array exists, each entry has the
//     required keys)
//   - on-disk RGBA byte count matches W*H*4 per entry
//   - SHA-256 of the baked RGBA file matches the manifest's claim
//     (catches silent corruption between bake + commit)
//   - encoding ∈ {1, 3} (Raw / IGC — S3TC=2 is not present in iRO corpus)
//   - the 16×16 emblem (guildflag90_1 tex1) is present
//
// What this does NOT validate (deferred to S3 = js-port) :
//   - byte-exact JS port output vs the baked golden data
//   - per-kernel diffs (yuvToRGB / iDWT2D / planeDecode output)

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const TEXTURES_JSON_PATH = resolve(PKG_ROOT, 'tests/fixtures/baked/textures/textures.json');
const BAKED_DIR = resolve(PKG_ROOT, 'tests/fixtures/baked/textures');

function loadTextureManifest() {
    if (existsSync(MANIFEST_PATH)) {
        const m = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
        if (Array.isArray(m.textures)) return m.textures;
    }
    if (existsSync(TEXTURES_JSON_PATH)) {
        const m = JSON.parse(readFileSync(TEXTURES_JSON_PATH, 'utf8'));
        if (Array.isArray(m.textures)) return m.textures;
    }
    return null;
}

const textures = loadTextureManifest();
const haveBake = textures !== null && textures.length > 0;

describe.skipIf(!haveBake)('bake-textures.mjs — manifest shape', () => {
    it('has at least 17 entries (iRO corpus baseline)', () => {
        expect(textures.length).toBeGreaterThanOrEqual(17);
    });

    it('every entry carries the required keys', () => {
        const required = [
            'fixture', 'name', 'tex_idx', 'img_idx', 'mip_idx',
            'width', 'height', 'encoding', 'alpha',
            'rgba_path', 'rgba_sha256',
        ];
        for (const entry of textures) {
            for (const key of required) {
                expect(entry, `entry ${JSON.stringify(entry)} missing ${key}`).toHaveProperty(key);
            }
        }
    });

    it('every encoding is in {1 Raw, 3 IGC}', () => {
        // S3TC = 2 is not in the iRO corpus per IGC-FORMAT.md § 1 ;
        // bake-textures.mjs skips it explicitly. If a new fixture
        // introduces encoding=2, the bake driver warns + skips ; this
        // test stays green but the missing entry shows up in the count.
        for (const entry of textures) {
            expect([1, 3]).toContain(entry.encoding);
        }
    });
});

describe.skipIf(!haveBake)('bake-textures.mjs — RGBA artefact integrity', () => {
    for (const entry of textures ?? []) {
        const stem = `${entry.fixture}/tex${entry.tex_idx}-img${entry.img_idx}-mip${entry.mip_idx}`;
        it(`${stem} : file exists with W*H*4 bytes + sha256 matches`, () => {
            const path = resolve(BAKED_DIR, entry.rgba_path);
            expect(existsSync(path), `missing baked file : ${path}`).toBe(true);
            const buf = readFileSync(path);
            const expectedBytes = entry.width * entry.height * 4;
            expect(buf.length).toBe(expectedBytes);
            const actualSha = createHash('sha256').update(buf).digest('hex');
            expect(actualSha).toBe(entry.rgba_sha256);
        });
    }
});

describe.skipIf(!haveBake)('bake-textures.mjs — known fixtures', () => {
    it('the 16×16 emblem (guildflag90_1 tex1) is present', () => {
        const emblem = textures.find((e) =>
            e.fixture === 'guildflag90_1.gr2' && e.tex_idx === 1);
        expect(emblem, 'missing the 16×16 emblem fixture').toBeTruthy();
        expect(emblem.width).toBe(16);
        expect(emblem.height).toBe(16);
    });

    it('treasurebox_2 has at least one 256×256 IGC texture', () => {
        const tb = textures.find((e) =>
            e.fixture === 'treasurebox_2.gr2' && e.tex_idx === 0);
        expect(tb).toBeTruthy();
        expect(tb.width).toBe(256);
        expect(tb.height).toBe(256);
        expect(tb.encoding).toBe(3);
    });
});
