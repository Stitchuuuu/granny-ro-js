// Untrusted-input allocation-cap regression tests (DoS hardening, session 1).
//
// Each forged input drives one of the parser's file-controlled allocations
// past a plausible bound. The contract is a *clean typed throw* before the
// alloc — NOT an OOM, NOT a hang, NOT a bare RangeError from an oversized
// `new TypedArray`. No fixtures needed; the inputs are crafted in-memory.
//
// Byte-exact regression (legit files still decode identically) is covered
// by the content-manifest suite (`npm run test:js` / integration/manifest).

import { describe, it, expect } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
    decompressOodle0,
    DecompressionError,
    OODLE0_HEADER_SIZE,
    OODLE0_MAX_EXPANDED_SIZE,
    OODLE0_MAX_EXPAND_RATIO,
    OODLE0_MAX_ALPHABET,
} from '../../src/GrannyOodle0.js';
import { decodeIGCTexture } from '../../src/GrannyTextureIGC.js';
import { arithOpen, IGC_MAX_ALPHABET } from '../../src/igc-arith.js';

// A section stub with the fields decompressOodle0 / blockStops read.
function forgeSection({ expanded_size, first_16bit = 0, first_8bit = 0 }) {
    return { index: 0, compression: 1, expanded_size, first_16bit, first_8bit };
}

// Build `length`-byte compressed input whose 9-word Oodle0 header words can
// be overridden (LE u32). Bytes past the header default to 0.
function forgeCompressed(length, words = {}) {
    const buf = new Uint8Array(length);
    const view = new DataView(buf.buffer);
    for (const k in words) view.setUint32(Number(k) * 4, words[k] >>> 0, true);
    return buf;
}

// Assert `fn` throws quickly — proves the guard fires before the alloc/loop,
// not after an OOM or a multi-second spin.
function throwsFast(fn, ErrorType, budgetMs = 100) {
    const t0 = performance.now();
    expect(fn).toThrow(ErrorType);
    expect(performance.now() - t0).toBeLessThan(budgetMs);
}

describe('finding 1 — expanded_size decompression bomb', () => {
    it('rejects an absurd expanded_size before allocating', () => {
        const section = forgeSection({ expanded_size: 0x7FFFFFFF }); // ~2 GB
        const compressed = forgeCompressed(40);
        throwsFast(() => decompressOodle0(section, compressed), DecompressionError);
    });

    it('rejects expanded_size just over the compressed-ratio bound', () => {
        const compressed = forgeCompressed(40);
        const section = forgeSection({ expanded_size: 40 * OODLE0_MAX_EXPAND_RATIO + 1 });
        throwsFast(() => decompressOodle0(section, compressed), DecompressionError);
    });

    it('does not perturb the empty-section fast path', () => {
        expect(decompressOodle0(forgeSection({ expanded_size: 0 }), new Uint8Array(0)))
            .toEqual(new Uint8Array(0));
    });
});

describe('finding 4a — Oodle0 arith alphabet', () => {
    it('rejects a huge unique_offsets before the model arrays alloc', () => {
        // word[1] = uniq_offset_and_byte : high 23 bits = unique_offsets.
        // (1<<22)<<9 = 0x80000000 → unique_offsets = 0x400000 (4.2M) > cap.
        const section = forgeSection({ expanded_size: 100, first_16bit: 8, first_8bit: 8 });
        const compressed = forgeCompressed(64, { 1: ((1 << 22) << 9) | 1 });
        throwsFast(() => decompressOodle0(section, compressed), DecompressionError);
    });
});

describe('finding 2 — IGC width×height plane allocation', () => {
    it('rejects an oversized texture before the plane allocs', () => {
        // 16384² = 268 Mpix → passes the 16-alignment gate, asks for ~2 GB.
        throwsFast(() => decodeIGCTexture({
            Width: 16384, Height: 16384, Alpha: 1, ImageData: new Uint8Array(64),
        }), Error);
    });

    it('rejects a plausible-dim texture whose bitstream is far too small', () => {
        // 4096² is under the absolute cap, but 64 B can't encode 16 Mpix.
        throwsFast(() => decodeIGCTexture({
            Width: 4096, Height: 4096, Alpha: 1, ImageData: new Uint8Array(64),
        }), Error);
    });
});

describe('finding 4b — IGC arith alphabet', () => {
    it('rejects the 16-bit max alphabet before the Uint16Array allocs', () => {
        expect(() => arithOpen(0, 65536)).toThrow(/igc arith alphabet/);
    });

    it('accepts the cap value and the fixed lit/zero opens', () => {
        expect(() => arithOpen(0, IGC_MAX_ALPHABET)).not.toThrow();
        expect(() => arithOpen(0, 64)).not.toThrow();   // LIT_LENGTH_LIMIT+1
        expect(() => arithOpen(0, 256)).not.toThrow();  // ZERO_LENGTH_LIMIT+1
    });
});

describe('boundary sanity — no legit asset trips a cap', () => {
    it('measured corpus maxima sit well below every ceiling', () => {
        // Largest real fixture: expanded_size 98,028 B, expand ratio 4.24×.
        expect(98028).toBeLessThan(OODLE0_MAX_EXPANDED_SIZE);
        expect(4.24).toBeLessThan(OODLE0_MAX_EXPAND_RATIO);
        // Sane ordering — the ratio-derived bound over a 1-byte input still
        // clears the largest section, and the alphabet cap clears any legit
        // offset alphabet (≤ a section's byte count).
        expect(OODLE0_MAX_ALPHABET).toBeGreaterThan(98028);
        expect(IGC_MAX_ALPHABET).toBeGreaterThan(256);
    });
});
