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
const SHIM_DIR = join(PKG, 'shim');
const OUT_DIR = join(SHIM_DIR, 'prebuilt');
const GCC = 'i686-w64-mingw32-gcc';
const FLAGS = ['-static', '-O2'];

/**
 * The Win32 shims that ship in the prebuilt directory. Both are needed
 * by the wine bake pipeline (section-level decompress + IGC texture
 * export). Build all of them in one shot — if mingw is on PATH, this
 * is sub-second.
 */
const SHIMS = [
    { src: 'gr2_decompress.c', out: 'gr2_decompress.exe' },
    { src: 'gr2_igc_export.c', out: 'gr2_igc_export.exe' },
];

function log(...args) { console.log('build-shim:', ...args); }

function isUpToDate(srcPath, outPath) {
    if (!existsSync(outPath)) return false;
    return statSync(outPath).mtimeMs >= statSync(srcPath).mtimeMs;
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
    const needsBuild = SHIMS.filter((s) => !isUpToDate(
        join(SHIM_DIR, s.src),
        join(OUT_DIR, s.out),
    ));
    if (needsBuild.length === 0) {
        log('all shims up-to-date, skipping');
        return;
    }
    if (!hasMingw()) {
        printDockerFallback();
        process.exit(1);
    }
    mkdirSync(OUT_DIR, { recursive: true });
    for (const s of needsBuild) {
        const srcPath = join(SHIM_DIR, s.src);
        const outPath = join(OUT_DIR, s.out);
        log('compiling', srcPath, '→', outPath);
        const r = spawnSync(GCC, [...FLAGS, '-o', outPath, srcPath], { stdio: 'inherit' });
        if (r.status !== 0) {
            console.error('build-shim: compile failed, exit', r.status);
            process.exit(r.status ?? 1);
        }
    }
    log('built', needsBuild.length, 'shim(s)');
}

main();
