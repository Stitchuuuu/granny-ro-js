/**
 * discover-gr2.mjs — content-addressed enumeration of .gr2 fixtures.
 *
 * Discovers .gr2 files from a source directory (and, optionally, a GRF
 * archive) and yields sha256-keyed records. The harness uses these as
 * the lookup key into the content-addressed manifest, so fixtures
 * self-identify by content — no hardcoded filenames anywhere.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRF_INSPECT = resolve(dirname(fileURLToPath(import.meta.url)), 'grf-inspect.mjs');

/**
 * Hex sha256 of a buffer.
 */
export function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

/**
 * Walk a directory non-recursively for `.gr2` files. Returns an array
 * of records sorted by name for deterministic output. Each record :
 *   { sha256, name, sourcePath, sizeBytes, bytes }
 *
 * `bytes` is the full file buffer (already read — fixtures are small,
 * a few hundred KB each, never enough to OOM).
 */
export function walkSourceDir(sourceDir) {
    const dir = resolve(sourceDir);
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir)
        .filter((name) => /\.gr2$/i.test(name))
        .filter((name) => statSync(join(dir, name)).isFile())
        .sort();
    return entries.map((name) => {
        const sourcePath = join(dir, name);
        const bytes = readFileSync(sourcePath);
        return {
            sha256: sha256Hex(bytes),
            name,
            sourcePath,
            sizeBytes: bytes.length,
            bytes,
        };
    });
}

/** Recursively collect `.gr2` paths under `dir` (grf extracts into subdirs). */
function walkDirRecursiveGr2(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...walkDirRecursiveGr2(full));
        else if (/\.gr2$/i.test(name)) out.push(full);
    }
    return out;
}

/**
 * Bulk-extract every `.gr2` from a GRF archive to a temp dir (via
 * `grf-inspect.mjs --extract-all --ext gr2`) and return the same record shape
 * as {@link walkSourceDir} — `{ sha256, name, sourcePath, sizeBytes, bytes }`
 * — plus a `cleanup()` the caller MUST invoke when done to remove the temp
 * dir. On extraction failure returns `{ records: [], cleanup }` (temp already
 * removed). Only `.gr2` are extracted, so the footprint stays bounded to the
 * client's model set (textures / sprites / maps are other extensions).
 *
 * @param {string} grfPath — path to the `.grf` archive.
 * @returns {{ records: ReturnType<typeof walkSourceDir>, cleanup: () => void }}
 */
export function walkGrf(grfPath) {
    const dir = mkdtempSync(join(tmpdir(), 'gr2-grf-'));
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    const r = spawnSync(
        'node',
        [GRF_INSPECT, grfPath, '--extract-all', dir, '--ext', 'gr2'],
        { stdio: ['ignore', 'inherit', 'inherit'] },
    );
    if (r.status !== 0) {
        cleanup();
        return { records: [], cleanup: () => {} };
    }
    const records = walkDirRecursiveGr2(dir)
        .sort()
        .map((full) => {
            const bytes = readFileSync(full);
            return {
                sha256: sha256Hex(bytes),
                name: full.slice(dir.length + 1),
                sourcePath: full,
                sizeBytes: bytes.length,
                bytes,
            };
        });
    return { records, cleanup };
}

/**
 * Same shape, scoped to a single explicit path (used by rebake / regen
 * drivers when the user passes `--fixture <path>`).
 */
export function loadOne(fixturePath) {
    const bytes = readFileSync(fixturePath);
    return {
        sha256: sha256Hex(bytes),
        name: fixturePath.split(/[\\/]/).pop(),
        sourcePath: fixturePath,
        sizeBytes: bytes.length,
        bytes,
    };
}
