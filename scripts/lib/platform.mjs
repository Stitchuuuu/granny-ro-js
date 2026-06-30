/**
 * platform.mjs — single source of truth for target detection +
 * Wine binary lookup + granny2.dll resolution + shim spawn.
 *
 * Used by bake-textures, bake-all, bake-igc-rgba, rebake, regenerate-manifest.
 *
 * Env contract (all OPTIONAL — auto-detected when absent) :
 *   RO_FOLDER       Directory containing granny2.dll (and data.grf when
 *                   the bake needs to extract .gr2 fixtures on first run)
 *   WINE_BIN        wine binary override ; skipped on win32 ; auto-detected on darwin
 *   GRANNY2_DLL     override for ${RO_FOLDER}/granny2.dll
 *   GR2_IGC_EXPORT_EXE  override for shim/prebuilt/gr2_igc_export.exe
 *   GR2_DECOMPRESS_EXE  override for shim/prebuilt/gr2_decompress.exe (set by Dockerfile)
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(__dirname, '..', '..');
export const SHIM_DIR = join(PKG_ROOT, 'shim');
export const SHIM_PREBUILT = join(SHIM_DIR, 'prebuilt');
export const SHIM_RUNTIME = join(SHIM_DIR, 'runtime');

const MACOS_WINE_CANDIDATES = [
    '/Applications/Wine Staging.app/Contents/Resources/wine/bin/wine',
    '/Applications/Wine.app/Contents/Resources/wine/bin/wine',
    '/Applications/Wine Stable.app/Contents/Resources/wine/bin/wine',
    '/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine',
    '/opt/homebrew/bin/wine',
    '/opt/homebrew/bin/wine-stable',
    '/usr/local/bin/wine',
];

/**
 * Detect the current target. JS-only paths return 'js-only' (no wine
 * needed). Wine paths split by platform so callers can pick the right
 * spawn strategy.
 */
export function getTarget() {
    if (process.platform === 'win32') return 'windows-native';
    if (process.platform === 'darwin') return 'macos-wine';
    return 'linux-wine';
}

/**
 * Find the wine binary. Throws if not found.
 * Honors WINE_BIN ; on darwin probes the standard install locations ;
 * on linux falls back to PATH ; on win32 returns null (no wine needed).
 */
export function findWine() {
    if (process.platform === 'win32') return null;

    if (process.env.WINE_BIN) {
        if (!existsSync(process.env.WINE_BIN)) {
            throw new Error(
                `WINE_BIN points at "${process.env.WINE_BIN}" but the ` +
                `file doesn't exist`
            );
        }
        return process.env.WINE_BIN;
    }

    if (process.platform === 'darwin') {
        for (const path of MACOS_WINE_CANDIDATES) {
            if (existsSync(path)) return path;
        }
        const which = spawnSync('which', ['wine'], { stdio: ['ignore', 'pipe', 'ignore'] });
        if (which.status === 0) {
            const path = which.stdout.toString().trim();
            if (path) return path;
        }
        throw new Error(
            'No wine binary found. Install Wine Staging (recommended) :\n' +
            '  https://www.winehq.org/download → macOS\n' +
            '  (drag Wine Staging.app to /Applications/)\n' +
            'or via brew : `brew install --cask --no-quarantine wine-stable`\n' +
            'or set WINE_BIN=/path/to/wine'
        );
    }

    const which = spawnSync('which', ['wine'], { stdio: ['ignore', 'pipe', 'ignore'] });
    if (which.status !== 0) {
        throw new Error(
            'wine not found on PATH. Install : `sudo apt install wine` ' +
            'or set WINE_BIN=/path/to/wine'
        );
    }
    return which.stdout.toString().trim();
}

/**
 * Resolve the source granny2.dll path :
 *   1. GRANNY2_DLL env (absolute override)
 *   2. ${RO_FOLDER}/granny2.dll
 *
 * Throws if neither resolves to an existing file.
 */
export function findGranny2Dll() {
    if (process.env.GRANNY2_DLL) {
        if (!existsSync(process.env.GRANNY2_DLL)) {
            throw new Error(
                `GRANNY2_DLL points at "${process.env.GRANNY2_DLL}" but ` +
                `the file doesn't exist`
            );
        }
        return process.env.GRANNY2_DLL;
    }
    if (!process.env.RO_FOLDER) {
        throw new Error(
            'Neither GRANNY2_DLL nor RO_FOLDER is set.\n' +
            '\n' +
            'Set ONE of :\n' +
            '  GRANNY2_DLL  Absolute path to granny2.dll.\n' +
            '  RO_FOLDER    Directory containing granny2.dll (and a\n' +
            '               data.grf archive when tests/fixtures/source/\n' +
            '               is empty — the bake extracts .gr2 fixtures\n' +
            '               from data.grf on first run, then caches them\n' +
            '               in tests/fixtures/source/).\n'
        );
    }
    const candidate = join(process.env.RO_FOLDER, 'granny2.dll');
    if (!existsSync(candidate)) {
        throw new Error(
            `granny2.dll not found at ${candidate}.\n` +
            '\n' +
            'Either :\n' +
            '  - point RO_FOLDER at a directory that contains granny2.dll,\n' +
            '  - or set GRANNY2_DLL to the absolute path of granny2.dll.\n'
        );
    }
    return candidate;
}

/**
 * Resolve the prebuilt shim .exe path :
 *   1. GR2_IGC_EXPORT_EXE env (Dockerfile sets this to /shim/...)
 *   2. shim/prebuilt/gr2_igc_export.exe (committed)
 */
