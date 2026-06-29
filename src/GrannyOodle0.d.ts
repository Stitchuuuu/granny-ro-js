// Sibling .d.ts paired with GrannyOodle0.js.
// VS Code / tsc apply these types automatically — no per-file JSDoc imports.

import type { GR2Section } from './GrannyFile.js';

/**
 * Structural subset of {@link GR2Section} actually consumed by the Oodle0
 * codec. {@link GR2Section} is assignable wherever this is expected — but
 * a hand-built object with just these 4 fields works too (useful for unit
 * tests that don't want to mock the full section table).
 */
export interface Oodle0SectionInput {
    readonly index: number;
    readonly expanded_size: number;
    /** Decoded-byte offset where the 16-bit length context block ends. */
    readonly first_16bit: number;
    /** Decoded-byte offset where the 8-bit length context block ends. */
    readonly first_8bit: number;
}

/**
 * Per-block LZ header — 12 bytes, 3 u32s. Three of these are packed at
 * the start of every Oodle0-compressed section. See
 * `docs/gr2-format.md` § Oodle0 bitstream.
 */
export class Oodle0LZHeader {
    constructor(maxOffsetAndByte: number, uniqOffsetAndByte: number, uniqLens: number);
    /** Raw u32 ; low 9 bits = max literal value, high 23 = max back-distance. */
    readonly max_offset_and_byte: number;
    /** Raw u32 ; low 9 bits = literal alphabet size, high 23 = offset alphabet size. */
    readonly uniq_offset_and_byte: number;
    /** Raw u32 ; 4 × u8 unique-symbol count, one per length-context group. */
    readonly uniq_lens: number;
    /** Maximum literal value the block emits — low 9 bits of `max_offset_and_byte`. */
    readonly max_byte_value: number;
    /** Maximum LZ77 back-distance the block uses — high 23 bits of `max_offset_and_byte`. */
    readonly max_offset: number;
    /** Count of distinct literals tracked in this block's arith model. */
    readonly unique_byte_values: number;
    /** Count of distinct offsets tracked in this block's arith model. */
    readonly unique_offsets: number;
    /**
     * Per-length-context unique-symbol count. The 65 length symbols
     * (0..MAX_LENS) split into 4 contexts of 16 entries each, each
     * carrying its own arith model dimensioned by this value.
     */
    length_unique(index: number): number;
}

/** Decode plan for one Oodle0 section — 3 blocks back-to-back. */
export interface Oodle0Plan {
    readonly section_index: number;
    readonly expanded_size: number;
    /** Constant 36 ; bitstream begins right after the 3 × 12-byte block headers. */
    readonly bitstream_offset: 36;
    readonly blocks: readonly [Oodle0Block, Oodle0Block, Oodle0Block];
}

/** One of the three blocks an Oodle0 section is split into. */
export interface Oodle0Block {
    readonly index: 0 | 1 | 2;
    /** Decoded-byte offset where this block starts emitting. */
    readonly output_start: number;
    /** Decoded-byte offset where this block stops. */
    readonly output_end: number;
    /** `max(0, output_end - output_start)`. */
    readonly output_size: number;
    readonly is_empty: boolean;
    readonly header: Oodle0LZHeader;
}

/** Raised by the Oodle0 decoder on malformed or out-of-spec input. */
export class DecompressionError extends Error {
    constructor(message: string);
}

/**
 * Decompress one Oodle0-tagged section.
 *
 * @param compressed raw section bytes (the 36-byte LZ header + bitstream)
 * @returns `Uint8Array` of length `section.expanded_size`
 * @throws DecompressionError on malformed input
 */
export function decompressOodle0(section: Oodle0SectionInput, compressed: Uint8Array): Uint8Array;

/** Parse the 36-byte Oodle0 LZ header into a 3-block decode plan. Exposed for unit tests. */
export function parseOodle0Plan(section: Oodle0SectionInput, compressed: Uint8Array): Oodle0Plan;

/** Reverse the low `nbits` of `value`. Used in the arith-decoder byte/nibble swaps. */
export function bitReverse(value: number, nbits: number): number;

export const OODLE0_HEADER_SIZE:   36;
export const OODLE0_BLOCK_COUNT:   3;
export const OFFSET_SPLIT_SHIFT:   2;
export const LOW_OFFSET_MASK:      3;
export const MAX_LENS:             64;
export const LONG_LENGTHS: readonly [128, 192, 256, 512];

/**
 * Internals exposed only for unit testing. Not stable. Don't import
 * from outside `tests/`.
 */
export const __test__: {
    readonly VarBits: new (data: Uint8Array, offset: number) => {
        get(nbits: number): number;
        get1(): number;
        readonly bits: number;
        readonly bitlen: number;
        readonly cur: number;
    };
    readonly ArithBits: new (data: Uint8Array, offset: number) => {
        getCount(scale: number): number;
        getValue(scale: number): number;
        remove(start: number, count: number, scale: number): void;
        readonly high: number;
        readonly low: number;
        readonly code: number;
    };
    readonly ArithModel: new (uniqueValues: number) => object;
    readonly EscapeSymbol: new (index: number) => { readonly index: number };
    readonly LZState: new (header: Oodle0LZHeader) => object;
    readonly u32lePadded: (data: Uint8Array, offset: number) => number;
    readonly blockStops: (section: { expanded_size: number; first_16bit: number; first_8bit: number }) => readonly [number, number, number, number];
    readonly clampStop: (value: number, expandedSize: number) => number;
    readonly alignedCount: (uniqueValues: number) => number;
    readonly bestShift: (value: number) => readonly [number, number, number];
};
