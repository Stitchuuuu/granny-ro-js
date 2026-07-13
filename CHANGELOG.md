# Changelog

All notable changes to `granny-ro-js`. This project follows [SemVer](https://semver.org/).
Pre-release versions (`1.0.0-a.N`, `1.0.0-b.N`, …) are validation
milestones for the upcoming stable `1.0.0`.

## 1.5.0 — 2026-07-13

**Parse a `.gr2` once, get everything.** A single additive entry point for
consumers that need mesh + animation + texture + model in one shot — one
Oodle0 decompress instead of three.

### Added

- **`parseAll(buffer, options)`** — single-pass pipeline. One
  `parseGR2File`→`loadGR2`, then every extractor on that one decompressed graph,
  returning the superset of `parseTextured` and `parseAnimated` plus
  `models: ModelInfo[]` (each with `initialPlacement`). Purely additive —
  `parseTextured` / `parseAnimated` are unchanged. A caller that previously ran
  all three passes (`parseTextured` + `parseAnimated` +
  `extractModels(loadGR2(parseGR2File(u8)))`) — the roBrowser `GR2Loader`
  pattern — now pays the expensive decompress **once**.
  - **~2.1× faster than the three-pass load** on the 21-fixture corpus in the
    browser (WASM build, Chromium 150 / V8, Apple Silicon): 415 → 197 ms on the
    main thread (2.10×), 413 → 190 ms in a Worker (2.18×). Model loads (guardian
    / Emperium / flag / treasure box) drop ~40–50% ; animation-only loads ~63%.
  - **`parseAll` costs only ~7% more than a lone `parseTextured`** (197 vs
    184 ms corpus warm-best) yet returns textures **and** animations **and**
    models — the extra extractors are cheap once the graph is resident ; the
    3× cost was the repeated decompress.
  - New `ParseAllResult` / `ParseAllOptions` types, surfaced in
    `dist/granny-ro.d.ts`.
- **Node bench** `tests/perf/GrannyParseAll.bench.js` (`npm run bench`) —
  `load3x` vs `load1x` on a model + anim fixture (≈ 2× in Node/JS).
- **Browser bench** `bench/browser/` — new `wasm-esm · load3x` / `load1x`
  axes (main + worker) and a `load1xVs3x` ratio in the verdict card + exported
  payload.

## 1.4.1 — 2026-07-12

### Fixed

- **License copyright holder reconciled.** `LICENSE` named a different
  identity than `package.json` `author`; both now read
  `Stitchuuuu <stitchuuuu@icloud.com>`. No code, license type (MIT), or
  third-party attribution blocks changed.

## 1.4.0 — 2026-07-12

**`poseAt()` is now float-faithful to the real `granny2.dll`** across the whole
21-fixture corpus, with a wine-free pose regression guard baked into the content
manifest.

### Fixed

- **Quaternion normalize now matches `granny2.dll`.** The B-spline quaternion
  curve sampler renormalizes each blend with the DLL's fast one-Newton-step
  `q *= (3 − |q|²) / 2` (`granny2.dll fcn.1000a3e0`) instead of an exact `1/√`,
  and the per-bone local matrix is built straight from that quaternion with no
  second renormalize (matching `fcn.100189a0`). Both only diverged where a
  B-spline blend drifts off-unit near non-unit control points — worst on fast
  degree-2 curves (a death animation's forearm), where the raw local orientation
  was off by up to 3.2e-3 and the skinning composite by up to 0.145. `poseAt()`
  is now within **1.9e-6** (local transforms) and **1.8e-5** (skinning matrices)
  of the real DLL on all 21 fixtures — strict `< 1e-4`, no per-fixture bounds.

### Added

- **DLL pose oracle (strict).** The wine-gated `worldpose-oracle` suite asserts
  `initialPlacement`, `poseAt().localTransforms` and `poseAt().skinningMatrices`
  against the real `granny2.dll` across all 21 fixtures at the 40 Hz client tick.
- **`poses` sha in the content manifest.** `buildEntry` bakes the sha256 of
  poseAt()'s per-bone local orientation + skinning matrices over the 40 Hz grid,
  so the JS-only manifest test catches a pose regression **without wine or the
  DLL**. Plus synthetic, asset-free golden tests reproducing the divergent
  quaternion path so the fix stays guarded in public CI.
- **Three test flows.** `test:unit` (wine-free, asset-free — what public CI
  runs), `test:js` (JS/SHA content parity, incl. the new `poses` category),
  `test:dll` (the wine DLL-parity suite). `test:js` prints a 3-column category
  grid by default, with a `--compact` one-liner.

## 1.3.1 — 2026-07-12

**Docs + bench tooling. No code or decode change** — the parser, codecs and
built `dist/` are byte-identical to `1.3.0` ; the published tarball differs
only in `README.md`.

- **README** — new "In-browser load — by entity" section. Real-browser
  full-entity decode timings (a model joined with its animation banks, grouped
  and labelled by shape rather than asset name), across two engines
  (Brave / Chromium 150 · V8 and Firefox 152 · SpiderMonkey), pure-JS vs the
  opt-in WASM texture decoder, warm-best of 50. Replaces the interim Node-only
  per-asset table and surfaces two findings : the WASM payoff scales with how
  slow the engine's JS is (~1.35× on V8, ~1.8× on Firefox), and decoding on the
  main thread stalls it for seconds where a Worker keeps the hitch under 25 ms.
- **`bench/browser`** — the browser bench now rolls its per-file rows up into
  entity groups (model + its animation banks, derived from the filename
  convention) and renders an anonymized-by-shape group table alongside the
  existing per-`.gr2` table, both carried in the exported batch JSON. Dev
  tooling only — `bench/` is not part of the npm tarball.

## 1.3.0 — 2026-07-11

**Untrusted-input hardening.** Bounds every file-controlled allocation and
recursion in the `.gr2` parse path against resource-exhaustion denial-of-service,
in **both** the pure-JS and the opt-in WASM builds. The parser was already
memory-safe (no RCE, no out-of-bounds disclosure) ; the gap was that a tiny
crafted `.gr2` could drive a multi-GB allocation or unbounded recursion and
OOM / hang the process. Matters only when the parser is fed attacker-controlled
input (e.g. a web tool accepting uploads) — trusted GRF assets are low-risk — but
the caps are cheap and belong in a published library. **Decode output is
byte-identical to `1.2.0`** (same content manifest, 21/21 fixtures) with no
measurable perf regression. No breaking changes.

### Allocation caps

- **Oodle0 `expanded_size`** — an absolute 256 MiB ceiling + a 1024× compressed-
  ratio cross-check before the decompression buffer is allocated (a ~40-byte
  section could previously request ~2 GB).
- **IGC texture `width × height`** — a 16 Mpix (4096²) ceiling + an
  `ImageData`-length cross-check before the plane allocations (mirrors the raw
  path ; `Width = Height = 16384` previously asked for ~2.7 GB).
- **Arith alphabet fields** — the Oodle0 model and the IGC arith coder now reject
  an over-large alphabet header (a 23-bit / 16-bit file field) before sizing
  their tables.

### Recursion guards

- **`objectStorageSize`** memoizes storage size per sub-type, collapsing a DAG of
  `INLINE` members from `Bᴰ` re-walks to `O(D)` (a `< 128 KB` file could
  otherwise hang).
- **`parseObject`** gained a depth cap (`MAX_INLINE_DEPTH = 64`) + a cycle guard,
  so a self-referential or over-deep `INLINE` type throws instead of overflowing
  the stack.

### WASM-build parity

- The opt-in `granny-ro-js/wasm` build previously re-read the IGC arith alphabet
  size inside the WASM kernel, bypassing the pure-JS cap. It is now bounded
  kernel-side at the model-open, so the WASM path enforces the same limit.

### Fail mode

- Every cap breach raises a **typed, catch-friendly error**
  (`DecompressionError` / `GrannyParseError` / a descriptive texture error) —
  never a bare `RangeError` from an oversized `new TypedArray`, a stack overflow,
  a WASM trap, or a silent truncation. Bounds are **generous** (well above any
  real RO asset) : no legit file trips a cap. Regression-tested by
  `tests/unit/DosCaps.test.js` (forged-input repros, each throwing cleanly within
  a small time/memory budget).

### Breaking changes

None. Legit `.gr2` files parse and decode exactly as in `1.2.0`.

## 1.2.0 — 2026-07-11

Opt-in **WebAssembly texture decode**. The Bink-family wavelet decoder — the
one CPU-hot inner loop — ships as a WASM module behind the existing
`Granny.ready()` seam, exposed as a new `granny-ro-js/wasm` entry. The default
build is unchanged (pure JS, synchronous, zero deps) and stays the mandatory
byte-exact fallback. No breaking changes.

### `granny-ro-js/wasm` — new opt-in build

- Same named exports as `.`, plus one `await Granny.ready()` before the first
  decode (WASM instantiation is async). Everything else — parse, Oodle0, mesh,
  skeleton, animation — stays pure JS; **only the IGC texture decode runs in
  WASM** (the one tight numeric loop; the rest is parse / object-graph work
  where the JS JIT already wins).
- The whole per-texture decode (range coder + 4× inverse-wavelet + YUV→RGB) is
  **one JS→WASM crossing** — the planes stay resident in linear memory across
  their wavelet passes, no per-kernel boundary copy.
- **Single self-contained file** : the `.wasm` is inlined (base64), so
  `granny-ro-js/wasm` is one ESM module — bundler, `<script type="module">`,
  userscript, or CDN with a single fetch. No separate `.wasm` asset to resolve.
- **Mandatory JS fallback** : skip `Granny.ready()` or let instantiation fail,
  and decode still produces identical pixels in pure JS.
- Built from AssemblyScript (`npm run build:wasm`) ; the prebuilt `.wasm` is
  committed, so `npm run build` needs no wasm toolchain.

### Performance

- **Browser : ~1.37× main-thread, ~1.28× in a Worker** on the 20-`.gr2` corpus
  (`parseTextured` end-to-end). Decoded off-thread in a Worker, the main-thread
  stall drops from ~0.6–1.1 s to ~9 ms — no render hitch.
- **Node : ~1.21×** (V8's JIT narrows the gap the browser shows).
- Measured via the `bench/browser/` harness (JS/WASM × main/worker axes).

### Validation

- **17/17 IGC textures byte-exact** end-to-end : WASM RGBA sha === pure-JS RGBA
  sha === pinned manifest sha, per texture.
- Per-kernel differential gates (arithmetic call-by-call, `planeDecode`
  per-plane, `iDWT2D` per-pass) assert WASM === JS at each stage.
- Cross-checked against the real `granny2.dll` (Wine shim) on an out-of-corpus
  texture : **byte-identical where the DLL decodes**, and the anti-hang guard is
  confirmed correct — the DLL itself fails on the inputs the guard refuses.

### Documentation

- New [docs/wasm.md](docs/wasm.md) — full WASM how-to (usage, CDN, Worker
  pattern, numbers, single-file rationale) — plus a README quick-start
  contrasting the JS and WASM entries.

### Breaking changes

None. The default `.` entry is untouched (pure JS, synchronous, zero deps). The
WASM path is purely additive behind `granny-ro-js/wasm`.

## 1.1.0 — 2026-07-10

Distribution + performance pass. Ships a built `dist/` for every JS consumption
vector — single-file / code-split, ESM / CJS / IIFE, browser / Node — instead of
raw source, plus a 2× faster texture decoder. Decode output is byte-identical to
`1.0.0` (same content manifest).

### Performance

Profile-driven optimization of the IGC texture codec (the ~85%-of-model-load
cost). Byte-exact after every commit — 17/17 IGC textures against the content
manifest, guarded by a call-by-call arithmetic differential.

- **IGC texture decode : 2.00× faster** — 226.74 ms → 113.30 ms summed across
  the 6 model fixtures.
- **Full model load : 1.74× faster** — 265.2 ms → 152.5 ms (parse, already
  optimal, now dominates a larger share : model `tex %` fell 85.0% → 74.3%).
- Two structural wins : pooled the `iDWT` ring buffers into module-scoped pools
  (kills per-group allocation churn) and dropped `BigInt` for `f64` in the hot
  arithmetic multiply sites (provably exact — `range·scale < 2⁴⁵`).
- Animation packs unchanged (no IGC path — Oodle0 decompression was already tuned).

Full ledger — what landed, what was tried and reverted, and why — in
[docs/perf-baseline.md](docs/perf-baseline.md).

### Public API additions

- **`await Granny.ready()`** — idempotent async init seam. Resolves immediately
  today (pure JS, nothing to instantiate) ; a future WASM-accelerated build
  awaits kernel compilation here. Await once at startup so opting into that
  build later needs no code change ; decode calls stay synchronous.
- **`await loadTextureCodec()`** — ensures the IGC texture decoder is loaded.
  A no-op in the default build (decoder inlined) ; in the code-split build it
  dynamic-imports the IGC chunk. Idempotent.
- **`extractModels(loaded, options)`** — decodes the GR2 `Model` struct and
  surfaces `root.Models` as a typed array, alongside `extractSkeletons` /
  `extractMeshes` / `extractMaterials`.

### Distribution

- **`npm run build`** (`scripts/build-dist.mjs`, rolldown) produces:
  - `dist/granny-ro.esm.js` — single-file ESM, the default `import`.
    Self-contained (zero runtime deps) → loads directly via
    `<script type="module">` and version-pinned / dynamic CDNs.
  - `dist/granny-ro.cjs` — single-file CJS for Node `require()`.
  - `dist/granny-ro.global.js` — IIFE global (`window.GrannyRO`) for a classic
    `<script src>`.
  - `dist/granny-ro.split.esm.js` + `dist/granny-ro-igc.js` — code-split ESM
    (`granny-ro-js/split`) : the ~2 000-line IGC decoder is a lazily-loaded
    chunk, so an anim-only consumer never fetches it.
  - `dist/granny-ro.d.ts` (+ per-sub-entry) — rolled-up types.
- **Conditional `exports`** : `.` (esm/cjs), `./split`, `./file`, `./oodle0`,
  `./typetree`. `browser`/`jsdelivr`/`unpkg` fields point the bare CDN URL at
  the ESM. `files` whitelist ships `dist/` only (no tests / scripts / shim /
  fixtures) — verified by `npm publish --dry-run`.
- Bundle-size table in [docs/dist-size.md](docs/dist-size.md) (min + brotli).

### Validation & tooling

- **World-pose DLL oracle** : the pose / placement runtime is now verified
  float-for-float against a Win32 `gr2_worldpose` oracle built on the real
  `granny2.dll`, on top of the existing Python clean-room cross-check.
- **Full-load benches** : per-commit compare tooling (`npm run perf` /
  `perf:profile`) plus a real-browser full-load harness (main-thread vs worker
  axes) for measuring parse + decode end-to-end.
- **Types** : inline JSDoc is now the single source of truth for the public
  API, rolled up into the shipped `.d.ts`.
- **CI** bumped to GitHub Actions v5 on Node 22.

### Breaking changes

None for the default entry — `parseModel` / `parseTextured` decode synchronously
exactly as in `1.0.0` (the new `loadTextureCodec()` warmup is required only for
the opt-in `granny-ro-js/split` build).

## 1.0.0 — 2026-06-30

Stable release. Byte-exact parity across 21 fixtures vs `granny2.dll`,
locked by a content-addressed test manifest.

### Highlights

- **Content-addressed parity contract** : [`tests/fixtures/content-manifest.json`](tests/fixtures/content-manifest.json)
  maps each `.gr2` sha256 → per-element output sha256s (sections,
  textures, meshes, skeletons, animations, materials). `npm test`
  walks fixtures, hashes them, compares JS port output element-by-
  element against the pinned values. No wine, no DLL required.
- **JS-only Docker image** (~80 MB, alpine + node) via
  `Dockerfile.js-only` — fastest path for day-to-day iteration.
- **`npm run rebake`** refreshes the content manifest from wine + DLL
  output on the current host. Auto-detects the target (`macos-wine` /
  `linux-wine` / `windows-native`) and stamps `sourceBaseline.target`
  in the manifest. `git diff` afterwards reveals any drift vs the
  canonical pin. Same prebuilt i386 PE shim
  (`shim/prebuilt/gr2_igc_export.exe`) runs under Linux + Wine + qemu,
  macOS Wine 9+ (built-in wow64), or Windows native exec. Rebuildable
  via `npm run build:shim` or `docker compose run --rm build-shim`.
- **Comprehensive docs** : [docs/HOWTO.md](docs/HOWTO.md) covers
  prerequisites, commands, host vs Docker variants, troubleshooting.

### Public API additions

- `extractMaterials(loaded, options)` — surfaces `root.Materials` as a
  typed array.

### Breaking changes

None vs `1.0.0-a.5`. The public API surface is unchanged.

## 1.0.0-a.1 — 2026-06-28

Initial public release as a pre-release alpha. Will graduate to a
plain `1.0.0` once consumer-side integration confirms a renderable
end-to-end pipeline.

### Feature surface at `1.0.0-a.1`

- **Format support** : Granny3D 6 (little-endian, 32-bit pointers).
  Modern dialects (Oodle1, Bitknit, big-endian, 64-bit, format 2.8+)
  are out of scope.
- **Validation** : 21 corpus fixtures pass byte-exact parity vs
  RAD `granny2.dll` AND a Python clean-room decoder.
- **Perf** : 15.5 MB/s sustained Oodle0 decompression, ~54.9× a
  Python reference (see [docs/perf-baseline.md](docs/perf-baseline.md)).
- **API surface** (4 entry points + lower-level helpers — see [README](README.md)) :
  - `parse(buffer)` — file → typetree → root object graph.
  - `parseModel(buffer)` — `parse` + skeleton + mesh.
  - `parseAnimated(buffer)` — `parseModel` + animations.
  - `poseAt(parsed, animIdx, t)` — per-bone world + skinning matrices
    (GPU-ready Float32Array).
