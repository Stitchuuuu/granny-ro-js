#!/usr/bin/env node
/**
 * build-shim.mjs — cross-compile the Win32 IGC shim from C source.
 *
 * Tries `i686-w64-mingw32-gcc` on PATH first (works in devcontainer +
 * macOS with `brew install mingw-w64` + Windows with MSYS2). Falls back
 * to printing the equivalent docker recipe if mingw isn't available.
 *
 * Idempotent : no-op when the .exe is newer than the .c source.
 *
 * Output : shim/prebuilt/gr2_igc_export.exe (i386 PE, committed to repo).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG = resolve(__dirname, '..');
const SRC = join(PKG, 'shim', 'gr2_igc_export.c');
const OUT_DIR = join(PKG, 'shim', 'prebuilt');
const OUT = join(OUT_DIR, 'gr2_igc_export.exe');
const GCC = 'i686-w64-mingw32-gcc';
const FLAGS = ['-static', '-O2'];

function log(...args) { console.log('build-shim:', ...args); }

function isUpToDate() {
    if (!existsSync(OUT)) return false;
    return statSync(OUT).mtimeMs >= statSync(SRC).mtimeMs;
}

function hasMingw() {
    const r = spawnSync(GCC, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0;
}

function printDockerFallback() {
    console.error(
        'build-shim: mingw-w64 i686 not found on PATH.\n' +
        '\n' +
        '  Native install :\n' +
        '    Debian/Ubuntu : sudo apt install gcc-mingw-w64-i686\n' +
        '    macOS         : brew install mingw-w64\n' +
        '    Windows MSYS2 : pacman -S mingw-w64-i686-gcc\n' +
        '\n' +
        '  Or rebuild via Docker (no host mingw needed) :\n' +
        '    docker compose run --rm build-shim\n'
    );
}

function main() {
    if (isUpToDate()) {
        log('up-to-date, skipping :', OUT);
        return;
    }
    if (!hasMingw()) {
        printDockerFallback();
        process.exit(1);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    log('compiling', SRC, '→', OUT);
    const r = spawnSync(GCC, [...FLAGS, '-o', OUT, SRC], { stdio: 'inherit' });
    if (r.status !== 0) {
        console.error('build-shim: compile failed, exit', r.status);
        process.exit(r.status ?? 1);
    }
    log('built', OUT);
}

main();
