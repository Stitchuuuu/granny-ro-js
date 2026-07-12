# granny-ro-js

[![npm](https://img.shields.io/npm/v/granny-ro-js?label=npm)](https://www.npmjs.com/package/granny-ro-js)
[![CI](https://github.com/stitchuuuu/granny-ro-js/actions/workflows/test.yml/badge.svg)](https://github.com/stitchuuuu/granny-ro-js/actions/workflows/test.yml)
[![license](https://img.shields.io/npm/l/granny-ro-js.svg)](LICENSE)

Pure-JS reader for `.gr2` (Granny3D format 6) files. Decompresses
(Oodle0), parses bones + meshes + animations, composes per-bone
skinning matrices ready for GPU upload. Zero runtime dependencies.

## Quick start — JS or WASM

```bash
npm install granny-ro-js
```

```js
// Pure JS — synchronous, zero deps, works everywhere.
import { parseTextured } from 'granny-ro-js';
const { textures } = parseTextured(gr2Bytes);

// WASM — same API, texture decode ~1.3–1.4× faster (one extra `await`).
import { parseTextured, Granny } from 'granny-ro-js/wasm';
await Granny.ready();
const { textures } = parseTextured(gr2Bytes);
```

**Only the texture decode is WASM** (it's the only CPU-hot numeric loop; parse
/ mesh / skeleton / animation stay pure JS, where the engine's JIT already
wins) — with the JS decoder as the automatic byte-exact fallback. One
self-contained file (wasm inlined), so it also runs straight from a CDN.
Full how-to ↓ [WASM texture decode](#wasm-texture-decode-opt-in) · [docs/wasm.md](docs/wasm.md).

## Scope

Validated **byte-exact on a 21-asset corpus** (6 models + 15 animation
banks) vs canonical RAD `granny2.dll` AND a Python clean-room decoder.
Supports Granny format 6, little-endian, 32-bit pointers, Oodle0 /
NoCompression compression.

**Out of scope :** modern Granny dialects (Oodle1 / Bitknit, big-endian,
64-bit pointers, format ≥ 2.8). PRs with fixtures from another Granny
dialect are welcome.

## Status — `1.3.0` (stable)

`1.3.0` is an **untrusted-input hardening** pass — every file-controlled
allocation and recursion in the parse path is now bounded (allocation
caps, recursion depth + cycle guards, WASM-build parity) so a crafted
`.gr2` can't OOM or hang the process. Decode output is byte-identical to
`1.2.0` (same manifest) with no measurable perf regression. See the
[changelog](CHANGELOG.md).

`1.2.0` adds the **opt-in WASM texture decoder** (`granny-ro-js/wasm`) —
same API, one `await Granny.ready()`, the IGC decode runs in WebAssembly
with the pure-JS decoder as the byte-exact fallback (~1.3–1.4× faster
decode in-browser). See the [WASM section](#wasm-texture-decode-opt-in)
below, the full how-to in [docs/wasm.md](docs/wasm.md), and the
[changelog](CHANGELOG.md).

`1.1.0` added a built `dist/` (ESM / CJS / IIFE, single-file + code-split)
and an async init seam (`Granny.ready()`, `loadTextureCodec()`) — decode
output stays byte-identical to `1.0.0`, same content manifest.

**Byte-exact** across the 21-fixture parity corpus, validated against
`granny2.dll` :

| Component | State |
|---|---|
| File parser (header, sections, fixups, type tree) | ✅ byte-exact |
| Oodle0 decompression | ✅ byte-exact |
| Mesh extraction (positions, normals, uvs, indices, skin weights, bone bindings) | ✅ |
| Skeleton extraction (hierarchy, bind pose, inverse-world transforms) | ✅ |
| Animation extraction (orientation / position / scaleShear curves, 7 codec variants) | ✅ |
| Pose composition (skinning matrices ready for GPU) | ✅ DLL-verified¹ |
| Texture — raw RGBA / BGRA path | ✅ byte-exact |
| Texture — wavelet-compressed (Bink-family) path | ✅ 17 / 17 fixtures byte-exact |
| Anti-hang guard on degenerate IGC bitstreams | ✅ throws after >64 consecutive idle arith reads |
| Untrusted-input DoS caps (alloc ceilings, recursion depth + cycle guards, JS + WASM) | ✅ typed throw, byte-exact on legit input |

¹ The pose runtime (`poseAt`) is verified float-for-float against the
real `granny2.dll` composite matrices — not just the Python clean-room
port — by the wine-gated `tests/integration/worldpose-oracle.test.js`
(within `1e-4`, skips cleanly without wine).

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

## WASM texture decode (opt-in)

**Only the Bink-family wavelet texture decode is in WebAssembly** — the one
CPU-hot inner loop (range coder + inverse wavelet + YUV→RGB). Everything
else stays pure JS (parse, Oodle0, mesh, skeleton, animation), and the
pure-JS decoder remains the **mandatory byte-exact fallback**.

**Why only the decode?** It's the only stage that's a tight numeric inner
loop — exactly what WASM accelerates. The rest is pointer-chasing, string
handling and dynamic object graphs, where a JS engine's JIT + GC already
win; porting it would be far more code for no (or negative) gain, and it
wouldn't change the single-file story. Same API, one extra `await` :

```js
import { parseTextured, Granny } from 'granny-ro-js/wasm';

await Granny.ready();                 // instantiate the wasm once (async)
const { textures } = parseTextured(gr2Bytes);   // texture decode runs in wasm
```

- **One file, no separate `.wasm`.** The module is inlined (base64), so
  `granny-ro-js/wasm` is a single ESM import — works from a bundler, a
  `<script type="module">`, a userscript, or a CDN with **one** fetch.
- **Automatic fallback.** If `Granny.ready()` is skipped or instantiation
  fails, decode still runs (pure JS), byte-identical — the wasm path is
  purely additive behind the same API.
- **~1.3–1.4× faster texture decode in-browser.** Run it in a Worker to
  keep the main thread jank-free (a full corpus decode blocks the main
  thread ~0.6–1.1 s ; in a Worker the render loop never stalls). Pattern
  + numbers in **[docs/wasm.md](docs/wasm.md)**.

### Via CDN — no install

```html
<script type="module">
  // esm.sh honours the package's ./wasm export (single self-contained file)
  import { parseTextured, Granny } from 'https://esm.sh/granny-ro-js/wasm';
  await Granny.ready();
  const bytes = new Uint8Array(await (await fetch('model.gr2')).arrayBuffer());
  const { textures } = parseTextured(bytes);
</script>
```

Prefer jsDelivr with an explicit path? `https://cdn.jsdelivr.net/npm/granny-ro-js/dist/granny-ro.wasm.esm.js`.
For the **pure-JS** build (no `await`, no wasm) drop the `/wasm` :
`https://esm.sh/granny-ro-js`. Both require a release that ships the WASM
build (see the [changelog](CHANGELOG.md)).

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

### In-browser load — by entity

The table above is Node **decompression only**. What a web consumer actually
pays is the whole flow — parse + skeleton + mesh + **decode every texture**
(the wavelet IGC codec) — in a real browser, where instantiation, GC and the
main-thread budget only show up live. And the unit that matters isn't a lone
`.gr2` : the engine loads an **entity** — one model joined with its animation
banks by a shared asset id. So these numbers are grouped by entity and
labelled by *shape*, not by asset.

Full-entity decode, **warm-best (best of 50)**, `bench/browser/` on one Apple
Silicon (arm64) Mac — two engines, pure-JS vs the opt-in WASM texture decoder :
Brave 1.92 (Chromium 150, V8) and Firefox 152 (SpiderMonkey).

| Entity (by shape) | Size | V8 · JS | V8 · WASM | Firefox · JS | Firefox · WASM |
|---|---|---|---|---|---|
| Static textured model | ~50 KB | 14 ms | 10 ms | 24 ms | 11 ms |
| Textured model + light animation | ~55–80 KB | 14–18 ms | 10–13 ms | 23–26 ms | 11–15 ms |
| Textured model + full animation set | ~0.3 MB | 63–71 ms | 47–51 ms | 100–116 ms | 56–62 ms |

- **A fully-animated model is the worst case** — a heavy-texture model plus a
  four-clip animation set, ~0.3 MB, four-fifths of its time in the IGC texture
  decode. A static model is single-digit-to-teens ms.
- **WASM's payoff scales with how slow the engine's JS is.** On Firefox it
  nearly halves the heavy path (116 → 62 ms), closing most of the gap to V8 ;
  on V8, already fast in JS, it's ~1.35×.
- **Decode off the main thread.** The Worker axis isn't a faster kernel (same
  JIT), but decoding the corpus on the main thread stalls it **~2.6 s on V8 /
  ~4.7 s on Firefox** — in a Worker the worst main-thread hitch stays under
  25 ms, so the render loop never janks. This is the roBrowser pattern.

Reproduce with `npm run bench:browser` (stages the bundle + corpus, prints the
serve command) then open the page ; **⬇ Download JSON** exports the full
per-entity + per-file batch. Node-side equivalent (no browser) : `npm run
perf:load`.

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

## Building from source

Consuming the published package needs only **Node ≥ 20** (zero runtime
dependencies). **Building from source needs Node ≥ 24** — the dist bundler
(rolldown) imports `node:util.styleText`, which older Node (including 20)
doesn't export, so `npm run build` fails there.

```bash
npm install          # pulls the build toolchain (devDeps only — no globals)
npm run build:wasm   # AssemblyScript → src/wasm/kernels.wasm (+ inlined base64)
npm run build        # rolldown → dist/ (ESM / CJS / IIFE + rolled-up types)
npm test             # vitest — byte-exact parity + untrusted-input cap repros
```

All build tooling ships as devDependencies — AssemblyScript (WASM kernel),
rolldown (bundles), TypeScript (types), vitest (tests) — so `npm install` is
the only setup step, no global installs. Wine 9+ / qemu are needed **only**
for the optional `granny2.dll` parity re-bake (see
[docs/HOWTO.md](docs/HOWTO.md)), never to build or use the library.

## Contributing

See [docs/HOWTO.md](docs/HOWTO.md) for the dev setup, the live wine
cross-check, the multi-host re-bake matrix, and troubleshooting.
