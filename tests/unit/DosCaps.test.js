// Untrusted-input allocation-cap regression tests (DoS hardening, session 1).
//
// Each forged input drives one of the parser's file-controlled allocations
// past a plausible bound. The contract is a *clean typed throw* before the
// alloc — NOT an OOM, NOT a hang, NOT a bare RangeError from an oversized
// `new TypedArray`. No fixtures needed; the inputs are crafted in-memory.
//
// Byte-exact regression (legit files still decode identically) is covered
// by the content-manifest suite (`npm run test:js` / integration/manifest).

import { describe, it, expect, beforeAll } from 'vitest';
import { performance } from 'node:perf_hooks';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPipelineDriver } from '../../src/wasm/pipeline-driver.js';
import { decodeIGCPipeline } from '../../src/igc-pipeline.js';
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
import {
    parseTypeTree,
    parseObject,
    objectStorageSize,
    makeFakePointer,
    GrannyParseError,
    MAX_INLINE_DEPTH,
    MT_INLINE,
    MT_UINT32,
    MT_END,
} from '../../src/GrannyTypeTree.js';

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

// --- finding 4b on the WASM decode path (session 3) -------------------
//
// The pure-JS `arithOpen` cap (above) is BYPASSED on the opt-in `./wasm`
// build : the fused kernel re-reads the alphabet field (`max`, a 16-bit
// varbits value) INSIDE wasm and allocates its model buffer there, so the JS
// guard never runs. The AS-side echo (kernels.ts `pdArithOpen`) must trip on
// the same input and surface a clean typed throw — not a wasm trap / OOM.
//
// The wasm driver and the JS pipeline oracle share byte-exact framing, so one
// forged plane-0 buffer drives both : asserting the oracle throws calibrates
// the craft, then asserting the wasm driver throws proves parity.

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNELS_WASM = resolve(__dirname, '../../src/wasm/kernels.wasm');

// Minimal IGC bitstream whose plane-0 low-pass sub-band declares an arith
// alphabet `max` far over IGC_MAX_ALPHABET. Framing (igc-pipeline.js) : the
// pipeline starts plane 0 at offset 4 ; a plane is
// [arithLen u32][varbitsLen u32][arith bytes…][varbits bytes…]. decodeLow reads
// varBitsGet1 (bit0 = 0 → alphabet path) then varBitsGet(16) = max. varBitsGet
// is LSB-first, so the varbits word = (max << 1) | bit0 → max=9000 ⇒ 0x4650.
function forgeOversizedAlphabetPlane(max = 9000) {
    const buf = new Uint8Array(64); // ~20 B used ; trailing zeros cover read-ahead
    const view = new DataView(buf.buffer);
    view.setUint32(4, 4, true);                 // plane 0 arithLen = 4 (minimal stream)
    view.setUint32(8, 0, true);                 // plane 0 varbitsLen (unread — we bail first)
    // arith bytes 12..15 stay 0 (coder inits ; unused before the cap trips).
    view.setUint32(16, (max << 1) >>> 0, true); // varbits : bit0 = 0, next 16 bits = max
    return buf;
}

