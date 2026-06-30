# shim/prebuilt/

Prebuilt i386 PE binaries of the Win32 shims. Committed to the repo so
hosts without mingw can run the JS-port parity check without a build
step.

| Binary | Source | Purpose |
|---|---|---|
| `gr2_decompress.exe` | [../gr2_decompress.c](../gr2_decompress.c) | Re-bakes a `.gr2` with all sections decompressed via `_GrannyDecompressData@28` (Oodle0 → NoCompression) |
| `gr2_igc_export.exe` | [../gr2_igc_export.c](../gr2_igc_export.c) | Thin wrapper around `_GrannyDecompressIGCTexture@12` — feeds raw IGC bytes → RGBA8888 |

## Runtime modes

Same binary runs on three platforms — no per-host build, no per-host
binary :

| Host | Wine? | Command |
|---|---|---|
| Linux + qemu-i386 (devcontainer / Docker) | wine + qemu | `wine shim/prebuilt/gr2_igc_export.exe …` |
| macOS (Wine.app / Wine Staging from WineHQ, version 9+) | wine (built-in wow64) | `wine shim/prebuilt/gr2_igc_export.exe …` |
| Windows native | none — direct exec | `shim\prebuilt\gr2_igc_export.exe …` |

`granny2.dll` must be next to the .exe at spawn time. The bake / rebake
scripts populate `shim/runtime/` from `$RO_FOLDER/granny2.dll` (or the
`GRANNY2_DLL` override env) automatically — see `scripts/lib/platform.mjs`.

## Rebuilding

### Docker (no host mingw needed)

```sh
docker compose run --rm build-shim
```

Mounts the repo into the heavyweight image, runs the same mingw recipe
inside, writes the .exe back to `shim/prebuilt/` on the host filesystem.

### Native mingw-w64 i686

```sh
# Devcontainer / Debian / Ubuntu
sudo apt install gcc-mingw-w64-i686

# macOS
brew install mingw-w64

# Windows MSYS2
pacman -S mingw-w64-i686-gcc

# Then, from any of the above :
node scripts/build-shim.mjs
```

Canonical compile command (what `build-shim.mjs` runs) :

```sh
i686-w64-mingw32-gcc -static -O2 \
  -o shim/prebuilt/gr2_igc_export.exe \
  shim/gr2_igc_export.c
```

### MSVC (Windows alt)

The source is plain C99, no mingw extensions, so a 32-bit MSVC build
works too :

```cmd
cl.exe /O2 /Fe:shim\prebuilt\gr2_igc_export.exe shim\gr2_igc_export.c ^
  /link /MACHINE:X86 user32.lib kernel32.lib
```

## Verifying a fresh build

PE32 i386 magic check via Node (no `file` required) :

```sh
node -e '
const buf = require("node:fs").readFileSync("shim/prebuilt/gr2_igc_export.exe");
const peOff = buf.readUInt32LE(0x3c);
console.log({
  mz: "0x" + buf.readUInt16LE(0).toString(16),       // 0x5a4d
  pe: "0x" + buf.readUInt32LE(peOff).toString(16),   // 0x4550
  machine: "0x" + buf.readUInt16LE(peOff+4).toString(16), // 0x14c (i386)
  size: buf.length,
});
'
```
