// Integration test : JS Granny.parse() output vs Rasetsuu/blendergranny
// (Python clean-room reference) field-by-field.
//
// Env-gated by GRANNY_LIVE_ORACLE=1 (matches Oodle0Live.test.js convention).
// Skips entirely when blendergranny isn't importable, so CI without the dep
// degrades to unit + parity coverage only.
//
// Runs the oracle once for the whole corpus (one Python subprocess for all
// 21 fixtures) to keep wall-clock under a second.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parse } from '../../src/Granny.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const ORACLE_SCRIPT = resolve(PKG_ROOT, 'scripts/python-typetree-oracle.py');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');

const ARRAY_TYPES = new Set([
    'array_of_references',
    'reference_to_array',
    'reference_to_variant_array',
]);

const liveMode = process.env.GRANNY_LIVE_ORACLE === '1';
const haveManifest = existsSync(MANIFEST_PATH);
const haveOracle = existsSync(ORACLE_SCRIPT);

const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [], fixture_count: 0 };

/** Spawn python3 once per fixture and parse the JSON-Lines output. */
function runOracle(fixturePaths) {
    const proc = spawnSync('python3', [ORACLE_SCRIPT, ...fixturePaths], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
    });
    if (proc.status !== 0) {
        return { ok: false, error: proc.stderr || proc.stdout, snapshots: null };
    }
    const lines = proc.stdout.split('\n').filter((l) => l.trim().length > 0);
    const snapshots = {};
    for (const line of lines) {
        const obj = JSON.parse(line);
        snapshots[obj.file] = obj;
    }
    return { ok: true, error: null, snapshots };
}

/** Build the JS-side snapshot in the same shape the Python oracle emits. */
function jsSnapshot(name, buffer) {
    const { typeTree, root } = parse(buffer);
    const arrayCounts = {};
    for (const key in root) {
        const field = root[key];
        if (ARRAY_TYPES.has(field.type) && typeof field.count === 'number') {
            arrayCounts[key] = field.count;
        }
    }
    return {
        file: name,
        typeTreeMemberCount: typeTree.length,
        typeTreeMemberNames: typeTree.map((m) => m.name),
        rootKeys: Object.keys(root),
        arrayCounts,
    };
}

/**
 * Probe whether the Python oracle is runnable. We don't want to fail
 * the suite if Python or blendergranny isn't installed — degrade to skip.
 */
function probeOracle() {
    if (!haveOracle) return { ok: false, reason: 'oracle script missing' };
    const proc = spawnSync('python3', ['-c', 'import sys; sys.path.insert(0, "/tmp/granny-audit/blendergranny"); from io_scene_gr2.gr2.types import parse_type_definition_array'], {
        encoding: 'utf8',
    });
    if (proc.status !== 0) {
        return { ok: false, reason: `blendergranny import failed : ${(proc.stderr || '').trim()}` };
    }
    return { ok: true };
}

const probe = liveMode && haveManifest ? probeOracle() : { ok: false, reason: 'live mode disabled' };

describe.skipIf(!liveMode || !haveManifest || !probe.ok)(
    `Granny.parse — Python blendergranny oracle parity (${liveMode ? probe.reason ?? 'enabled' : 'GRANNY_LIVE_ORACLE not set'})`,
    () => {
        /** @type {Record<string, any>} */
        let pyByName;
        beforeAll(() => {
            const paths = manifest.fixtures.map((f) => resolve(FIXTURE_DIR, f.name));
            const result = runOracle(paths);
            if (!result.ok) {
                throw new Error(`Python oracle failed : ${result.error}`);
            }
            pyByName = result.snapshots;
        });

        for (const fixture of manifest.fixtures) {
            it(`${fixture.name} — JS vs Python field-by-field`, () => {
                const py = pyByName[fixture.name];
                expect(py, `oracle missing snapshot for ${fixture.name}`).toBeDefined();
                const buf = readFileSync(resolve(FIXTURE_DIR, fixture.name));
                const js = jsSnapshot(fixture.name, buf);
                // typeTreeMemberCount + names
                expect(js.typeTreeMemberCount).toBe(py.typeTreeMemberCount);
                expect(js.typeTreeMemberNames).toEqual(py.typeTreeMemberNames);
                // Root keys (same order — parseObject walks tree in declared order)
                expect(js.rootKeys).toEqual(py.rootKeys);
                // Array counts (per-key)
                expect(js.arrayCounts).toEqual(py.arrayCounts);
            });
        }
    },
);
