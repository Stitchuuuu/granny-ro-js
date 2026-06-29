// Integration test : JS port output vs the dual-oracle manifest.
//
// Reads tests/fixtures/manifest.json (produced by `npm run bake`) which
// carries per-section SHA-256s that are validated against BOTH oracles
// (Rasetsuu/blendergranny clean-room Python + canonical RAD granny2.dll
// under Wine) at bake-time. A single assertion here = three-oracle
// convergence at run-time.
//
// Skips entirely (with a clear message) if the manifest hasn't been baked
// yet. The unit tests still run.

import { describe, it, expect, beforeAll } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseGR2File } from '../../src/GrannyFile.js';
import { decompressSection } from '../../src/Granny.js';

const MANIFEST_URL = new URL('../fixtures/manifest.json', import.meta.url);
const MANIFEST_PATH = fileURLToPath(MANIFEST_URL);

/** Hex-encoded SHA-256 of a buffer. */
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Surface the first byte-offset where two `Uint8Array`s diverge so we
 * can pinpoint the regression rather than just say « hashes differ ».
 * Returns `null` when the two arrays are byte-identical.
 *
 * @returns {null | { offset: number, a: number, b: number, lenDiff?: true }}
 */
function firstDiffOffset(a, b) {
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
        if (a[i] !== b[i]) {
            return {
                offset: i,
                a: a[i],
                b: b[i],
            };
        }
    }
    if (a.length !== b.length) {
        return {
            offset: len,
            a: a[len],
            b: b[len],
            lenDiff: true,
        };
    }
    return null;
}

const haveManifest = existsSync(MANIFEST_PATH);
const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [] };

describe.skipIf(!haveManifest)('GrannyOodle0 — dual-oracle parity', () => {
    it(`manifest sanity : ${manifest.fixture_count} fixtures`, () => {
        expect(manifest.fixtures.length).toBeGreaterThan(0);
        expect(manifest.fixtures.length).toBe(manifest.fixture_count);
    });

    for (const fixture of manifest.fixtures) {
        describe(fixture.name, () => {
            let file;
            beforeAll(() => {
                const sourceURL = new URL(
                    `../fixtures/source/${fixture.name}`,
                    import.meta.url,
                );
                const raw = readFileSync(sourceURL);
                file = parseGR2File(raw);
            });

            for (const expected of fixture.sections) {
                it(`section ${expected.index} (${expected.compression}) — ${expected.decompressed_size} bytes`, () => {
                    const section = file.sections[expected.index];
                    const compressed = file.sectionBytes(section);
                    const decompressed = decompressSection(section, compressed);
                    expect(decompressed.length).toBe(expected.decompressed_size);
                    const got = sha256(decompressed);
                    if (got !== expected.decompressed_sha256) {
                        // Recompute oracle bytes to surface the byte-offset of divergence.
                        // We don't have oracle bytes embedded, but we can show what we did
                        // produce vs. the expected SHA.
                        const summary = [
                            `expected sha256 = ${expected.decompressed_sha256}`,
                            `       got      = ${got}`,
                            `(${fixture.name} section ${expected.index} ${expected.compression}, len=${decompressed.length})`,
                        ].join('\n');
                        throw new Error(`oodle0 mismatch :\n${summary}`);
                    }
                    expect(got).toBe(expected.decompressed_sha256);
                });
            }
        });
    }
});

if (!haveManifest) {
    describe('GrannyOodle0 parity', () => {
        it.skip(
            `manifest not baked yet — run \`npm run bake\` to populate ${MANIFEST_PATH}`,
            () => {
            },
        );
    });
}

// Keep firstDiffOffset exported for ad-hoc debugging (not used in the test
// itself because we don't load oracle bytes — manifest only has SHA-256s).
export { firstDiffOffset };