export function findIgcShim() {
    if (process.env.GR2_IGC_EXPORT_EXE) {
        if (!existsSync(process.env.GR2_IGC_EXPORT_EXE)) {
            throw new Error(
                `GR2_IGC_EXPORT_EXE points at "${process.env.GR2_IGC_EXPORT_EXE}" ` +
                `but the file doesn't exist`
            );
        }
        return process.env.GR2_IGC_EXPORT_EXE;
    }
    const prebuilt = join(SHIM_PREBUILT, 'gr2_igc_export.exe');
    if (!existsSync(prebuilt)) {
        throw new Error(
            `prebuilt shim not found at ${prebuilt}. Build it with ` +
            `\`node scripts/build-shim.mjs\` or ` +
            `\`docker compose run --rm build-shim\`.`
        );
    }
    return prebuilt;
}

/**
 * Same for the section-level decompress shim.
 */
export function findDecompressShim() {
    if (process.env.GR2_DECOMPRESS_EXE) {
        if (!existsSync(process.env.GR2_DECOMPRESS_EXE)) {
            throw new Error(
                `GR2_DECOMPRESS_EXE points at "${process.env.GR2_DECOMPRESS_EXE}" ` +
                `but the file doesn't exist`
            );
        }
        return process.env.GR2_DECOMPRESS_EXE;
    }
    const prebuilt = join(SHIM_PREBUILT, 'gr2_decompress.exe');
    if (!existsSync(prebuilt)) {
        throw new Error(
            `prebuilt shim not found at ${prebuilt}. Build it with ` +
            `\`node scripts/build-shim.mjs\` or ` +
            `\`docker compose run --rm build-shim\`.`
        );
    }
    return prebuilt;
}

/**
 * Stage granny2.dll into shim/runtime/ next to a copy of the shim .exe
 * so `LoadLibrary("granny2.dll")` resolves by sibling lookup. Idempotent.
 * Returns the runtime path of the .exe (use this for spawn).
 */
export function stageShimRuntime(shimSrcExe) {
    const dll = findGranny2Dll();
    mkdirSync(SHIM_RUNTIME, { recursive: true });
    const runtimeDll = join(SHIM_RUNTIME, 'granny2.dll');
    if (!existsSync(runtimeDll) ||
        statSync(runtimeDll).mtimeMs < statSync(dll).mtimeMs) {
        copyFileSync(dll, runtimeDll);
    }
    const runtimeExe = join(SHIM_RUNTIME, basename(shimSrcExe));
    if (!existsSync(runtimeExe) ||
        statSync(runtimeExe).mtimeMs < statSync(shimSrcExe).mtimeMs) {
        copyFileSync(shimSrcExe, runtimeExe);
    }
    return runtimeExe;
}

/**
 * Pre-flight runtime check. Validates the target/host pairing before
 * we attempt to spawn the shim — surfaces a clear error message when
 * a piece of plumbing is missing, instead of a cryptic wine failure.
 *
 * Checks performed :
 *   - On Linux non-x86_64 (arm64 / aarch64) : require `qemu-i386-static`
 *     on PATH (binfmt registration is the actual runtime gate, but the
 *     binary's presence is a quick proxy).
 *   - On Linux x86_64 : just require wine.
 *   - On darwin       : require wine (Wine.app or brew). Old wine
 *                       versions < 9 may fail at runtime on the i386
 *                       PE — we surface the wine version in the error
 *                       message if we can detect it.
 *   - On win32        : nothing — direct exec works natively.
 *
 * @throws Error with a human-readable message + remediation steps
 */
export function checkRuntimeReady() {
    if (process.platform === 'win32') return;

    if (process.platform === 'linux' && process.arch !== 'x64') {
        const which = spawnSync('which', ['qemu-i386-static'], { stdio: ['ignore', 'pipe', 'ignore'] });
        if (which.status !== 0) {
            throw new Error(
                `Linux ${process.arch} host needs qemu-i386-static to run the ` +
                `i386 PE shim under wine. Install :\n` +
                `  sudo apt install qemu-user-static binfmt-support\n` +
                `Then verify binfmt registration :\n` +
                `  ls /proc/sys/fs/binfmt_misc/ | grep -i i386`
            );
        }
    }

    // findWine() throws with its own actionable message — surface it.
    findWine();
}

/**
 * Spawn the shim with the right wine prefix per platform.
 * - linux / darwin : `wine <exe> <args>` (CWD = shim runtime dir)
 * - win32          : `<exe> <args>` directly
 *
 * Calls `checkRuntimeReady()` before spawning to surface missing wine
 * or qemu-i386 with a clear error message rather than a cryptic exec
 * failure.
 *
 * Returns the spawnSync result. Always sets WINEDEBUG=-all by default.
 */
export function spawnShim(shimExe, shimArgs, options = {}) {
    const cwd = options.cwd ?? dirname(shimExe);
    const env = {
        ...process.env,
        WINEDEBUG: process.env.WINEDEBUG ?? '-all',
        ...(options.env ?? {}),
    };
    const stdio = options.stdio ?? ['ignore', 'pipe', 'pipe'];

    checkRuntimeReady();
    if (process.platform === 'win32') {
        return spawnSync(shimExe, shimArgs, { cwd, env, stdio });
    }

    const wine = findWine();
    return spawnSync(wine, [shimExe, ...shimArgs], { cwd, env, stdio });
}
