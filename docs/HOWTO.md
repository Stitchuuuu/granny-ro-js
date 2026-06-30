# HOWTO — testing, baking, and the parity matrix

This page walks through the **prerequisites** and **commands** for the
three layers of the granny-ro-js parity contract :

1. **JS-only test** — fastest path, no native tooling. Tests the JS port
   against the committed content-addressed manifest. Runs anywhere Node
   runs : your host shell, a CI matrix entry, or the minimal Docker image.
2. **Live regen + test** — JS regenerates the manifest fresh, then
   verifies the JS port against it. Mostly useful when you've added
   new `.gr2` fixtures and want to populate the manifest in one shot.
3. **DLL parity re-bake** — runs the wine + shim + `granny2.dll` pipeline
   on a target host (devcontainer, macOS, Windows native) and diffs the
   wine-baked output element-by-element against the committed manifest.
   This is the "does our manifest still reflect what the DLL produces ?"
   check.

---

## How the parity contract works

Each `.gr2` is identified by the sha256 of its **bytes**, not its
filename. The committed manifest (`tests/fixtures/content-manifest.json`)
maps each .gr2 sha to a structured set of **output** sha256s :

| Category    | What's hashed                                                       |
|-------------|---------------------------------------------------------------------|
| `sections`  | Post-Oodle0 decompressed section bytes (6 sections per fixture)     |
| `textures`  | Decoded RGBA8888 pixel bytes (the final image)                      |
| `meshes`    | Structurally-extracted mesh (vertices, triangles, weights, materials) |
| `skeletons` | Structurally-extracted skeleton (bones, local + inverse-world transforms) |
| `animations`| Structurally-extracted animation tracks (transform tracks, vector tracks) |
| `materials` | Structurally-extracted materials (maps, sub-materials, parameters)  |

When `test-js` runs, it walks `tests/fixtures/source/` (or any directory
you point it at), hashes each `.gr2`, looks up the sha in the manifest,
JS-decompresses every category, and compares each output sha
**element-by-element** with the pinned value.

The shas live in the manifest as **hashes of the final decoded content** —
not the compressed input. The DLL would produce identical bytes given
the same `.gr2` input (verified per category through prior parity work).
For categories where the JS port runs the same algorithms as the DLL
(post a series of clean-room re-implementations), the JS-only path is
equivalent to running the DLL.

Filenames only appear in the manifest as a `filenameHint` for log
readability — they're never used for matching. A user with a different
iRO version who happens to have one `.gr2` with a matching sha gets
that one tested ; the rest are reported as "unknown" (not failures).

---

## Prerequisites by use case

### A. "I just want to run the JS port tests" (no native tooling)

- Node ≥ 20
- (optional) `tests/fixtures/source/` populated with `.gr2` fixtures of
  your choice. The repo's gitignore excludes `.gr2` from commits.

### B. "I want to test against my own `data.grf`"

- Node ≥ 20
- `RO_FOLDER` env pointing at your iRO ver12 client root (must contain
  `data.grf`).

### C. "I want to run the wine + DLL re-bake locally"

