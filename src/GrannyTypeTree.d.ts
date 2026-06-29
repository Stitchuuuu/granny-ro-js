// Sibling .d.ts paired with GrannyTypeTree.js.
// TypeScript automatically uses this file as the type signature for the
// adjacent .js — no JSDoc imports or jsconfig wiring needed in callers.

import type { GR2File } from './GrannyFile.js';

/** `[section_index, offset_within_section]` pair used everywhere as a ref. */
export type SectionRef = readonly [number, number];

/** `{section, offset}` dict shape returned for caller convenience. */
export interface RefDict {
    readonly section: number;
    readonly offset: number;
}

/** One MEMBER_TYPE constant value (0–22). See {@link MEMBER_TYPE_NAMES}. */
export type MemberTypeConstant = number;

/** Member descriptor read from one 32-byte record of a DataTypeDefinition chain. */
export interface TypeMember {
    /** Raw `MT_*` enum value (0–22). */
    readonly memberType: MemberTypeConstant;
    /** Human name for {@link memberType} (`'reference'`, `'string'`, …). */
    readonly memberTypeName: string;
    /** Member name (ASCII, decoded from the string-pointer slot). */
    readonly name: string;
    /** Decoded sub-type ref, or `null` for scalar / terminal members. */
    readonly referenceType: SectionRef | null;
    /** Array width (default 1 for non-array members). */
    readonly arrayWidth: number;
    /** Three extra u32 slots in the on-disk record (Granny SDK metadata). */
    readonly extra: readonly [number, number, number];
    /** Byte offset of this record within its containing section. */
    readonly offset: number;
}

/** One pointer-fixup entry : rebases a writer-side pointer to a `[section, offset]` ref. */
export interface PointerFixup {
    readonly source_section: number;
    readonly source_offset: number;
    readonly target: SectionRef;
}

/** One mixed-marshalling entry : describes an endian-flip the writer expects. */
export interface MixedMarshallingFixup {
    readonly source_section: number;
    readonly count: number;
    readonly offset: number;
    readonly type_ref: SectionRef;
}

/** Bundle of decompressed sections + applied pointer fixups ready for walking. */
export interface LoadedGR2 {
    /** The originating GR2 file (header + section table). */
    readonly file: GR2File;
    /** One `Uint8Array` per section, decompressed, untouched (scalar reads). */
    readonly sectionsOriginal: readonly Uint8Array[];
    /** One `Uint8Array` per section, with pointer-fixup slots overwritten by fake pointers. */
    readonly sectionsFixed: readonly Uint8Array[];
    /** All pointer fixups parsed from the file (flattened across sections). */
    readonly pointerFixups: readonly PointerFixup[];
    /** All mixed-marshalling fixups parsed from the file (typically empty for LE corpus). */
    readonly mixedFixups: readonly MixedMarshallingFixup[];
    /** Pointer width in bytes (4 for 32-bit files, 8 for 64-bit). */
    readonly pointerSize: 4 | 8;
}

/** Common shape of a materialized field returned by {@link parseObject}. */
export interface ParsedField {
    /** `memberTypeName` from the source {@link TypeMember} (`'reference'`, `'string'`, …). */
    readonly type: string;
    /** Byte offset of the field inside its parent struct. */
    readonly offset: number;
    /** Sub-type ref, if the source member had one. */
    readonly reference_type?: RefDict;
    /** Decoded scalar value (set for `int*` / `uint*` / `real32` / `string`). */
    readonly value?: number | string;
    /** Resolved target ref (set for `reference` / `*_to_array` / `*_of_references`). */
    readonly target?: RefDict | null;
    /** Element count (set for `*_to_array` / `*_of_references` / `*_variant_array`). */
    readonly count?: number;
    /** True when {@link count} exceeded `maxArrayRefs` (only `element_refs` is truncated). */
    readonly truncated?: boolean;
    /** Decoded per-element refs (only set for `array_of_references`). */
    readonly element_refs?: readonly RefDict[];
    /** Resolved variant-type ref (set for `variant_reference` / `reference_to_variant_array`). */
    readonly variant_type?: RefDict | null;
    /** Materialized sub-object (only set for `inline` members). */
    readonly inline?: ParsedObject;
}

/** Plain JS object materialized from one `[ref, typeTree]` pair, keyed by member name. */
export interface ParsedObject {
    readonly [memberName: string]: ParsedField;
}

/** Options for {@link parseTypeTree}. */
export interface ParseTypeTreeOptions {
    /** Cap on the number of member records walked (defaults to 512). */
    readonly maxMembers?: number;
}

/** Options for {@link parseObject}. */
export interface ParseObjectOptions {
    /** Cap on the number of `element_refs` returned per array (defaults to 256). */
    readonly maxArrayRefs?: number;
}

/** Options for {@link readReferenceArrayObjects}. */
export interface ReadReferenceArrayObjectsOptions {
    /** Cap on the number of array elements walked (defaults to 64). */
    readonly maxCount?: number;
    /** Cap forwarded to {@link parseObject} per element (defaults to `maxCount`). */
    readonly maxArrayRefs?: number;
}

