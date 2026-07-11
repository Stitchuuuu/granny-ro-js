# Contributing to granny-ro-js

Thanks for considering a contribution. This guide covers the dev
setup, the three test layers, and the release flow.

This file lives on GitHub only — it's excluded from the npm tarball
via the `package.json` `files:` whitelist.

## Quick start

```bash
git clone https://github.com/stitchuuuu/granny-ro-js
cd granny-ro-js
docker compose run test
```

That's it. The Dockerfile bakes in everything (Node 20, Wine, mingw,
Python 3, a pinned `Rasetsuu/blendergranny` checkout, a pre-built Wine
shim) so the **80 bake-free unit tests** pass on any machine —
amd64 or aarch64 — with **zero host setup**.

Native (without Docker) :

```bash
npm install
npm test               # 80 bake-free unit + dispatcher tests (~700 ms)
npm run typecheck      # tsc --noEmit
```

That covers the `npm test` path. The full **live-oracle path** (629
tests : JS vs Python clean-room vs RAD `granny2.dll`) needs the user's
iRO ver12 client and a Wine + mingw toolchain — see below.

## The three test layers

| Command | Tests | What it validates | Prereqs |
|---|---|---|---|
| `npm test` | ~80 pass | Oodle0 codec unit + dispatcher + synthetic math + type-tree helpers + synthetic FK pose | none |
| `npm run bake` | n/a | Pre-bakes 21 iRO ver12 fixtures via Wine shim + Python oracle, writes `tests/fixtures/manifest.json` | `RO_FOLDER` + Wine + mingw + Python |
| `npm run test:live` | ~629 pass | JS vs Wine vs Python triple-oracle on every section of every fixture | `npm run bake` must succeed first |

A test that requires the manifest uses `describe.skipIf(!haveManifest)`,
so running `npm test` without baking yields « 14 skipped, 0 failed » —
expected and harmless.

**Running the content-manifest sha parity** (the byte-exact decode gate
inside `npm test`) needs the actual `.gr2` on disk. Supply them either
way — the driver picks automatically :

- drop `.gr2` into `tests/fixtures/source/` (gitignored), **or**
- set `RO_FOLDER=/path/to/iRO_client` (the dir with `data.grf`) and the
  `.gr2` are auto-extracted from it when `source/` is empty :
  `RO_FOLDER=… npm test`.

Matching is by sha256 (never filename), so a different client version
just reports its `.gr2` as "unknown", never a failure. When neither
source is present the gate prints a loud ⚠️ warning and skips. Full
detail : [docs/HOWTO.md](docs/HOWTO.md#where-the-gr2-come-from-two-sources).

## Setting up the live-oracle path

You need :

1. **An iRO ver12 client** — the directory containing `data.grf` AND
   `granny2.dll`. Both are needed : the GRF supplies the 21 `.gr2`
   fixtures, the DLL is the canonical RAD Oodle0 decompressor (third
   validation oracle).
2. **Wine** (32-bit) + **mingw-w64** (i686 target) to build and run
   the shim that calls `granny2.dll`.
3. **Python 3.11+** to run the `Rasetsuu/blendergranny` clean-room
   decoder (second validation oracle).

### Option A — Docker (recommended)

The Dockerfile ships all toolchains pinned. Just point it at your iRO
client :

```bash
cp .env.example .env
$EDITOR .env           # set RO_FOLDER=/path/to/your/iRO_client
docker compose run -e TEST_COMMAND='npm run setup:oracle && npm run bake && npm run test:live' test
```

Or set `TEST_COMMAND=npm run setup:oracle && npm run bake && npm run test:live`
in `.env` and just `docker compose run test`.

### Option B — Native (your own toolchain)

```bash
# 1. Install Wine + mingw + Python on the host.
#    Debian/Ubuntu : apt install wine wine32 gcc-mingw-w64-i686 python3
#    macOS         : brew install wine-stable mingw-w64 python@3.11

# 2. Build the Wine shim from the vendored C source.
i686-w64-mingw32-gcc -O2 -o shim/gr2_decompress.exe shim/gr2_decompress.c

# 3. Export env vars (or put them in .env + use a loader of your choice).
export RO_FOLDER=/path/to/your/iRO_client
export GR2_DECOMPRESS_EXE=$(pwd)/shim/gr2_decompress.exe
export BLENDERGRANNY_PATH=$HOME/.cache/granny-ro-js/blendergranny

# 4. Run the full live-oracle path.
npm run setup:oracle   # clones blendergranny (one-shot, idempotent)
npm run bake           # extracts .gr2 from data.grf + bakes via shim + Python
npm run test:live      # 629 tests, triple-oracle byte parity
```

`npm run bake` symlinks `${RO_FOLDER}/granny2.dll` next to
`gr2_decompress.exe` automatically (Wine resolves DLLs by bare name
from the .exe's directory).

## Submitting changes

- Branch off `main`. Open a PR against `main`.
- Keep PRs scoped — one concern per PR. A new codec, a perf
  optimization, a Granny format dialect — each is its own PR.
- Run `npm test && npm run typecheck` before pushing. CI does the
  same on the bake-free path ; live-oracle isn't in CI (the iRO data
  isn't shippable to GitHub Actions), so test it locally if you
  touched the codec, the type-tree walker, or any pose math.
- Match the existing code style (no formatter enforced — just don't
  diverge wildly).
- Add unit tests for new behaviour. Live-oracle tests come for free
  if your change is in the codec / parser path.

### Adding a new Granny format dialect

`granny-ro-js` was built for iRO ver12 (format 6, LE, 32-bit, Oodle0/
NoCompression). Other Granny dialects exist in the wild (format 2.8+,
Oodle1, Bitknit, big-endian, 64-bit pointers). PRs adding support are
welcome, but please :

- Include a small fixture set (≥ 3 files, ≥ 1000 vertices total) from
  the source game — not the same iRO corpus we already have.
- Add a new oracle path if `Rasetsuu/blendergranny` doesn't cover the
  dialect. The `bake-all.mjs` cross-check **must** stay byte-exact for
  any section the lib claims to decode.
- Bump the major version : a new dialect changes the public
  « validated against » contract.

## Releasing (maintainers)

Pre-1.0 :
```bash
# Bump version + tag.
npm version 1.0.0-a.2 -m 'chore: alpha %s'

# Push tag + branch.
git push origin main --follow-tags

# Publish (--tag alpha keeps `npm install granny-ro-js` (no @alpha)
# returning nothing until a real 1.0.0 lands).
npm publish --tag alpha
```

Graduating to stable (`1.0.0`) :
- After a downstream consumer successfully renders a real fixture
  end-to-end with this lib.
- `npm version 1.0.0 -m 'chore: stable %s'` then `npm publish` (no
  `--tag` ⇒ `latest`).

## Code of conduct

Be kind. Niche game-engine RE is a small world ; let's keep it
friendly.
