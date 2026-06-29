# Granny2 .gr2 — binary format reference

Byte-level layout of `.gr2` files (Granny 2.x, the format Gravity uses
for WoE objects). Built by porting `Rasetsuu/blendergranny`'s Python
parser to JS + reading `iRO_ver12.0-full-client-data/granny2.dll` strings.
The fields documented here are what `granny-ro-js` actually parses today
(S3') — the full type-tree walker (DataTypeDefinition + RootObject) is
the job of session S5 and onward, and IS NOT documented yet.

All multi-byte fields are u32 unless noted. Little-endian on disk for
the magic variants our corpus uses (`MAGIC_32LE`) ; the parser also
handles big-endian (`MAGIC_32BE`) and 64-bit-pointer variants
(`MAGIC_64LE`, `MAGIC_64BE`).

## 1. File-level layout

```
+------------------------------------------+
| 0x00  Magic (32 bytes — 4 u32)           |
+------------------------------------------+
| 0x20  Header                             |
|       v6: 60 bytes / v7+: 72 bytes       |
+------------------------------------------+
|       Section array                      |
|       header.section_count × 44 bytes    |
+------------------------------------------+
|       Section data (compressed payloads, |
|       referenced by section.data_offset) |
+------------------------------------------+
|       Pointer / mixed-marshalling tables |
|       (per-section, indexed by section's |
|       pointer_fixup_offset / count)      |
+------------------------------------------+
```

The section array starts at offset `MAGIC_SIZE + header.section_array_offset`,
NOT at `header.section_array_offset` alone — `section_array_offset` is
relative to the post-magic header origin, not the file origin. The parser
adds `MAGIC_SIZE` automatically. (This trap caught the S2 magcius shim too —
see `iRO_ver12.0-full-client-data/RE/granny2/shim/gr2_decompress.c` line 67.)

## 2. Magic (32 bytes)

The first 16 bytes are a fixed 4-u32 quad that identifies the format
variant ; the next 16 bytes are reserved (zero in our corpus).

| Constant     | Quad (u32 little-endian as seen on disk)                | Endianness | Pointer width |
|--------------|---------------------------------------------------------|------------|---------------|
| `MAGIC_OLD`  | `0xCAB067B8 0x0FB16DF8 0x7E8C7284 0x1E00195E`           | LE         | 32 (implicit) |
| `MAGIC_32LE` | `0xC06CDE29 0x2B53A4BA 0xA5B7F525 0xEEE266F6`           | LE         | 32            |
| `MAGIC_32BE` | (`MAGIC_32LE`'s u32s, each byte-reversed)               | BE         | 32            |
| `MAGIC_64LE` | `0x5E499BE5 0x141F636F 0xA9EB131E 0xC4EDBE90`           | LE         | 64            |
| `MAGIC_64BE` | (`MAGIC_64LE`'s u32s, each byte-reversed)               | BE         | 64            |

Detection : read the first 4 u32 LE ; compare directly to the LE
constants ; if no match, byte-reverse each u32 (= read as BE) and
compare to the LE constants again. A match in the second pass means
the file is big-endian — subsequent u32 reads should be BE too.

All 21 .gr2 in iRO ver12 use `MAGIC_32LE`.

## 3. Header

Read u32s relative to offset `MAGIC_SIZE = 0x20`.

| Offset (+ 0x20) | Field                  | Type                    | Meaning                                                       |
|-----------------:|------------------------|-------------------------|---------------------------------------------------------------|
| 0                | `version`              | u32                     | Format version. ≥ 7 for the iRO ver12 corpus.                 |
| 4                | `total_size`           | u32                     | File size as declared by the writer.                          |
| 8                | `crc`                  | u32                     | CRC32 of the file's data.                                     |
| 12               | `section_array_offset` | u32                     | Section array offset, relative to `MAGIC_SIZE`.               |
| 16               | `section_count`        | u32                     | Number of entries in the section array.                       |
| 20               | `root_type`            | (u32, u32)              | `[section_index, offset_within_section]` — root type ref.     |
| 28               | `root_object`          | (u32, u32)              | `[section_index, offset_within_section]` — root object ref.   |
| 36               | `type_tag`             | u32                     | Schema-generation tag.                                        |
| 40               | `extra_tags`           | 4 × u32                 | User / auxiliary tags.                                        |
| 56               | `string_db_crc`        | u32 (only if `version ≥ 7`) | String-database CRC.                                      |
| 60               | `reserved`             | 3 × u32 (only if `version ≥ 7`) | SDK-dependent ; zeros in our corpus.                  |

Total : 60 bytes for `version < 7`, 72 bytes for `version ≥ 7`.

## 4. Section array

Starts at `MAGIC_SIZE + section_array_offset`. Each record is 44 bytes
of u32s.

| Offset (within record) | Field                       | Meaning                                                                         |
|------------------------:|-----------------------------|---------------------------------------------------------------------------------|
| 0                       | `compression`               | Algorithm tag — see § 5. Compression types.                                     |
| 4                       | `data_offset`               | Offset of the section's compressed bytes, relative to the **file start**.       |
| 8                       | `data_size`                 | Length of the on-disk compressed bytes.                                         |
| 12                      | `expanded_size`             | Target length after decompression. Equals `data_size` when `compression = 0`.   |
| 16                      | `internal_alignment`        | Required alignment for the section data buffer (4 / 8 / …).                     |
| 20                      | `first_16bit`               | Oodle0 block-stop 1 — decoded-byte offset where the 16-bit length context ends. |
| 24                      | `first_8bit`                | Oodle0 block-stop 2 — decoded-byte offset where the 8-bit length context ends.  |
| 28                      | `pointer_fixup_offset`      | Pointer-fixup table offset (rebase post-decompress — S5+).                      |
| 32                      | `pointer_fixup_count`       | Pointer-fixup entry count (12 bytes each).                                      |
| 36                      | `mixed_marshalling_offset`  | Mixed-marshalling table offset (cross-endian flips — S5+).                      |
| 40                      | `mixed_marshalling_count`   | Mixed-marshalling entry count (12 bytes each).                                  |

### Section semantic slots

The standard Granny 2.x distribution uses a fixed 6-slot layout
(matches all 21 fixtures of the iRO ver12 corpus) :

| `index` | Semantic name        | Typical content                                                  |
|--------:|----------------------|------------------------------------------------------------------|
| 0       | `main`               | The bulk of the model — type-tree, root object, materials.       |
| 1       | `rigid_vertex`       | Vertex data for rigid (non-skinned) meshes.                      |
| 2       | `rigid_index`        | Index data for rigid meshes.                                     |
| 3       | `deformable_vertex`  | Vertex data for skinned meshes.                                  |
| 4       | `deformable_index`   | Index data for skinned meshes.                                   |
| 5       | `texture`            | Bitmaps (BMP / TGA chunks). Always `NoCompression` in our corpus.|
| 6       | `discardable`        | Optional ; not present in iRO ver12.                             |
| 7       | `unloaded`           | Optional ; not present in iRO ver12.                             |

iRO ver12 layout : 6 sections per file (indices 0..5), 84 % are Oodle0,
16 % are `NoCompression` (always slot 5, the texture).

## 5. Compression types

| Tag | Constant               | Status in granny-ro-js                            |
|----:|------------------------|------------------------------------------------|
| 0   | `COMPRESSION_NONE`     | ✅ supported — pass-through `data_size` bytes  |
| 1   | `COMPRESSION_OODLE0`   | ✅ supported — see § 6.                        |
| 2   | `COMPRESSION_OODLE1`   | ❌ throws — not used in our corpus             |
| 3   | `COMPRESSION_BITKNIT`  | ❌ throws — not used in our corpus             |
| 4   | `COMPRESSION_BITKNIT2` | ❌ throws — not used in our corpus             |

## 6. Oodle0 bitstream

Oodle0 is the **classic 2002-era RAD Tools internal codec embedded in
`granny2.dll`** — NOT modern Oodle Kraken / Mermaid / Leviathan. Debug
path leaked in the DLL strings : `w:/public/granny/rt/granny_oodle0_compression.cpp`.

A compressed section is structured :

```
+------------------------------------------+
|  Block 0 LZ header  (12 bytes)           |
|  Block 1 LZ header  (12 bytes)           |
|  Block 2 LZ header  (12 bytes)           |
+------------------------------------------+
|  Bitstream (variable length)             |
|  → starts at section offset 36           |
|  → little-endian u32 words, bit-level    |
|    consumed by VarBits + ArithBits       |
+------------------------------------------+
```

### LZ header (12 bytes per block — 3 u32s)

| Offset | Field                   | Bits used                       | Meaning                                                  |
|-------:|-------------------------|---------------------------------|----------------------------------------------------------|
| 0      | `max_offset_and_byte`   | 9 low + 23 high                 | Max literal value (low 9) + max LZ77 back-distance.      |
| 4      | `uniq_offset_and_byte`  | 9 low + 23 high                 | Literal alphabet size + offset alphabet size.            |
| 8      | `uniq_lens`             | 4 × 8 bits (MSB-first per group)| Unique-symbol count per length-context group (4 groups). |

### Three-block decoding strategy

The 65 possible length symbols `0..MAX_LENS` (`MAX_LENS = 64`) split
into 3 contexts (8-bit / 16-bit / 32-bit) based on how far the decoder
has emitted. Each context gets its own block with its own arith model.

Block stops come from the **section header** (NOT from the bitstream),
clamped to `[0, expanded_size]` :

- Block 0 emits decoded bytes 0 to `section.first_16bit` (32-bit-context
  range, dense back-references over the whole window).
- Block 1 emits `first_16bit` to `first_8bit` (16-bit-context).
- Block 2 emits `first_8bit` to `expanded_size` (8-bit-context, smallest
  back-distance window).

If a block's stop range is empty (e.g. `first_16bit == 0`), the block is
skipped (`is_empty = true`). 

### Long lengths

Length symbol `0` = literal. Symbols `1..(MAX_LENS - 4)` (= 1..60) map to
literal lengths `2..61` (off-by-one). Symbols ≥ `MAX_LENS - 3` (= 61, 62,
63, 64) decode to `LONG_LENGTHS = [128, 192, 256, 512]` respectively.

### Bitstream consumption

- `VarBits` reads bit-level fields LSB-first from 32-bit LE words.
- `ArithBits` is a 31-bit arithmetic decoder (`low`, `high`, `code` all
  capped at `0x7FFFFFFF`). The `bitReverse` calls on byte / nibble
  groups are critical : missing one = silent bit-bleed = mismatch on
  some section in fixture N+1.
- `ArithModel` is an adaptive model with escape symbols + rescaling.
  Three contexts per block (literals, lengths × 65, offset-low,
  offset-high).

For details on the arith decoder + rescale logic, see `src/GrannyOodle0.js`
in this package (which is a 1:1 port of `Rasetsuu/blendergranny`'s
`io_scene_gr2/gr2/decompress/oodle0.py`). The leaked Microsoft Game
Studios source mirror — file `//jeffr/granny/rt/granny_oodle0_compression.cpp`
in `sgzwiz/misc_microsoft_gamedev_source_code` — byte-matches our DLL's
embedded string path and is the asm-cite reference for any edge case the
clean-room port disagrees with the DLL on. (We've validated parity on
105/105 sections of the corpus ; no edge cases hit so far.)

## 7. What this doc does NOT cover (yet)

The following live inside section 0 (`main`) and are S8+ jobs in the
[granny-pipeline rollout](../../../plans/granny-pipeline/STATUS.md) :

- **Pose composition** (parent × local transform, equivalent of
  `GrannyGetWorldPoseComposite4x4Array` in the SDK). S8.

`DataTypeDefinition` + `RootObject` (S5) shipped — see §8.
`Skeleton` + `MeshGeometry` extraction (S6) shipped — `Granny.parseModel(buffer)`
returns `{ file, typeTree, root, skeletons, meshes }` ; see
[`../src/GrannySkeleton.js`](../src/GrannySkeleton.js) and
[`../src/GrannyMesh.js`](../src/GrannyMesh.js).
`Animation` / `TrackGroup` / `TransformTrack` + curve codec (S7) shipped —
`Granny.parseAnimated(buffer)` adds `animations: Animation[]` to the parseModel
shape ; `evaluateTransformTrack(track, t)` and `evaluateAnimation(anim, t)`
sample the curves. See [`../src/GrannyAnimation.js`](../src/GrannyAnimation.js).
Seven curve codecs supported (`LegacyCurve32f`, `D3K16uC16u`, `D3I1K16uC16u`,
`D4nK8uC7u`, `D4nK16uC15u`, `*Constant32f`, `DaIdentity`) — no Oodle0 in the
curve data, purely elementary quantization + bit-packing.

## 8. DataTypeDefinition + RootObject (S5)

Once a section's bytes are decompressed, every in-section pointer was
written by the SDK at *export time* against the writer's address space
— meaningless at load. Two metadata tables per section, both pointed
at by the section header, encode the rebase :

- `pointer_fixup_offset` / `pointer_fixup_count` — array of 12-byte
  entries `(source_offset:u32, target_section:u32, target_offset:u32)`
  (v7+ ; v6 uses 8-byte entries with a fake-pointer encoded value, not
  in our corpus).
- `mixed_marshalling_offset` / `mixed_marshalling_count` — 16-byte
  entries `(count:u32, offset:u32, type_section:u32, type_offset:u32)`
  describing inline endian-flips the writer expects. Empty for the
  all-LE iRO corpus ; non-empty + `byte_reversed` is rejected
  defensively.

The walker doesn't carry the fixup table around — instead it follows
[blendergranny `fixup.py:14–15, 66–78`](https://github.com/Rasetsuu/blendergranny)
and **rewrites the pointer slots in-place** with synthesized « fake
pointers » that encode `[section, offset]` directly :

```
fake = FAKE_POINTER_BASE + section * FAKE_SECTION_STRIDE + offset
     = 0x10000000 + section * 0x100000 + offset
```

Decoding is the trivial inverse. The walker reads a pointer from the
fixed-up section bytes, decodes it back to `[section, offset]`, then
indexes into the right section. The original (un-rewritten) section
bytes are kept around for scalar / string reads where the in-place
value is the actual datum, not a writer-side pointer.

### MEMBER_TYPE enum

`DataTypeDefinition` chains terminate at an `MT_END` sentinel and live
inside a section as a sequence of 32-byte records :

| Offset | Field          | Notes |
|-------:|----------------|-------|
| 0      | `member_type`  | `MT_*` enum value (0–22, see below) |
| 4      | `name_ptr`     | fake-pointer → ASCII / NUL-terminated string |
| 8      | `type_ptr`     | fake-pointer → sub-type chain, or 0 |
| 12     | `array_width`  | array width (default 1 if 0) |
| 16     | `extra[3]`     | 3 × u32 of SDK metadata |
| 28     | _unused_       | 1 × u32 padding |

MEMBER_TYPE constants (`io_scene_gr2/gr2/types.py:11–33`, ported 1:1) :

| Value | Name                          | Storage in parent struct |
|------:|-------------------------------|--------------------------|
| 0     | `end`                          | — (sentinel) |
| 1     | `inline`                       | recursive (sub-tree expanded in place) |
| 2     | `reference`                    | 1 pointer |
| 3     | `reference_to_array`           | 4 + 1 pointer |
| 4     | `array_of_references`          | 4 + 1 pointer |
| 5     | `variant_reference`            | 2 pointers |
| 6     | `unsupported`                  | 1 pointer (best-effort) |
| 7     | `reference_to_variant_array`   | pointer + 4 + pointer |
| 8     | `string`                       | 1 pointer |
| 9     | `transform`                    | 68 bytes |
| 10    | `real32`                       | 4 |
| 11    | `int8`                         | 1 |
| 12    | `uint8`                        | 1 |
| 13    | `binormal_int8`                | 1 |
| 14    | `normal_uint8`                 | 1 |
| 15    | `int16`                        | 2 |
| 16    | `uint16`                       | 2 |
| 17    | `binormal_int16`               | 2 |
| 18    | `normal_uint16`                | 2 |
| 19    | `int32`                        | 4 |
| 20    | `uint32`                       | 4 |
| 21    | `real16`                       | 2 |
| 22    | `empty_reference`              | 1 pointer (null marker) |

### Public API

See `src/GrannyTypeTree.js` (full layer-by-layer source) and
`src/GrannyTypeTree.d.ts` (typed surface). Three entry points, exposed
through the package root :

- `loadGR2(file)` — decompress all sections + apply pointer fixups.
- `parseTypeTree(loaded, ref)` — walk a chain starting at `ref`.
- `parseObject(loaded, typeTree, ref)` — materialize one instance.

The top-level `Granny.parse(buffer)` chains the three plus
`parseGR2File` ; for any of the 21 iRO ver12 fixtures it returns
`{ file, typeTree, root }` where `root` is keyed by member name :

```js
import { parse } from 'granny-ro-js';
const { root } = parse(readFileSync('treasurebox_2.gr2'));
root.Meshes;     // { type: 'array_of_references', count: 1, target, element_refs }
root.Skeletons;  // { type: 'array_of_references', count: 1, target, element_refs }
```

### Port source + parity

Ported from [`Rasetsuu/blendergranny`](https://github.com/Rasetsuu/blendergranny)
`io_scene_gr2/gr2/{fixup,types}.py` (MIT, same provenance as the Oodle0
codec). The noclip alternative (`magcius/noclip.website/src/RagnarokOnline/granny.ts`,
MIT) was audited as a cross-reference but not used — it builds a
single concatenated blob + absolute-offset lookup map that doesn't fit
our `[section, offset]` abstraction.

S5 parity validated three ways :

1. 21/21 fixtures parse without throwing (`tests/unit/GrannyParse.test.js`).
2. Each fixture's root carries at least one of `Meshes` / `Skeletons` /
   `Animations` / `Materials` / `Textures` with a sane non-fallback
   member name (no `member_NNN`).
3. 21/21 fixtures match the Python oracle field-by-field on
   `typeTreeMemberNames`, `rootKeys`, and per-array `count`
   (`tests/integration/GrannyParseLive.test.js`, env-gated by
   `GRANNY_LIVE_ORACLE=1`).
