# Changelog

All notable changes to `granny-ro-js`. This project follows [SemVer](https://semver.org/).
Pre-release versions (`1.0.0-a.N`, `1.0.0-b.N`, …) are validation
milestones for the upcoming stable `1.0.0`.

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
