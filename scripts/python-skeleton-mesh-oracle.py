#!/usr/bin/env python3
"""Run Rasetsuu/blendergranny's clean-room skeleton + mesh extractors
against each .gr2 fixture and emit a normalized JSON snapshot the JS
comparator can diff against (S6 of the granny-pipeline rollout).

Mirrors scripts/python-typetree-oracle.py shape but targets the
extract_skeletons + extract_mesh_geometries entry points. The snapshot
covers exactly the fields GrannyModelLive.test.js compares :

  - skeletons : per-skeleton bone count + per-bone (name, parent_index,
    transform.flags + first-3 position floats, first 4 floats of
    inverse_world_transform)
  - meshes    : per-mesh (name, vertex_count, index_count, vertex_stride,
    first 6 indices, first triangle's 3 positions, bone-binding names,
    material texture-file names)

Animation-only fixtures resolve to empty `skeletons` + `meshes` arrays.

Usage : python3 python-skeleton-mesh-oracle.py <fixture.gr2> [...]
        → one JSON object per line.
"""
from __future__ import annotations

import json
import sys
import os
from pathlib import Path

BLENDERGRANNY_PATH = Path(os.environ.get("BLENDERGRANNY_PATH") or str(Path.home() / ".cache" / "granny-ro-js" / "blendergranny"))
if not BLENDERGRANNY_PATH.exists():
    sys.exit(
        f"FATAL: {BLENDERGRANNY_PATH} missing — "
        "re-clone via : git clone --depth=1 --branch=main "
        f"https://github.com/Rasetsuu/blendergranny {BLENDERGRANNY_PATH}"
    )
sys.path.insert(0, str(BLENDERGRANNY_PATH))

from io_scene_gr2.gr2.file import read_gr2  # noqa: E402
from io_scene_gr2.gr2.fixup import load_sections  # noqa: E402
from io_scene_gr2.gr2.geometry import extract_mesh_geometries  # noqa: E402
from io_scene_gr2.gr2.skeleton import extract_skeletons  # noqa: E402


def _bone_snapshot(bone) -> dict:
    transform = bone.transform
    return {
        "name": bone.name,
        "parent_index": bone.parent_index,
        "flags": transform.flags,
        "position": list(transform.position),
        # First 4 floats of the InverseWorldTransform — full 16 is overkill for
        # a diff while still detecting matrix-layout regressions.
        "inverse_world_first4": list(bone.inverse_world_transform[:4]),
    }


def _skeleton_snapshot(skeleton) -> dict:
    return {
        "name": skeleton.name,
        "bone_count": len(skeleton.bones),
        "lod_type": skeleton.lod_type,
        "bones": [_bone_snapshot(bone) for bone in skeleton.bones],
    }


def _mesh_snapshot(mesh) -> dict:
    first_triangle = mesh.triangles[0] if mesh.triangles else None
    first_triangle_positions = None
    if first_triangle and len(mesh.positions) >= max(first_triangle) + 1:
        first_triangle_positions = [list(mesh.positions[i]) for i in first_triangle]
    return {
        "name": mesh.name,
        "vertex_count": mesh.vertex_count,
        "index_count": mesh.index_count,
        "vertex_stride": mesh.vertex_stride,
        "first_six_indices": list(mesh.indices[:6]),
        "first_triangle_positions": first_triangle_positions,
        "bone_binding_names": [binding.name for binding in mesh.bone_bindings],
        "material_texture_files": [material.texture_file for material in mesh.materials],
    }


def snapshot(path: Path) -> dict:
    gr2 = read_gr2(path)
    loaded = load_sections(gr2)
    skeletons = extract_skeletons(loaded)
    meshes = extract_mesh_geometries(loaded)
    return {
        "file": path.name,
        "skeletons": [_skeleton_snapshot(skeleton) for skeleton in skeletons],
        "meshes": [_mesh_snapshot(mesh) for mesh in meshes],
    }


def main(argv: list[str]) -> int:
    if not argv:
        sys.exit("usage: python-skeleton-mesh-oracle.py <fixture.gr2> [...]")
    for path_str in argv:
        path = Path(path_str)
        snap = snapshot(path)
        sys.stdout.write(json.dumps(snap) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
