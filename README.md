# granny-ro-js

[![npm](https://img.shields.io/npm/v/granny-ro-js/alpha?label=npm)](https://www.npmjs.com/package/granny-ro-js)
[![CI](https://github.com/stitchuuuu/granny-ro-js/actions/workflows/test.yml/badge.svg)](https://github.com/stitchuuuu/granny-ro-js/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/granny-ro-js.svg)](LICENSE)

Pure-JS reader for `.gr2` (Granny3D format 6) files. Decompresses
(Oodle0), parses bones + meshes + animations, composes per-bone
skinning matrices ready for GPU upload. Zero runtime dependencies.

## Scope

Validated **byte-exact on a 21-asset corpus** (6 models + 15 animation
banks) vs canonical RAD `granny2.dll` AND a Python clean-room decoder.
Supports Granny format 6, little-endian, 32-bit pointers, Oodle0 /
NoCompression compression.

**Out of scope :** modern Granny dialects (Oodle1 / Bitknit, big-endian,
64-bit pointers, format ≥ 2.8). PRs with fixtures from another Granny
dialect are welcome.

## Status — `1.0.0` (stable)

**Byte-exact** across the 21-fixture parity corpus, validated against
`granny2.dll` :

| Component | State |
|---|---|
| File parser (header, sections, fixups, type tree) | ✅ byte-exact |
| Oodle0 decompression | ✅ byte-exact |
| Mesh extraction (positions, normals, uvs, indices, skin weights, bone bindings) | ✅ |
| Skeleton extraction (hierarchy, bind pose, inverse-world transforms) | ✅ |
| Animation extraction (orientation / position / scaleShear curves, 7 codec variants) | ✅ |
| Pose composition (skinning matrices ready for GPU) | ✅ |
| Texture — raw RGBA / BGRA path | ✅ byte-exact |
| Texture — wavelet-compressed (Bink-family) path | ✅ 17 / 17 fixtures byte-exact |
| Anti-hang guard on degenerate IGC bitstreams | ✅ throws within 50 ms |

Parity is locked by the content-addressed
[`tests/fixtures/content-manifest.json`](tests/fixtures/content-manifest.json) :
21 fixtures keyed by `.gr2` sha256, with per-element sha256s for every
output category (sections, textures, meshes, skeletons, animations,
materials). `npm test` walks `tests/fixtures/source/`, hashes each
`.gr2`, and compares JS port output element-by-element against the
pinned values — no wine, no DLL needed.

See [docs/HOWTO.md](docs/HOWTO.md) for prerequisites, the full command
matrix (host Node, Docker, multi-host re-bake), and the parity contract
in detail.

## Install

```bash
npm install granny-ro-js
```

Requires Node 20+. No runtime dependencies.

## Usage

```js
import { parseAnimated, poseAt } from 'granny-ro-js';
import { readFileSync } from 'node:fs';

// 1. Parse a model + its animation set (often shipped as separate .gr2
// files — the model carries the mesh + skeleton, the animation file
// carries the per-bone tracks).
const model = parseAnimated(readFileSync('character.gr2').buffer);
const anim  = parseAnimated(readFileSync('character_idle.gr2').buffer);

// 2. Graft the animation onto the model (typical layout when the
// engine joins model + N animation banks at runtime by asset ID).
model.animations = anim.animations;

// 3. Sample the pose at t = 0.5 s into the animation.
const { skinningMatrices } = poseAt(model, 0, 0.5);
// skinningMatrices : Float32Array(16 × boneCount), column-major,
// ready for `gl.uniformMatrix4fv(loc, false, matrices)`.
```

## API

All entry points are pure functions. Buffers in, plain JS objects out.
Sibling `.d.ts` files paired with each `.js` give full TypeScript
intellisense.

| Function | Signature | Use case |
|---|---|---|
| `parse(buffer)` | `(ArrayBuffer) → { file, typeTree, root }` | Raw file + type-tree walk. |
| `parseModel(buffer)` | `(ArrayBuffer) → { …parse, skeletons, meshes }` | + bone hierarchy + decoded vertex / index / weight buffers. |
| `parseAnimated(buffer)` | `(ArrayBuffer) → { …parseModel, animations }` | + animation curves (7 codec variants supported). |
| `poseAt(parsed, animIdx, t)` | `(parsed, number, number) → { localTransforms, worldMatrices, skinningMatrices }` | Per-bone GPU-ready pose at time `t`. Float32Array column-major. |

Sub-path imports for advanced use (each subpath ships its own `.d.ts`) :

```js
import { parseGR2File } from 'granny-ro-js/file';      // file-level only
import { decompressOodle0 } from 'granny-ro-js/oodle0'; // codec direct
import { parseTypeTree } from 'granny-ro-js/typetree';  // type-tree walker
```

## Performance

| Metric | Number |
|---|---|
| Full corpus (21 assets / 1.65 MB) | **104 ms** (~15.9 MB/s) |
| Biggest single Oodle0 section (82 KB) | **7.4 ms** (~10.9 MB/s) |
| vs. Python clean-room reference | **~55× faster** overall |

Measured on aarch64 Apple Silicon, Node 20. Reproduce with `npm run
bench` (vitest benches) or `npm run perf` (raw decompression timings on
the 21-fixture corpus). For a v8 sample profile, use
`npm run perf:profile`. Full breakdown in
[docs/perf-baseline.md](docs/perf-baseline.md).

## Lineage & credits

MIT licensed.

Prior-art that informed the port :

- **[Rasetsuu/blendergranny](https://github.com/Rasetsuu/blendergranny)**
  (Python, MIT) — clean-room Python decoder. The structural side of the
  JS port (format walker, type tree, fixups, mesh / skeleton / animation
  extractors) was informed by reading and porting this codebase, and it
  was used as a third validation oracle during the port (alongside JS +
  the canonical DLL) until the harness migrated to the content-addressed
  manifest in `1.0.0`.
- **[magcius/noclip.website](https://github.com/magcius/noclip.website)**
  (MIT) — RagnarokOnline granny.ts walker + the MIT C source for the
  Wine shim around `granny2.dll`. Audited as a cross-reference for the
  fixup table abstraction.
- **RAD `granny2.dll`** (proprietary, RAD Game Tools) — the canonical
  decoder. Used as the byte-parity oracle via the Wine shim. Neither
  the DLL nor any RAD-copyrighted material is shipped in this repo.
- **Leaked Granny SDK source** — referenced only as an asm-cite oracle
  for edge cases where the prior-art ports disagreed with the DLL ;
  **not** used as a port source.

See [LICENSE](LICENSE) for full attribution.

## Contributing

See [docs/HOWTO.md](docs/HOWTO.md) for the dev setup, the live wine
cross-check, the multi-host re-bake matrix, and troubleshooting.
