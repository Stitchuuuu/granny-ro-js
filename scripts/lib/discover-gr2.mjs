/**
 * discover-gr2.mjs — content-addressed enumeration of .gr2 fixtures.
 *
 * Discovers .gr2 files from a source directory (and, optionally, a GRF
 * archive) and yields sha256-keyed records. The harness uses these as
 * the lookup key into the content-addressed manifest, so fixtures
 * self-identify by content — no hardcoded filenames anywhere.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

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
