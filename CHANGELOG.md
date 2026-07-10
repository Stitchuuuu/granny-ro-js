# Changelog

All notable changes to `granny-ro-js`. This project follows [SemVer](https://semver.org/).
Pre-release versions (`1.0.0-a.N`, `1.0.0-b.N`, …) are validation
milestones for the upcoming stable `1.0.0`.

## 1.1.0 — 2026-07-10

Distribution pass. Ships a built `dist/` for every JS consumption vector —
single-file / code-split, ESM / CJS / IIFE, browser / Node — instead of raw
source. Decode output is byte-identical to `1.0.0` (same content manifest).

### Public API additions

- **`await Granny.ready()`** — idempotent async init seam. Resolves immediately
  today (pure JS, nothing to instantiate) ; a future WASM-accelerated build
  awaits kernel compilation here. Await once at startup so opting into that
  build later needs no code change ; decode calls stay synchronous.
- **`await loadTextureCodec()`** — ensures the IGC texture decoder is loaded.
  A no-op in the default build (decoder inlined) ; in the code-split build it
  dynamic-imports the IGC chunk. Idempotent.

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
