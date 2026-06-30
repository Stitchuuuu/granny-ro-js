/**
 * Content-addressed enumeration of .gr2 fixtures.
 *
 * Discovers .gr2 files from a source directory and yields sha256-keyed
 * records. The harness uses these as the lookup key into the content-
 * addressed manifest, so fixtures self-identify by content — no
 * hardcoded filenames anywhere.
 */

/**
 * A single discovered fixture.
 */
export interface Gr2Record {
    /** Hex sha256 of the file content (the lookup key into the manifest). */
    sha256: string;
    /** Basename of the file (logging only — never used for matching). */
    name: string;
    /** Absolute path to the file on disk. */
    sourcePath: string;
    /** File size in bytes. */
    sizeBytes: number;
    /** Full file buffer (eagerly read — fixtures are small). */
    bytes: Buffer;
}

/**
 * Hex sha256 of an arbitrary buffer.
 */
export function sha256Hex(buf: Buffer | Uint8Array): string;

/**
 * Walk a directory non-recursively for `.gr2` files. Returns records
 * sorted by filename for deterministic output.
 *
 * Missing directories return an empty array (not an error) so the
 * `tests/fixtures/source/` walk degrades gracefully when fixtures
 * haven't been extracted yet.
 *
 * @param sourceDir directory to walk (absolute or relative to CWD)
 */
export function walkSourceDir(sourceDir: string): Gr2Record[];

/**
 * Load a single explicit `.gr2` path into the same record shape.
 * Used by rebake / regen drivers when the user passes `--fixture <path>`.
 *
 * @param fixturePath absolute path to a `.gr2` file
 */
export function loadOne(fixturePath: string): Gr2Record;