/** One element of an inline-struct array as returned by {@link readReferenceArrayObjects}. */
export interface ReferenceArrayObject {
    /** Per-object `{section, offset}` within the array's section (needed to address raw struct bytes). */
    readonly ref: RefDict;
    /** Materialized field map for this element (same shape as {@link parseObject}). */
    readonly fields: ParsedObject;
}

// --- MEMBER_TYPE constants (verbatim from blendergranny types.py) -----

export const MT_END: 0;
export const MT_INLINE: 1;
export const MT_REFERENCE: 2;
export const MT_REFERENCE_TO_ARRAY: 3;
export const MT_ARRAY_OF_REFERENCES: 4;
export const MT_VARIANT_REFERENCE: 5;
export const MT_UNSUPPORTED: 6;
export const MT_REFERENCE_TO_VARIANT_ARRAY: 7;
export const MT_STRING: 8;
export const MT_TRANSFORM: 9;
export const MT_REAL32: 10;
export const MT_INT8: 11;
export const MT_UINT8: 12;
export const MT_BINORMAL_INT8: 13;
export const MT_NORMAL_UINT8: 14;
export const MT_INT16: 15;
export const MT_UINT16: 16;
export const MT_BINORMAL_INT16: 17;
export const MT_NORMAL_UINT16: 18;
export const MT_INT32: 19;
export const MT_UINT32: 20;
export const MT_REAL16: 21;
export const MT_EMPTY_REFERENCE: 22;

/** MEMBER_TYPE constant → human name. */
export const MEMBER_TYPE_NAMES: Readonly<Record<number, string>>;

// --- fake-pointer codec -----------------------------------------------

export const FAKE_POINTER_BASE: 0x10000000;
export const FAKE_SECTION_STRIDE: 0x100000;

/** Encode a `[section, offset]` ref as a single u32 fake pointer. */
export function makeFakePointer(section: number, offset: number): number;

/** Decode a fake pointer back into `[section, offset]`, or `null` if invalid. */
export function decodeFakePointer(pointer: number, sectionCount: number): SectionRef | null;

// --- main entries -----------------------------------------------------

/**
 * Decompress every section, apply pointer fixups, return a `LoadedGR2`
 * ready for the type-tree walker. See module header for fake-pointer rationale.
 *
 * @throws Error on cross-endian assets with non-empty mixed-marshalling tables
 * @throws RangeError when a declared fixup table escapes the file
 */
export function loadGR2(file: GR2File): LoadedGR2;

/**
 * Walk a DataTypeDefinition chain starting at `ref` until an MT_END marker.
 * Returns the member descriptors in source order.
 */
export function parseTypeTree(
    loaded: LoadedGR2,
    ref: SectionRef,
    options?: ParseTypeTreeOptions,
): readonly TypeMember[];

/**
 * Materialize one instance against `typeTree`, walking
 * `loaded.sectionsFixed[ref[0]]` from `ref[1]`. Returns a `ParsedObject`
 * keyed by member name.
 */
export function parseObject(
    loaded: LoadedGR2,
    typeTree: readonly TypeMember[],
    ref: SectionRef,
    options?: ParseObjectOptions,
): ParsedObject;

/**
 * Total storage size (in bytes) of an instance with members `members`.
 * Walks INLINE sub-types recursively. `seen` guards against cyclic
 * schemas — pass a fresh `Set` at the call site.
 */
export function objectStorageSize(
    loaded: LoadedGR2,
    members: readonly TypeMember[],
    pointerSize: number,
    seen: Set<number>,
): number;

/**
 * Walk an inline-struct array : `count` objects of `typeRef`-shaped struct
 * packed back-to-back starting at `arrayRef`. Returns each as
 * `{ref, fields}` so callers can address raw struct bytes for fields not
 * covered by `parseObject` (e.g. SkeletonBone's `Transform` is 68 raw
 * bytes at the field's offset in the object's section).
 */
export function readReferenceArrayObjects(
    loaded: LoadedGR2,
    arrayRef: RefDict | null,
    count: number,
    typeRef: RefDict | null,
    options?: ReadReferenceArrayObjectsOptions,
): readonly ReferenceArrayObject[];

/** Internals exposed to the unit-test suite. NOT part of the public API. */
export const __test__: Readonly<{
    makeU32Reader: (byteReversed: boolean) => (bytes: Uint8Array, offset: number) => number;
    readPointer: (bytes: Uint8Array, offset: number, pointerSize: number, byteReversed: boolean) => number;
    writePointer: (bytes: Uint8Array, offset: number, value: number, pointerSize: number, byteReversed: boolean) => void;
    readGrannyString: (loaded: LoadedGR2, ref: SectionRef, maxLength?: number) => string;
    readStringPointer: (loaded: LoadedGR2, pointer: number) => string;
    memberStorageSize: (member: TypeMember, pointerSize: number) => number;
    objectStorageSize: (loaded: LoadedGR2, members: readonly TypeMember[], pointerSize: number, seen: Set<number>) => number;
    readArrayReferences: (loaded: LoadedGR2, arrayRef: SectionRef | null, count: number, maxCount: number) => readonly RefDict[];
    looksText: (bytes: Uint8Array) => boolean;
    SCALAR_SIZES: Readonly<Record<number, number>>;
}>;
