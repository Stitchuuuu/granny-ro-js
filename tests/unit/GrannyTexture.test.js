// Byte-exact parity tests for the JS texture decoder vs the S2 parity-
// bake golden RGBA blobs.
//
// In `granny-ro-js@1.1.0-a.0` (the partial S3 ship — see
// `plans/granny-texture-igc/STATUS.md` S3.5) only the Raw encoding
// (encoding=1) is decoded byte-exact ; the IGC bitstream decoder
// (encoding=3) throws a clear "not yet implemented" error and its
// parametric parity entries are skipped.
//
// All-skipped when bake artefacts aren't present (mirrors the
// [GrannyMesh.test.js](./GrannyMesh.test.js) describe.skipIf pattern).

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import {
    extractTextures,
    walkTextureImages,
    ENCODING_RAW,
    ENCODING_IGC,
} from '../../src/GrannyTexture.js';
import {
    decodeIGCTexture,
    yuvToRGB,
} from '../../src/GrannyTextureIGC.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const SOURCE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const BAKED_DIR = resolve(PKG_ROOT, 'tests/fixtures/baked/textures');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const TEXTURES_JSON_PATH = resolve(BAKED_DIR, 'textures.json');

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

const fixtureCache = {};
function loadedFor(fixtureName) {
    if (fixtureCache[fixtureName]) return fixtureCache[fixtureName];
    const buf = readFileSync(resolve(SOURCE_DIR, fixtureName));
    const file = parseGR2File(buf);
    const loaded = loadGR2(file);
    fixtureCache[fixtureName] = loaded;
    return loaded;
}

function rawEntries() {
    return (textures ?? []).filter((e) => e.encoding === ENCODING_RAW);
}
function igcEntries() {
    return (textures ?? []).filter((e) => e.encoding === ENCODING_IGC);
}

function locate(records, texIdx, imgIdx, mipIdx) {
    for (let i = 0; i < records.length; i++) {
        const r = records[i];
        if (r.texIdx === texIdx && r.imgIdx === imgIdx && r.mipIdx === mipIdx) return r;
    }
    return null;
}

// --- walker shape ----------------------------------------------------

describe.skipIf(!haveBake)('walkTextureImages — shape', () => {
    it('emits one record per baked manifest entry for guildflag90_1', () => {
        const loaded = loadedFor('guildflag90_1.gr2');
        const records = walkTextureImages(loaded);
        // guildflag90_1 has 2 textures, 1 image each, 1 mip each.
        expect(records.length).toBe(2);
        expect(records[0].pixelBytes).toBeInstanceOf(Uint8Array);
    });

    it('returns [] for animation-only fixtures without crashing', () => {
        // pick the first animation file in the source dir, if any
        // (animation files are filtered out of bake but still parse fine)
        const candidates = ['empelium90_0.gr2', 'treasurebox_2.gr2'];
        // any model fixture also works ; the contract is « no throw » + array
        const loaded = loadedFor(candidates[0]);
        const records = walkTextureImages(loaded);
        expect(Array.isArray(records)).toBe(true);
    });
});

// --- Raw (encoding=1) byte-exact parity vs S2 golden ----------------

describe.skipIf(!haveBake)('extractTextures — Raw encoding byte-exact parity', () => {
    const raws = rawEntries();
    if (raws.length === 0) {
        it.skip('no Raw fixtures in manifest', () => {});
        return;
    }
    for (const entry of raws) {
        const stem = `${entry.fixture}/tex${entry.tex_idx}-img${entry.img_idx}-mip${entry.mip_idx}`;
        it(`${stem} : sha256(pixels) === baked golden`, () => {
            const loaded = loadedFor(entry.fixture);
            const records = extractTextures(loaded);
            const decoded = locate(records, entry.tex_idx, entry.img_idx, entry.mip_idx);
            expect(decoded, `missing decoded record for ${stem}`).toBeTruthy();
            expect(decoded.encoding).toBe(ENCODING_RAW);
            expect(decoded.pixels.length).toBe(entry.width * entry.height * 4);
            const actualSha = createHash('sha256').update(decoded.pixels).digest('hex');
            expect(actualSha).toBe(entry.rgba_sha256);
        });
    }
});

// --- IGC (encoding=3) deferred — throws a descriptive error ---------

describe.skipIf(!haveBake)('extractTextures — IGC encoding (deferred to S3.5)', () => {
    const igcs = igcEntries();
    if (igcs.length === 0) {
        it.skip('no IGC fixtures in manifest', () => {});
        return;
    }
    // Smoke-check only one IGC fixture : the throw points everyone at the
    // right plan path. Parametric byte-exact parity for IGC lands in a.1.
    const sample = igcs[0];
    it(`${sample.fixture}/tex${sample.tex_idx} throws a clear "not yet implemented" error`, () => {
        const loaded = loadedFor(sample.fixture);
        expect(() => extractTextures(loaded)).toThrow(/IGC.*not yet implemented|S3\.5/i);
    });

    it('decodeIGCTexture(): direct call also throws with the same guidance', () => {
        expect(() => decodeIGCTexture({
            Width: 16, Height: 16, Alpha: 1, ImageData: new Uint8Array(8),
        })).toThrow(/IGC.*not yet implemented|S3\.5/i);
    });
});

// --- yuvToRGB kernel — synthetic-plane validation -------------------

describe('yuvToRGB — synthetic-plane sanity', () => {
    it('all-zero planes produce all-zero RGBA (per the colorspace identity)', () => {
        const W = 4, H = 4;
        const zero = new Int16Array(W * H);
        const out = yuvToRGB(zero, zero, zero, zero, W, H);
        expect(out.length).toBe(W * H * 4);
        for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
    });

    it('clamping : oversaturated planes stay within 0..255', () => {
        const W = 2, H = 2;
        // r=U=400, g=Y=400, b=V=400, a=A=400 → after de-coupling :
        //   g' = 400 - (400+400)/4 = 200 ; r' = 200+400 = 600 → clamp 255
        //   b' = 200+400 = 600 → clamp 255 ; g' = 200 (in range) ; a = 255
        const four = new Int16Array(W * H).fill(400);
        const out = yuvToRGB(four, four, four, four, W, H);
        for (let i = 0; i < W * H; i++) {
            expect(out[i * 4]).toBe(255);     // R
            expect(out[i * 4 + 1]).toBe(200); // G
            expect(out[i * 4 + 2]).toBe(255); // B
            expect(out[i * 4 + 3]).toBe(255); // A clamped from 400
        }
    });

    it('clamping : negative planes clamp to 0', () => {
        const W = 2, H = 2;
        const neg = new Int16Array(W * H).fill(-200);
        const out = yuvToRGB(neg, neg, neg, neg, W, H);
        for (let i = 0; i < out.length; i++) expect(out[i]).toBe(0);
    });

    it('alpha is independent of the YUV→RGB de-coupling', () => {
        const W = 1, H = 1;
        const out = yuvToRGB(
            new Int16Array([100]),  // Y / g
            new Int16Array([50]),   // U / r
            new Int16Array([30]),   // V / b
            new Int16Array([200]),  // A
            W, H,
        );
        // g' = 100 - (50+30)/4 = 80 ; r' = 80+50 = 130 ; b' = 80+30 = 110 ; a = 200
        expect(Array.from(out)).toEqual([130, 80, 110, 200]);
    });
});
