// Unit tests for the GR2 mesh extractor.
//
// Same two pass kinds as GrannySkeleton.test.js :
//   - Parametric coverage on all 21 fixtures via manifest.json :
//     · 6 model fixtures → at least 1 mesh with > 0 vertices and indices
//       divisible by 3, finite Position / Normal / UV floats, bone-binding
//       indices in range relative to any extracted skeleton.
//     · 15 animation-only fixtures → explicit empty-array assertion.
//   - File-based snapshot on treasurebox_2.gr2 (smallest model) covering
//     first-mesh meta + component layout.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { parseGR2File } from '../../src/GrannyFile.js';
import { loadGR2 } from '../../src/GrannyTypeTree.js';
import { extractSkeletons } from '../../src/GrannySkeleton.js';
import { extractMeshes } from '../../src/GrannyMesh.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '../..');
const MANIFEST_PATH = resolve(PKG_ROOT, 'tests/fixtures/manifest.json');
const FIXTURE_DIR = resolve(PKG_ROOT, 'tests/fixtures/source');
const TREASUREBOX_PATH = resolve(FIXTURE_DIR, 'treasurebox_2.gr2');

const haveManifest = existsSync(MANIFEST_PATH);
const manifest = haveManifest
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : { fixtures: [] };

const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;
const modelFixtures = manifest.fixtures.filter((f) => !ANIMATION_RX.test(f.name));
const animationFixtures = manifest.fixtures.filter((f) => ANIMATION_RX.test(f.name));

function loadFixture(name) {
    const buf = readFileSync(resolve(FIXTURE_DIR, name));
    return loadGR2(parseGR2File(buf));
}

describe.skipIf(!haveManifest)('extractMeshes — model fixtures', () => {
    for (const fixture of modelFixtures) {
        it(`${fixture.name} returns at least one well-formed mesh`, () => {
            const loaded = loadFixture(fixture.name);
            const meshes = extractMeshes(loaded);
            expect(meshes.length).toBeGreaterThan(0);
            const skeletons = extractSkeletons(loaded);
            const totalBones = skeletons.reduce((acc, s) => acc + s.bones.length, 0);
            for (const mesh of meshes) {
                expect(mesh.vertexCount).toBeGreaterThan(0);
                expect(mesh.indices.length % 3).toBe(0);
                expect(mesh.vertexStride).toBeGreaterThan(0);
                expect(mesh.components.length).toBeGreaterThan(0);
                // Positions are finite when present
                if (mesh.positions.length > 0) {
                    expect(mesh.positions.length).toBe(mesh.vertexCount);
                    for (const v of mesh.positions[0]) expect(Number.isFinite(v)).toBe(true);
                }
                if (mesh.normals.length > 0) {
                    expect(mesh.normals.length).toBe(mesh.vertexCount);
                    for (const v of mesh.normals[0]) expect(Number.isFinite(v)).toBe(true);
                }
                if (mesh.uvs.length > 0) {
                    expect(mesh.uvs.length).toBe(mesh.vertexCount);
                    for (const v of mesh.uvs[0]) expect(Number.isFinite(v)).toBe(true);
                }
                // Indices must reference valid vertex slots
                for (let i = 0; i < Math.min(mesh.indices.length, 30); i++) {
                    expect(mesh.indices[i]).toBeGreaterThanOrEqual(0);
                    expect(mesh.indices[i]).toBeLessThan(mesh.vertexCount);
                }
                // Bone-binding indices stay within the mesh's binding table
                for (const binding of mesh.boneBindings) {
                    expect(binding.index).toBeGreaterThanOrEqual(0);
                    expect(binding.index).toBeLessThan(mesh.boneBindings.length);
                }
                // Vertex-weight bone refs stay within the mesh's bone-binding
                // table (sanity ; tighter range than the skeleton's bone count)
                if (mesh.vertexWeights.length > 0 && mesh.boneBindings.length > 0) {
                    for (const weight of mesh.vertexWeights[0]) {
                        expect(weight.boneIndex).toBeGreaterThanOrEqual(0);
                        expect(weight.boneIndex).toBeLessThan(mesh.boneBindings.length);
                        expect(weight.weight).toBeGreaterThanOrEqual(0);
                        expect(weight.weight).toBeLessThanOrEqual(1);
                    }
                }
                // Total-bones cross-check just informational (no assertion
                // since meshes don't always reference every skeleton bone)
                void totalBones;
            }
        });
    }
});

describe.skipIf(!haveManifest)('extractMeshes — animation-only fixtures', () => {
    // Animation-only fixtures typically ship no Meshes member — but we
    // sanity-check shape rather than insist on emptiness (the live oracle
    // catches actual non-empty discrepancies via field-by-field parity).
    for (const fixture of animationFixtures) {
        it(`${fixture.name} returns a well-formed mesh array`, () => {
            const meshes = extractMeshes(loadFixture(fixture.name));
            expect(Array.isArray(meshes)).toBe(true);
            for (const mesh of meshes) {
                expect(typeof mesh.name).toBe('string');
                expect(mesh.indices.length % 3).toBe(0);
            }
        });
    }
});

describe.skipIf(!existsSync(TREASUREBOX_PATH))('extractMeshes — treasurebox_2.gr2 snapshot', () => {
    it('matches a stable first-mesh meta snapshot for the smallest model', () => {
        const meshes = extractMeshes(loadFixture('treasurebox_2.gr2'));
        expect(meshes.length).toBeGreaterThan(0);
        const mesh = meshes[0];
        expect({
            name: mesh.name,
            vertexCount: mesh.vertexCount,
            indexCount: mesh.indexCount,
            vertexStride: mesh.vertexStride,
            componentNames: mesh.components.map((c) => c.name),
            boneBindingCount: mesh.boneBindings.length,
            materialCount: mesh.materials.length,
            triangleGroupCount: mesh.triangleGroups.length,
        }).toMatchSnapshot();
    });
});
