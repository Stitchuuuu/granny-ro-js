// Unit tests for the low-level Oodle0 helpers. No fixtures needed.

import { describe, it, expect } from 'vitest';
import {
    bitReverse,
    parseOodle0Plan,
    Oodle0LZHeader,
    OODLE0_HEADER_SIZE,
    LONG_LENGTHS,
    MAX_LENS,
    __test__,
} from '../../src/GrannyOodle0.js';

const { VarBits, ArithBits, u32lePadded, blockStops, clampStop, alignedCount, bestShift } = __test__;

describe('bitReverse', () => {
    it('reverses 4-bit nibbles like the Python reference', () => {
        // _bit_reverse(0b0001, 4) → 0b1000
        expect(bitReverse(0b0001, 4)).toBe(0b1000);
        expect(bitReverse(0b1010, 4)).toBe(0b0101);
        expect(bitReverse(0xF, 4)).toBe(0xF);
        expect(bitReverse(0x0, 4)).toBe(0x0);
    });
    it('reverses 8-bit bytes', () => {
        expect(bitReverse(0b10000001, 8)).toBe(0b10000001);
        expect(bitReverse(0b11110000, 8)).toBe(0b00001111);
        expect(bitReverse(0b10101010, 8)).toBe(0b01010101);
    });
    it('reverses 31-bit words (matches ArithBits init usage)', () => {
        expect(bitReverse(0x00000001, 31)).toBe(0x40000000);
        expect(bitReverse(0x7FFFFFFF, 31)).toBe(0x7FFFFFFF);
        expect(bitReverse(0, 31)).toBe(0);
    });
    it('reverses 0 bits to 0', () => {
        expect(bitReverse(0xFF, 0)).toBe(0);
    });
});

describe('u32lePadded', () => {
    it('reads a full 4-byte LE word', () => {
        const buf = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
        expect(u32lePadded(buf, 0)).toBe(0x12345678);
    });
    it('zero-pads when the read crosses EOF', () => {
        const buf = new Uint8Array([0xAB, 0xCD]);
        expect(u32lePadded(buf, 0)).toBe(0x0000CDAB);
    });
    it('returns 0 when offset is fully past EOF', () => {
        const buf = new Uint8Array([0x12, 0x34]);
        expect(u32lePadded(buf, 100)).toBe(0);
    });
    it('preserves the high bit (unsigned semantics)', () => {
        const buf = new Uint8Array([0x00, 0x00, 0x00, 0x80]);
        expect(u32lePadded(buf, 0)).toBe(0x80000000);
    });
});

describe('clampStop + blockStops', () => {
    it('clamps individual stop values to [0, expanded_size]', () => {
        expect(clampStop(-10, 1000)).toBe(0);
        expect(clampStop(0, 1000)).toBe(0);
        expect(clampStop(500, 1000)).toBe(500);
        expect(clampStop(1500, 1000)).toBe(1000);
    });
    it('produces 4 stops covering [0, expanded_size]', () => {
        const section = { expanded_size: 1000, first_16bit: 200, first_8bit: 500 };
        expect(blockStops(section)).toEqual([0, 200, 500, 1000]);
    });
    it('forces first_8bit >= first_16bit if the header lies', () => {
        const section = { expanded_size: 1000, first_16bit: 700, first_8bit: 300 };
        expect(blockStops(section)).toEqual([0, 700, 700, 1000]);
    });
    it('handles a fully-empty section', () => {
        const section = { expanded_size: 0, first_16bit: 0, first_8bit: 0 };
        expect(blockStops(section)).toEqual([0, 0, 0, 0]);
    });
});

describe('Oodle0LZHeader accessors', () => {
    // Pick values that exercise the bit-splits clearly.
    // max_offset_and_byte = (0x1234 << 9) | 0x0AB  → max_offset 0x1234, max_byte_value 0xAB
    const maxOffsetAndByte = (0x1234 << 9) | 0xAB;
    const uniqOffsetAndByte = (0x0567 << 9) | 0x1FE;
    const uniqLens = 0x10203040;
    const h = new Oodle0LZHeader(maxOffsetAndByte, uniqOffsetAndByte, uniqLens);

    it('splits max_offset_and_byte into 9-bit byte + 23-bit offset', () => {
        expect(h.max_byte_value).toBe(0xAB);
        expect(h.max_offset).toBe(0x1234);
    });
    it('splits uniq_offset_and_byte the same way', () => {
        expect(h.unique_byte_values).toBe(0x1FE);
        expect(h.unique_offsets).toBe(0x0567);
    });
    it('selects 8-bit length-unique by group of MAX_LENS/4 (=16) entries', () => {
        // uniq_lens = 0x10203040 — bytes (LSB first) are 0x40, 0x30, 0x20, 0x10.
        // length_unique(index) returns the 8 bits at (3 - min(index/16, 3))*8.
        expect(h.length_unique(0)).toBe(0x10);   // group 0 → (3-0)*8 = 24 → byte 0x10
        expect(h.length_unique(15)).toBe(0x10);  // still group 0
        expect(h.length_unique(16)).toBe(0x20);  // group 1 → (3-1)*8 = 16 → byte 0x20
        expect(h.length_unique(32)).toBe(0x30);  // group 2 → 8 → byte 0x30
        expect(h.length_unique(48)).toBe(0x40);  // group 3 → 0 → byte 0x40
        expect(h.length_unique(MAX_LENS)).toBe(0x40);  // clamped to 3
    });
});

