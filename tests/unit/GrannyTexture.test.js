// Unit tests for the texture decoder. Byte-exact parity vs granny2.dll
// for every fixture lives in the content-addressed integration test at
// tests/integration/manifest.test.js — this file covers the standalone
// shape contract + the anti-hang guard + the yuvToRGB kernel.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import { walkTextureImages } from '../../src/GrannyTexture.js';
import { yuvToRGB, decodeIGCTexture } from '../../src/GrannyTextureIGC.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const SOURCE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');

const haveFixtures = existsSync(SOURCE_DIR) &&
    readdirSync(SOURCE_DIR).some((n) => n.endsWith('.gr2'));

const fixtureCache = {};
function loadedFor(fixtureName) {
    if (fixtureCache[fixtureName]) return fixtureCache[fixtureName];
    const buf = readFileSync(resolve(SOURCE_DIR, fixtureName));
    const file = parseGR2File(buf);
    const loaded = loadGR2(file);
    fixtureCache[fixtureName] = loaded;
    return loaded;
}

// --- walker shape ----------------------------------------------------

describe.skipIf(!haveFixtures)('walkTextureImages — shape', () => {
    it('emits 2 records for guildflag90_1 (2 textures × 1 image × 1 mip)', () => {
        const loaded = loadedFor('guildflag90_1.gr2');
        const records = walkTextureImages(loaded);
        expect(records.length).toBe(2);
        expect(records[0].pixelBytes).toBeInstanceOf(Uint8Array);
    });

    it('returns an array (no throw) on a fixture without textures', () => {
        const loaded = loadedFor('1_attack.gr2');
        const records = walkTextureImages(loaded);
        expect(Array.isArray(records)).toBe(true);
    });
});

// --- decodeHigh1 anti-hang guard — 1_attack off-corpus bitstream ----

describe('decodeIGCTexture — anti-hang guard on degenerate bitstream', () => {
    // The guard fires via a 64-idle-iter counter on litLen=0/zeroLen=0,
    // not a wall-clock deadline. 100 ms gives headroom for loaded CI
    // hosts while still catching real spins (which would be unbounded).
    it('throws within 100 ms on 1_attack tex0 (granny2.dll also hangs)', () => {
        const loaded = loadedFor('1_attack.gr2');
        const records = walkTextureImages(loaded);
        const r = records.find((x) => x.texIdx === 0 && x.imgIdx === 0 && x.mipIdx === 0);
        expect(r, 'missing 1_attack tex0').toBeTruthy();
        const t0 = Date.now();
        expect(() => decodeIGCTexture({
            Width: r.width, Height: r.height, Alpha: r.alpha, ImageData: r.pixelBytes,
        })).toThrow(/stuck.*litLen=0\/zeroLen=0/);
        const elapsed = Date.now() - t0;
        expect(elapsed).toBeLessThan(100);
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
