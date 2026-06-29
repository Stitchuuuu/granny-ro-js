// Integration test : JS Granny.parseModel() skeleton + mesh extraction vs
// Rasetsuu/blendergranny (Python clean-room reference) field-by-field.
//
// Mirrors GrannyParseLive.test.js : env-gated by GRANNY_LIVE_ORACLE=1,
// skips if Python or blendergranny isn't importable, batches all 21
// fixtures through one Python subprocess for sub-second wall-clock.

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseModel } from '../../src/Granny.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const ORACLE_SCRIPT = resolve(PKG_ROOT, 'scripts/python-skeleton-mesh-oracle.py');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');

const liveMode = process.env.GRANNY_LIVE_ORACLE === '1';
const haveManifest = existsSync(MANIFEST_PATH);
const haveOracle = existsSync(ORACLE_SCRIPT);

const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [], fixture_count: 0 };

/** Spawn python3 once for the whole corpus and parse the JSON-Lines output. */
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

/**
 * Build the JS-side snapshot in the same shape the Python oracle emits.
 * Float comparisons keep 6 significant digits (round-trip safe for f32
 * stored as f64) to dodge IEEE-754 drift between Python `struct.unpack`
 * and JS `DataView.getFloat32`.
 */
function roundFloat(value) {
    return Number(value.toFixed(6));
}

function jsSnapshot(name, buffer) {
    const { skeletons, meshes } = parseModel(buffer);
    return {
        file: name,
        skeletons: skeletons.map((skeleton) => ({
            name: skeleton.name,
            bone_count: skeleton.bones.length,
            lod_type: skeleton.lodType,
            bones: skeleton.bones.map((bone) => ({
                name: bone.name,
                parent_index: bone.parentIndex,
                flags: bone.transform.flags,
                position: bone.transform.position.map(roundFloat),
                inverse_world_first4: bone.inverseWorldTransform.slice(0, 4).map(roundFloat),
            })),
        })),
        meshes: meshes.map((mesh) => {
            const firstTriangle = mesh.indices.length >= 3
                ? [mesh.indices[0], mesh.indices[1], mesh.indices[2]]
                : null;
            const firstTrianglePositions = firstTriangle && mesh.positions.length > Math.max(...firstTriangle)
                ? firstTriangle.map((i) => mesh.positions[i].map(roundFloat))
                : null;
            return {
                name: mesh.name,
                vertex_count: mesh.vertexCount,
                index_count: mesh.indexCount,
                vertex_stride: mesh.vertexStride,
                first_six_indices: mesh.indices.slice(0, 6),
                first_triangle_positions: firstTrianglePositions,
                bone_binding_names: mesh.boneBindings.map((b) => b.name),
                material_texture_files: mesh.materials.map((m) => m.textureFile),
            };
        }),
    };
}

/** Normalize the Python oracle snapshot's float fields to the same precision. */
function normalizePythonSnapshot(snap) {
    return {
        file: snap.file,
        skeletons: snap.skeletons.map((skeleton) => ({
            name: skeleton.name,
            bone_count: skeleton.bone_count,
            lod_type: skeleton.lod_type,
            bones: skeleton.bones.map((bone) => ({
                name: bone.name,
                parent_index: bone.parent_index,
                flags: bone.flags,
                position: bone.position.map(roundFloat),
                inverse_world_first4: bone.inverse_world_first4.map(roundFloat),
            })),
        })),
        meshes: snap.meshes.map((mesh) => ({
            name: mesh.name,
            vertex_count: mesh.vertex_count,
            index_count: mesh.index_count,
            vertex_stride: mesh.vertex_stride,
            first_six_indices: mesh.first_six_indices,
            first_triangle_positions: mesh.first_triangle_positions
                ? mesh.first_triangle_positions.map((pos) => pos.map(roundFloat))
                : null,
            bone_binding_names: mesh.bone_binding_names,
            material_texture_files: mesh.material_texture_files,
        })),
    };
}

/** Probe whether the Python oracle is runnable. Degrade-to-skip when not. */
function probeOracle() {
    if (!haveOracle) return { ok: false, reason: 'oracle script missing' };
    const proc = spawnSync('python3', [
        '-c',
        'import sys; sys.path.insert(0, "/tmp/granny-audit/blendergranny"); from io_scene_gr2.gr2.skeleton import extract_skeletons; from io_scene_gr2.gr2.geometry import extract_mesh_geometries',
    ], {
        encoding: 'utf8',
    });
    if (proc.status !== 0) {
        return { ok: false, reason: `blendergranny import failed : ${(proc.stderr || '').trim()}` };
    }
    return { ok: true };
}

const probe = liveMode && haveManifest ? probeOracle() : { ok: false, reason: 'live mode disabled' };

describe.skipIf(!liveMode || !haveManifest || !probe.ok)(
    `Granny.parseModel — Python blendergranny oracle parity (${liveMode ? probe.reason ?? 'enabled' : 'GRANNY_LIVE_ORACLE not set'})`,
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
                const pyRaw = pyByName[fixture.name];
                expect(pyRaw, `oracle missing snapshot for ${fixture.name}`).toBeDefined();
                const buf = readFileSync(resolve(FIXTURE_DIR, fixture.name));
                const js = jsSnapshot(fixture.name, buf);
                const py = normalizePythonSnapshot(pyRaw);
                expect(js).toEqual(py);
            });
        }
    },
);