- Wine 9+ (recommended : Wine Staging from <https://www.winehq.org/download>)
    - macOS : Wine.app / Wine Staging.app in `/Applications/`, **or**
      `brew install --cask --no-quarantine wine-stable`
    - Linux : `sudo apt install wine`
    - Windows : not needed (native exec)
- `RO_FOLDER` env pointing at iRO ver12 client root (must contain
  `data.grf` + `granny2.dll`)
- `tests/fixtures/source/` populated (or use the devcontainer which
  pre-extracts a default set from your `RO_FOLDER`)

### D. "I want to test inside Docker without installing Node on the host"

- Docker / Docker Desktop
- Optional `.env` with `RO_FOLDER` for the heavyweight images
- See [Running via Docker](#running-via-docker) below

---

## Commands by use case

### Test the JS port (use case A or B)

```sh
npm install
npm test
```

Runs vitest. The new `tests/integration/manifest.test.js` invokes the
JS test driver against the committed manifest and asserts per-element
sha equality. ~2 s, no wine, no DLL.

For a more verbose driver-level report :

```sh
npm run test:js          # human-readable per-fixture summary
npm run test:js -- --json    # machine-readable JSON
npm run test:js -- --source /path/to/your/.gr2/dir
npm run test:js -- --manifest /path/to/other/manifest.json
```

### Live wine cross-check (use case C, ~3 min cold)

```sh
npm run test:live
```

Chains :

1. `npm run bake` (wine + `gr2_decompress.exe` on sections, no Python
   oracle — wine output IS the truth, validated post-port against the
   committed content manifest),
2. `npm run bake:textures` (wine + `gr2_igc_export.exe` on IGC textures),
3. Merges the wine outputs with JS structural extracts (meshes /
   skeletons / animations / materials) into
   `tests/fixtures/manifest.live.json` (content-addressed v2 schema),
4. Runs `test-js` against that manifest.

Green = JS port reproduces `granny2.dll` output byte-for-byte AT THIS
MOMENT. Use after a DLL version bump, when bootstrapping a manifest
from scratch on a new host, or when contributing fixtures.

### Manifest coverage probe (use case B)

```sh
RO_FOLDER=/path/to/iRO npm run coverage:gr2
```

Scans `tests/fixtures/source/` and (when `RO_FOLDER` is set) your
`data.grf` for `.gr2` entries. Reports how many shas match the
committed manifest vs. how many are "unknown".

### Add new fixtures to the manifest (use case A/B)

1. Drop the new `.gr2` files into `tests/fixtures/source/`.
2. Run :
   ```sh
   npm run regenerate-manifest
   ```
3. Commit the updated `tests/fixtures/content-manifest.json`.

Note : the new entries inherit the JS port's output as the canonical
value. To cross-check those values against the DLL, run a re-bake on
your host (use case C).

### DLL parity re-bake (use case C)

#### macOS host

```sh
RO_FOLDER="$HOME/Games/iRO" ./scripts/rebake-host-macos.sh
npm run verify:rebake -- --target macos-host
```

The first command stages `granny2.dll` next to the shim binary, runs
wine + `gr2_igc_export.exe`, and writes the result to
`tests/fixtures/rebake-fresh/macos-host/manifest.json`. The second
diffs that against the committed manifest sha-by-sha.

#### Linux container (devcontainer or the heavyweight Docker image)

```sh
npm run rebake:container
npm run verify:rebake -- --target container
```

Same flow, but inside the `wine 8 + qemu-i386-static` container. The
container path has a known IGC divergence vs the canonical macOS path —
this is **expected** (page-size + i386 emul drift) and the manifest
treats container output as "sanity, not byte-exact".

#### Windows native

```powershell
$env:RO_FOLDER = "C:\Games\iRO"
.\scripts\rebake-host-windows.ps1
npm run verify:rebake -- --target windows-host
```

No wine — the shim runs as native Win32 PE.

#### Matrix view

```sh
npm run test:matrix
```

Prints a per-target ✓ / ⊘ / ✗ table : `test:js` (always), then each
`rebake:<target>` whose `rebake-fresh/<target>/manifest.json` is present.

---

## Running via Docker

Three services are wired in `docker-compose.yml` :

| Service             | Image               | Purpose                                            |
|---------------------|---------------------|----------------------------------------------------|
| `test-js`           | `Dockerfile.js-only` (~80 MB, alpine + node) | JS-only contract. Day-to-day iteration. |
| `build-shim`        | `Dockerfile` (heavy) | One-shot mingw-w64 cross-compile to host fs.       |
| `rebake-container`  | `Dockerfile` (heavy) | wine + qemu + shim re-bake against the manifest.   |
| `test`              | `Dockerfile` (heavy) | Catch-all : runs `TEST_COMMAND` from `.env`, default `npm test`. |

```sh
# JS-only test, fastest cold start
docker compose run --rm test-js

# Rebuild the prebuilt shim (no host mingw needed)
docker compose run --rm build-shim

# Container re-bake (needs RO_FOLDER mounted)
RO_FOLDER=/path/to/iRO docker compose run --rm rebake-container

# Catch-all (legacy / heavyweight pipeline)
RO_FOLDER=/path/to/iRO TEST_COMMAND='npm run bake && npm run test:live' \
  docker compose run --rm test
```

---

## Rebuilding the prebuilt shim from source

The cross-compiled `shim/prebuilt/gr2_igc_export.exe` is committed for
reproducibility. To rebuild it :

```sh
# Native mingw-w64 (Linux + macOS + MSYS2)
npm run build:shim

# Or via Docker (no host mingw needed)
docker compose run --rm build-shim
```

Build instructions per host live in
[shim/prebuilt/README.md](../shim/prebuilt/README.md).

---

## Troubleshooting

### `wine: command not found`

Either install wine (see [Prerequisites C](#c-i-want-to-run-the-wine--dll-re-bake-locally))
or set `WINE_BIN` explicitly :

```sh
WINE_BIN="/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine" npm run rebake:macos-host
```

### `granny2.dll not found at <path>`

Either set `RO_FOLDER` so `${RO_FOLDER}/granny2.dll` is your DLL path,
or set `GRANNY2_DLL` directly to the absolute path :

```sh
GRANNY2_DLL=/path/to/granny2.dll npm run rebake:macos-host
```

### `prebuilt shim not found at shim/prebuilt/gr2_igc_export.exe`

Build it once :

```sh
npm run build:shim    # or: docker compose run --rm build-shim
```

The binary is committed to the repo, so a fresh clone shouldn't see
this — but if you've removed `shim/prebuilt/` for any reason, this
restores it.

### `test:js` reports "unknown" fixtures

Some of your `.gr2` files in `tests/fixtures/source/` don't have an
entry in the committed manifest. This is informational, not a failure —
the harness still passes any fixtures that ARE in the manifest. To add
them, run :

```sh
npm run regenerate-manifest
```

then commit the updated `content-manifest.json`.
