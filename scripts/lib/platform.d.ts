/**
 * Platform helpers : target detection, wine binary lookup, granny2.dll
 * resolution, shim spawn.
 */

import type { SpawnSyncReturns } from 'node:child_process';

/**
 * Absolute path to the granny-ro-js package root (resolved at load time).
 */
export const PKG_ROOT: string;

/**
 * Absolute path to `shim/` (committed sources + prebuilt binaries live here).
 */
export const SHIM_DIR: string;

/**
 * Absolute path to `shim/prebuilt/` (committed cross-compiled .exe binaries).
 */
export const SHIM_PREBUILT: string;

/**
 * Absolute path to `shim/runtime/` (gitignored ; bake scripts populate
 * with granny2.dll + a runtime copy of the .exe so `LoadLibrary` can
 * resolve the DLL by sibling lookup).
 */
export const SHIM_RUNTIME: string;

/**
 * Discriminated target string. Stamped into the content manifest's
 * `sourceBaseline.target` so we know which environment produced the
 * pinned shas.
 */
export type Target =
    | 'windows-native'   // Windows direct exec (no wine)
    | 'macos-wine'       // macOS Wine.app / Wine Staging.app / brew wine
    | 'linux-wine';      // Linux + wine (native or inside Docker — qemu
                         // is just an i386-on-aarch64 detail when cross-arch)

/**
 * Detect the current rebake target.
 */
export function getTarget(): Target;

/**
 * Find the wine binary. Throws if not found.
 *
 * - Honors `WINE_BIN` env override.
 * - On darwin, probes the standard `/Applications/Wine*.app/...` and
 *   homebrew install paths in order, falling back to PATH.
 * - On linux, falls back to `which wine` on PATH.
 * - On win32, returns `null` (no wine needed — shim runs as native Win32 PE).
 *
 * @returns absolute path to the wine binary, or `null` on win32
 * @throws Error if wine is not installed / not found on a wine-requiring platform
 */
export function findWine(): string | null;

/**
 * Resolve the source granny2.dll path :
 *
 *   1. `GRANNY2_DLL` env (absolute override)
 *   2. `${RO_FOLDER}/granny2.dll`
 *
 * @throws Error if neither resolves to an existing file
 */
export function findGranny2Dll(): string;

/**
 * Resolve the prebuilt IGC shim .exe path :
 *
 *   1. `GR2_IGC_EXPORT_EXE` env (Dockerfile sets this)
 *   2. `shim/prebuilt/gr2_igc_export.exe` (committed)
 */
export function findIgcShim(): string;

/**
 * Resolve the prebuilt gr2_decompress shim .exe path (section-level
 * decompression). Same fallback chain as `findIgcShim` but for the
 * `GR2_DECOMPRESS_EXE` env.
 */
export function findDecompressShim(): string;

/**
 * Stage granny2.dll into `shim/runtime/` next to a copy of the shim .exe
 * so `LoadLibrary("granny2.dll")` resolves by sibling lookup at runtime.
 * Idempotent : skips copy when target is up-to-date with source.
 *
 * @param shimSrcExe path to the committed `shim/prebuilt/<name>.exe`
 * @returns runtime path of the .exe (under `shim/runtime/`)
 */
export function stageShimRuntime(shimSrcExe: string): string;

/**
 * Pre-flight runtime check. Validates the target/host pairing before
 * spawning the shim — surfaces a clear error message when a piece of
 * plumbing is missing, instead of a cryptic wine failure.
 *
 * Checks performed :
 * - Linux non-x86_64 : require `qemu-i386-static` on PATH (binfmt
 *   registration is the actual runtime gate, but binary presence is a
 *   quick proxy).
 * - Linux x86_64     : require wine.
 * - darwin           : require wine (Wine.app or brew).
 * - win32            : nothing (direct exec works natively).
 *
 * @throws Error with a human-readable message + remediation steps
 */
export function checkRuntimeReady(): void;

/**
 * Spawn options forwarded to `spawnSync` ; CWD defaults to the .exe's
 * runtime directory.
 */
export interface SpawnShimOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: Parameters<typeof import('node:child_process').spawnSync>[2]['stdio'];
}

/**
 * Spawn the shim with the right wine prefix per platform.
 *
 * - linux / darwin : `<wine> <exe> <args>` (CWD = shim runtime dir)
 * - win32          : `<exe> <args>` directly
 *
 * Always sets `WINEDEBUG=-all` by default.
 */
export function spawnShim(
    shimExe: string,
    shimArgs: readonly string[],
    options?: SpawnShimOptions,
): SpawnSyncReturns<Buffer>;
