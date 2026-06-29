// Sibling .d.ts paired with GrannyFile.js.
// TypeScript automatically uses this file as the type signature for the
// adjacent .js — no JSDoc imports or jsconfig wiring needed in callers.

/** Acceptable input shapes for the parser. */
export type GR2Input = ArrayBuffer | Uint8Array | DataView | ArrayBufferView;

/** Quad of u32 magic words (4 × 4 bytes at the file start). */
export type GR2Magic = readonly [number, number, number, number];

/** Compression tag, see {@link COMPRESSION_NAMES}. */
export type CompressionTag = 0 | 1 | 2 | 3 | 4;

/** Granny section-slot index, see {@link SECTION_NAMES}. */
export type SectionIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/**
 * One entry in the GR2 section table (44 bytes on disk — see
 * `docs/gr2-format.md` § Section record).
 *
 * `compression_name` and `semantic_name` are computed accessors ; the
 * rest map 1-to-1 to the on-disk u32s.
 */
export interface GR2Section {
    /** 0-based position in the section table. */
    readonly index: number;
    /** Compression algorithm tag (0=none, 1=Oodle0, 2=Oodle1, 3=BitKnit, 4=BitKnit2). */
    readonly compression: number;
    /** Offset of this section's compressed bytes, relative to the file start. */
    readonly data_offset: number;
    /** Length of this section's compressed bytes on disk. */
    readonly data_size: number;
    /** Target length of the section once decompressed. */
    readonly expanded_size: number;
    /** Required alignment for this section's data buffer (4 / 8 / …). */
    readonly internal_alignment: number;
    /** Oodle0 block-stop 1 : decoded-byte offset where the 16-bit length context ends. */
    readonly first_16bit: number;
    /** Oodle0 block-stop 2 : decoded-byte offset where the 8-bit length context ends. */
    readonly first_8bit: number;
    /** Pointer-fixup table offset (S5+ : rebases intra-file pointers post-decompress). */
    readonly pointer_fixup_offset: number;
    /** Pointer-fixup entry count, 12 bytes each. */
    readonly pointer_fixup_count: number;
    /** Mixed-marshalling table offset (S5+ : endian flips for cross-endian loads). */
    readonly mixed_marshalling_offset: number;
    /** Mixed-marshalling entry count, 12 bytes each. */
    readonly mixed_marshalling_count: number;
    /** Computed : human name for {@link compression} (`'none'`, `'oodle0'`, …). */
    readonly compression_name: string;
    /** Computed : Granny semantic name for {@link index} (`'main'`, `'rigid_vertex'`, …). */
    readonly semantic_name: string;
}

/** Top-level GR2 file header (~72 bytes for version ≥ 7, ~60 bytes otherwise). */
export interface GR2Header {
    /** Granny file format version — ≥ 7 across our iRO ver12 corpus. */
    readonly version: number;
    /** Total file size as declared by the writer. */
    readonly total_size: number;
    /** CRC32 of the file's contents. */
    readonly crc: number;
    /** Offset of the section array relative to the end of the magic. */
    readonly section_array_offset: number;
    /** Number of entries in the section array. */
    readonly section_count: number;
    /** Root-type reference : `[section_index, offset_within_section]`. */
    readonly root_type: readonly [number, number];
    /** Root-object reference : `[section_index, offset_within_section]`. */
    readonly root_object: readonly [number, number];
    /** Type-tag identifying the .gr2 schema generation. */
    readonly type_tag: number;
    /** 4 user / auxiliary tag values. */
    readonly extra_tags: readonly number[];
    /** String-database CRC (version ≥ 7). */
    readonly string_db_crc: number;
    /** 3 reserved u32 (version ≥ 7) ; value depends on SDK generation. */
    readonly reserved: readonly number[];
    /** Pointer width baked into the file's serialized references (32 or 64). */
    readonly pointer_size: 32 | 64;
    /** True if u32s are stored byte-reversed (matches big-endian magic variants). */
    readonly byte_reversed: boolean;
}

/** Parsed GR2 file, ready for section decompression. */
export interface GR2File {
    readonly header: GR2Header;
    readonly sections: readonly GR2Section[];
    /** Raw input bytes — kept for sliced reads via {@link sectionBytes}. */
    readonly data: Uint8Array;
    /** Slice of `data` carrying `section`'s on-disk compressed bytes. */
    sectionBytes(section: GR2Section): Uint8Array;
}

/** Result of magic detection (precedes a full parse). */
export interface GR2DetectResult {
    /** True if the buffer's first 16 bytes match one of the known magics. */
    ok: boolean;
    /** True if u32s should be read big-endian. */
    byteReversed: boolean;
    /** Pointer width baked into the file (`0` when `ok === false`). */
    pointerSize: 0 | 32 | 64;
}

/**
 * Parse a GR2 buffer's header + section table. Does NOT decompress
 * section payloads — call `decompressSection` per section for that.
 *
 * @throws when the buffer is not a Granny2 file
 * @throws RangeError when the declared section table is out of range
 */
export function parseGR2File(buffer: GR2Input): GR2File;

/** Recognize a buffer as a GR2 (any variant) without parsing it. */
export function detectGR2(buffer: GR2Input): GR2DetectResult;

export const MAGIC_OLD:  GR2Magic;
export const MAGIC_32LE: GR2Magic;
export const MAGIC_32BE: GR2Magic;
export const MAGIC_64LE: GR2Magic;
export const MAGIC_64BE: GR2Magic;

export const MAGIC_SIZE:          32;
export const SECTION_RECORD_SIZE: 44;
export const EXTRA_TAG_COUNT:     4;

export const COMPRESSION_NONE:     0;
export const COMPRESSION_OODLE0:   1;
export const COMPRESSION_OODLE1:   2;
export const COMPRESSION_BITKNIT:  3;
export const COMPRESSION_BITKNIT2: 4;

/** Compression tag → human name. */
export const COMPRESSION_NAMES: Readonly<Record<number, 'none' | 'oodle0' | 'oodle1' | 'bitknit' | 'bitknit2'>>;

/** Section-slot index → Granny semantic name. */
export const SECTION_NAMES: Readonly<Record<number, 'main' | 'rigid_vertex' | 'rigid_index' | 'deformable_vertex' | 'deformable_index' | 'texture' | 'discardable' | 'unloaded'>>;