describe('alignedCount + bestShift', () => {
    it('aligns to multiples of 4 with a +5 offset rounded down', () => {
        // (n + 5) & ~3 — floors (n+5) to a multiple of 4.
        expect(alignedCount(0)).toBe(4);    // 5 → 4
        expect(alignedCount(1)).toBe(4);    // 6 → 4
        expect(alignedCount(2)).toBe(4);    // 7 → 4
        expect(alignedCount(3)).toBe(8);    // 8 → 8
        expect(alignedCount(255)).toBe(260);
        expect(alignedCount(511)).toBe(516);
    });
    it('returns the (0, 15, 0) trivial bin layout for tiny scales', () => {
        expect(bestShift(0)).toEqual([0, 15, 0]);
        expect(bestShift(5)).toEqual([0, 15, 0]);
    });
    it('returns a sane (size, shift, last_bin_start) for medium scales', () => {
        const [size, shift, lastStart] = bestShift(256);
        expect(size).toBeGreaterThan(0);
        expect(shift).toBeGreaterThanOrEqual(0);
        expect(shift).toBeLessThanOrEqual(15);
        expect(lastStart).toBe(15 * size);
    });
});

describe('parseOodle0Plan', () => {
    it('parses three Oodle0LZHeader records from the first 36 bytes', () => {
        const buf = new Uint8Array(64);
        const view = new DataView(buf.buffer);
        // 9 u32s — alternating distinctive patterns
        for (let i = 0; i < 9; i++) view.setUint32(i * 4, 0x10000000 + i, true);
        const section = { index: 0, expanded_size: 100, first_16bit: 30, first_8bit: 70 };
        const plan = parseOodle0Plan(section, buf);
        expect(plan.bitstream_offset).toBe(OODLE0_HEADER_SIZE);
        expect(plan.section_index).toBe(0);
        expect(plan.expanded_size).toBe(100);
        expect(plan.blocks).toHaveLength(3);
        expect(plan.blocks[0].output_start).toBe(0);
        expect(plan.blocks[0].output_end).toBe(30);
        expect(plan.blocks[1].output_start).toBe(30);
        expect(plan.blocks[1].output_end).toBe(70);
        expect(plan.blocks[2].output_start).toBe(70);
        expect(plan.blocks[2].output_end).toBe(100);
        expect(plan.blocks[0].header.max_offset_and_byte).toBe(0x10000000);
        expect(plan.blocks[1].header.max_offset_and_byte).toBe(0x10000003);
        expect(plan.blocks[2].header.max_offset_and_byte).toBe(0x10000006);
    });
    it('flags empty blocks via is_empty', () => {
        const buf = new Uint8Array(64);
        const section = { index: 0, expanded_size: 0, first_16bit: 0, first_8bit: 0 };
        const plan = parseOodle0Plan(section, buf);
        for (const block of plan.blocks) expect(block.is_empty).toBe(true);
    });
    it('throws on undersized buffer', () => {
        const buf = new Uint8Array(10);
        const section = { index: 7, expanded_size: 100, first_16bit: 30, first_8bit: 70 };
        expect(() => parseOodle0Plan(section, buf)).toThrow(/too short for header/);
    });
});

describe('VarBits — bit-level reader', () => {
    it('reads consecutive 4-bit fields from a known LE buffer', () => {
        // Word 0 = 0x12345678 (LE bytes 78 56 34 12). Nibbles read low-to-high:
        // 8, 7, 6, 5, 4, 3, 2, 1.
        const buf = new Uint8Array([0x78, 0x56, 0x34, 0x12]);
        const bits = new VarBits(buf, 0);
        expect(bits.get(4)).toBe(0x8);
        expect(bits.get(4)).toBe(0x7);
        expect(bits.get(4)).toBe(0x6);
        expect(bits.get(4)).toBe(0x5);
        expect(bits.get(4)).toBe(0x4);
        expect(bits.get(4)).toBe(0x3);
        expect(bits.get(4)).toBe(0x2);
        expect(bits.get(4)).toBe(0x1);
    });
    it('streams across word boundaries with get(n) when bitlen < n', () => {
        // Word 0 = 0xFFFFFFFF, Word 1 = 0x00000000. Reading 20 bits at offset
        // 28 (= read 28 bits first) should pull 4 bits from word 0 + 16 bits
        // from word 1.
        const buf = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00]);
        const bits = new VarBits(buf, 0);
        expect(bits.get(28)).toBe(0x0FFFFFFF);
        // Now bitlen = 4, bits = 0xF. Request 20 more bits.
        // Result: low 4 bits of word 0 (= 0xF) | (low 16 bits of word 1 = 0) << 4 = 0x0000F.
        expect(bits.get(20)).toBe(0x0000F);
    });
    it('zero-pads past EOF', () => {
        const buf = new Uint8Array([0xAB]);
        const bits = new VarBits(buf, 0);
        expect(bits.get(8)).toBe(0xAB);
        expect(bits.get(8)).toBe(0);  // zero-pad
    });
    it('get(0) returns 0 without consuming', () => {
        const buf = new Uint8Array([0xFF]);
        const bits = new VarBits(buf, 0);
        expect(bits.get(0)).toBe(0);
        expect(bits.get(8)).toBe(0xFF);
    });
});

describe('ArithBits — arithmetic decoder init', () => {
    it('initializes high/low/code to the right ranges', () => {
        // Pre-load the bitstream with a known pattern.
        const buf = new Uint8Array(8);
        const view = new DataView(buf.buffer);
        view.setUint32(0, 0x55555555, true);
        view.setUint32(4, 0xAAAAAAAA, true);
        const bits = new ArithBits(buf, 0);
        // high init = 0x7FFFFFFF, low init = 0, code = bitReverse(get(31), 31).
        expect(bits.high).toBe(0x7FFFFFFF);
        expect(bits.low).toBe(0);
        // Sanity : code lives in 31 bits.
        expect(bits.code).toBeGreaterThanOrEqual(0);
        expect(bits.code).toBeLessThanOrEqual(0x7FFFFFFF);
    });
});
