# granny-ro-js

[![npm](https://img.shields.io/npm/v/granny-ro-js/alpha?label=npm)](https://www.npmjs.com/package/granny-ro-js)
[![CI](https://github.com/stitchuuuu/granny-ro-js/actions/workflows/test.yml/badge.svg)](https://github.com/stitchuuuu/granny-ro-js/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/granny-ro-js.svg)](LICENSE)

Pure-JS reader for `.gr2` (Granny3D format 6) files. Decompresses
(Oodle0), parses bones + meshes + animations, composes per-bone
skinning matrices ready for GPU upload. Zero runtime dependencies.

## Scope

Validated **byte-exact on 21 corpus fixtures** (6 models + 15
animations) vs canonical RAD `granny2.dll` AND a Python clean-room
decoder. Supports Granny format 6, little-endian, 32-bit pointers,
Oodle0 / NoCompression compression.

**Out of scope :** modern Granny dialects (Oodle1 / Bitknit, big-endian,
64-bit pointers, format ≥ 2.8). PRs with fixtures from another Granny
dialect are welcome.

> Currently published as `1.0.0-a.1` (alpha) — feature surface is
> complete, but the lib is awaiting consumer-side integration before
> graduating to plain `1.0.0`. Install with the `@alpha` tag :

## Install

```bash
npm install granny-ro-js@alpha
```

Requires Node 20+. No runtime dependencies.

## Usage

```js
import { parseAnimated, poseAt } from 'granny-ro-js';
import { readFileSync } from 'node:fs';

// 1. Parse a model + its animation set (separate .gr2 files in iRO).
const model = parseAnimated(readFileSync('treasurebox.gr2').buffer);
const anim  = parseAnimated(readFileSync('treasurebox_idle.gr2').buffer);

// 2. Graft the animation onto the model (iRO layout : model + N anims
// in separate files, joined at runtime by mob ID).
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
| Full corpus (21 fixtures / 1.65 MB) | **104 ms** (~15.9 MB/s) |
| Biggest single section (`7_dead.gr2 #0`, 82 KB) | **7.4 ms** (~10.9 MB/s) |
| vs. Python clean-room reference | **~55× faster** overall |

Measured on aarch64 Apple Silicon, Node 20. Reproduce with `npm run
bench` or `npm run perf:compare` (after `npm run bake`). Full breakdown
in [docs/perf-baseline.md](docs/perf-baseline.md).

## Lineage & credits

MIT licensed.

- **Oodle0 codec + format walker** — clean-room port of
  [Rasetsuu/blendergranny](https://github.com/Rasetsuu/blendergranny)
  (Python, MIT). The Python clean-room is one of the three validation
  oracles in the live test suite.
- **Oodle0 byte parity reference** — RAD `granny2.dll` (proprietary,
  RAD). Used as a third oracle via a small mingw + Wine shim built
  from MIT C source ([magcius/noclip.website](https://github.com/magcius/noclip.website)).
  Neither the DLL nor the shim binary are shipped.
- **Leaked Granny SDK source** is **not** used as a port source —
  referenced only as an asm-cite oracle if the Python clean-room and
  the DLL ever disagree.

See [LICENSE](LICENSE) for full attribution.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, the live-
oracle test path, and the release flow.