describe('finding 4b (wasm) — IGC arith alphabet on the fused path', () => {
    const src = forgeOversizedAlphabetPlane(9000); // num = 9001 > IGC_MAX_ALPHABET (8192)

    it('JS pipeline oracle throws on the forged alphabet (calibrates the craft)', () => {
        expect(() => decodeIGCPipeline(src, 16, 16, false)).toThrow(/igc arith alphabet/);
    });

    if (!existsSync(KERNELS_WASM)) {
        it.skip('skipped : src/wasm/kernels.wasm absent (run `npm run build:wasm`)', () => {});
        return;
    }

    /** @type {ReturnType<typeof createPipelineDriver>} */
    let driver;
    beforeAll(async () => {
        const { instance } = await WebAssembly.instantiate(readFileSync(KERNELS_WASM), {});
        driver = createPipelineDriver(instance);
    });

    it('fused WASM entry throws a clean typed error, not a wasm trap or OOM', () => {
        throwsFast(() => driver.decode(src, 16, 16, 0), /igc arith alphabet/);
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

// --- type-tree recursion guards (findings 3a/3b) ----------------------
//
// Forge a minimal `LoadedGR2` with one section whose bytes lay out 32-byte
// type-member records, then drive the type-tree walk with crafted schemas:
// a DAG of inline members (3a — must stay bounded, not exponential) and a
// self-referential / over-deep inline chain (3b — must throw a clean typed
// error, not overflow the JS stack).

const RECORD = 32; // one member record (8 u32 slots)

// Write one member record at byte `off`. Non-inline members leave typePtr 0.
function putRecord(view, off, mt, typePtr = 0) {
    view.setUint32(off, mt, true);       // member_type
    view.setUint32(off + 4, 0, true);    // name_ptr (0 → name falls back to member_N)
    view.setUint32(off + 8, typePtr, true); // type_ptr
    // arrayWidth (off+12) + extra[3] + _unused stay 0.
}

// Wrap a filled section buffer as the minimal LoadedGR2 the walker reads.
function forgeLoaded(buf) {
    return /** @type {any} */ ({
        file: { header: { byte_reversed: false } },
        sectionsFixed: [buf],
        sectionsOriginal: [buf],
        pointerSize: 4,
    });
}

describe('finding 3a — objectStorageSize exponential re-walk', () => {
    it('sizes a DAG of shared inline sub-types in bounded time', () => {
        // D branching levels: level k has TWO inline members both pointing at
        // level k+1's (single, shared) type. Naive walk = 2^(D+1)-1 calls;
        // memoized = O(D). Each level occupies 3 records (2 inline + END).
        const D = 25;
        const BLOCK = 3 * RECORD;
        const buf = new Uint8Array((D + 2) * BLOCK);
        const view = new DataView(buf.buffer);
        for (let k = 0; k < D; k++) {
            const base = k * BLOCK;
            const childPtr = makeFakePointer(0, (k + 1) * BLOCK);
            putRecord(view, base, MT_INLINE, childPtr);
            putRecord(view, base + RECORD, MT_INLINE, childPtr);
            putRecord(view, base + 2 * RECORD, MT_END);
        }
        // Leaf (level D): one uint32 (size 4) + END.
        const leaf = D * BLOCK;
        putRecord(view, leaf, MT_UINT32);
        putRecord(view, leaf + RECORD, MT_END);

        const loaded = forgeLoaded(buf);
        const members = parseTypeTree(loaded, [0, 0]);
        const t0 = performance.now();
        const size = objectStorageSize(loaded, members, 4, new Set());
        const elapsed = performance.now() - t0;
        // Value is still the true DAG storage size (2^D leaf scalars × 4 B) —
        // only the computation is collapsed. Without the memo this loop would
        // run ~67M times and take seconds.
        expect(size).toBe(4 * 2 ** D);
        expect(elapsed).toBeLessThan(100);
    });

    it('preserves sibling stride — 3 same-type inline siblings sum, not collapse', () => {
        // parent: three inline members → the same child type (one uint32).
        // The memo must ADD the cached size per sibling (→ 12), never skip
        // like the cycle guard (→ 4). Guards the comment at GrannyTypeTree.
        const BLOCK = 4 * RECORD; // 3 inline + END
        const buf = new Uint8Array(BLOCK + 2 * RECORD);
        const view = new DataView(buf.buffer);
        const childPtr = makeFakePointer(0, BLOCK);
        putRecord(view, 0, MT_INLINE, childPtr);
        putRecord(view, RECORD, MT_INLINE, childPtr);
        putRecord(view, 2 * RECORD, MT_INLINE, childPtr);
        putRecord(view, 3 * RECORD, MT_END);
        putRecord(view, BLOCK, MT_UINT32);            // child: one uint32
        putRecord(view, BLOCK + RECORD, MT_END);

        const loaded = forgeLoaded(buf);
        const members = parseTypeTree(loaded, [0, 0]);
        expect(objectStorageSize(loaded, members, 4, new Set())).toBe(12);
    });
});

describe('finding 3b — parseObject unguarded INLINE recursion', () => {
    it('throws a clean typed error on a self-referential inline type', () => {
        // type A: [inline → A (self), END]. INLINE size 0 → offset never
        // advances → infinite recursion without the cycle guard.
        const buf = new Uint8Array(2 * RECORD);
        const view = new DataView(buf.buffer);
        putRecord(view, 0, MT_INLINE, makeFakePointer(0, 0)); // → self
        putRecord(view, RECORD, MT_END);

        const loaded = forgeLoaded(buf);
        const treeA = parseTypeTree(loaded, [0, 0]);
        throwsFast(() => parseObject(loaded, treeA, [0, 0]), GrannyParseError);
    });

    it('throws on an acyclic inline chain deeper than MAX_INLINE_DEPTH', () => {
        // N distinct types chained by inline (k → k+1). Distinct keys never
        // trip the cycle guard, so the depth cap is what must fire.
        const N = MAX_INLINE_DEPTH + 6;
        const BLOCK = 2 * RECORD; // 1 inline + END
        const buf = new Uint8Array((N + 1) * BLOCK);
        const view = new DataView(buf.buffer);
        for (let k = 0; k < N; k++) {
            putRecord(view, k * BLOCK, MT_INLINE, makeFakePointer(0, (k + 1) * BLOCK));
            putRecord(view, k * BLOCK + RECORD, MT_END);
        }
        putRecord(view, N * BLOCK, MT_UINT32);            // leaf
        putRecord(view, N * BLOCK + RECORD, MT_END);

        const loaded = forgeLoaded(buf);
        const tree0 = parseTypeTree(loaded, [0, 0]);
        throwsFast(() => parseObject(loaded, tree0, [0, 0]), GrannyParseError);
    });

    it('parses a legit depth-1 inline object without throwing', () => {
        // The corpus max is depth 1 — it must still materialize the sub-object.
        const BLOCK = 2 * RECORD;
        const buf = new Uint8Array(2 * BLOCK);
        const view = new DataView(buf.buffer);
        putRecord(view, 0, MT_INLINE, makeFakePointer(0, BLOCK));
        putRecord(view, RECORD, MT_END);
        putRecord(view, BLOCK, MT_UINT32);
        putRecord(view, BLOCK + RECORD, MT_END);

        const loaded = forgeLoaded(buf);
        const tree = parseTypeTree(loaded, [0, 0]);
        const out = parseObject(loaded, tree, [0, 0]);
        expect(out.member_0.type).toBe('inline');
        expect(out.member_0.inline.member_0.type).toBe('uint32');
    });

    it('MAX_INLINE_DEPTH is generous vs the measured corpus max (1)', () => {
        expect(MAX_INLINE_DEPTH).toBeGreaterThan(1);
    });
});
