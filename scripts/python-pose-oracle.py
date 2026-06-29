#!/usr/bin/env python3
"""Independent pose composer used as the live-oracle ground truth for
`GrannyPose.test.js`. Loads each fixture via Rasetsuu/blendergranny,
then composes forward kinematics + skinning on top — blendergranny
provides the parsed bones + curves, this script does the linear algebra
in pure Python (the devcontainer doesn't ship numpy and the bone counts
are small enough that 4×4 matmul in lists costs <50 ms per fixture).

Convention (matches GrannyPose.js exactly) :
  - storage  : column-major 4×4 matrices serialized as 16-float lists
               (`M[col*4+row]` indexing).
  - vector   : column-vector convention (v' = M @ v).
  - TRS      : Mlocal = T @ R @ S (scale-shear applied first).
  - quat     : (x, y, z, w), normalized defensively.
  - IWT      : on-disk 16 floats reinterpreted as column-major directly
               (no transpose — locked by the bind-pose Mskin invariant
               smoke test in GrannyPose.test.js).

Each invocation accepts a sequence of `model:animation:t` triples where
each triple emits one JSON-line snapshot :

    treasurebox_2.gr2:2_dead.gr2:1.665 → {model: "...", ..., bones: [...]}

`animation` may be `-` to request the bind pose (no animation driver).
`t` is a float in seconds. Skeleton always comes from the model fixture.

Usage : python3 python-pose-oracle.py <fixture_dir> <triple> [<triple> ...]
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

BLENDERGRANNY_PATH = Path("/tmp/granny-audit/blendergranny")
if not BLENDERGRANNY_PATH.exists():
    sys.exit(
        f"FATAL: {BLENDERGRANNY_PATH} missing — "
        "re-clone via : git clone --depth=1 --branch=main "
        f"https://github.com/Rasetsuu/blendergranny {BLENDERGRANNY_PATH}"
    )
sys.path.insert(0, str(BLENDERGRANNY_PATH))

from io_scene_gr2.gr2.file import read_gr2  # noqa: E402
from io_scene_gr2.gr2.fixup import load_sections  # noqa: E402
from io_scene_gr2.gr2.skeleton import extract_skeletons  # noqa: E402
from io_scene_gr2.gr2.animation import (  # noqa: E402
    extract_animation_set,
    _evaluate_curve,
)


# Column-major 4×4 matrices are stored as 16-element lists. The layout
# is `M[col*4+row]`, identical to Float32Array(16) in GrannyPose.js so
# the JS comparator can do an elementwise diff without conversion.

def _identity_mat4() -> list[float]:
    return [
        1.0, 0.0, 0.0, 0.0,
        0.0, 1.0, 0.0, 0.0,
        0.0, 0.0, 1.0, 0.0,
        0.0, 0.0, 0.0, 1.0,
    ]


def _matmul_cm(a: list[float], b: list[float]) -> list[float]:
    """Column-major 4×4 multiply : returns `a @ b`."""
    out = [0.0] * 16
    for col in range(4):
        b0 = b[col * 4 + 0]
        b1 = b[col * 4 + 1]
        b2 = b[col * 4 + 2]
        b3 = b[col * 4 + 3]
        for row in range(4):
            out[col * 4 + row] = (
                a[0 * 4 + row] * b0
                + a[1 * 4 + row] * b1
                + a[2 * 4 + row] * b2
                + a[3 * 4 + row] * b3
            )
    return out


def _quat_to_local_matrix(
    position: tuple[float, float, float],
    orientation: tuple[float, float, float, float],
    scale_shear: tuple[float, ...],
) -> list[float]:
    """Column-major `Mlocal = T @ R @ S`. Matches GrannyPose.composeLocalMatrix."""
    x, y, z, w = orientation
    length_sq = x * x + y * y + z * z + w * w
    if length_sq > 0.0:
        inv = 1.0 / math.sqrt(length_sq)
        x *= inv
        y *= inv
        z *= inv
        w *= inv
    else:
        x, y, z, w = 0.0, 0.0, 0.0, 1.0
    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z

    r00 = 1 - 2 * (yy + zz)
    r01 = 2 * (xy - wz)
    r02 = 2 * (xz + wy)
    r10 = 2 * (xy + wz)
    r11 = 1 - 2 * (xx + zz)
    r12 = 2 * (yz - wx)
    r20 = 2 * (xz - wy)
    r21 = 2 * (yz + wx)
    r22 = 1 - 2 * (xx + yy)

    s00, s01, s02 = scale_shear[0], scale_shear[1], scale_shear[2]
    s10, s11, s12 = scale_shear[3], scale_shear[4], scale_shear[5]
    s20, s21, s22 = scale_shear[6], scale_shear[7], scale_shear[8]

    m00 = r00 * s00 + r01 * s10 + r02 * s20
    m01 = r00 * s01 + r01 * s11 + r02 * s21
    m02 = r00 * s02 + r01 * s12 + r02 * s22
    m10 = r10 * s00 + r11 * s10 + r12 * s20
    m11 = r10 * s01 + r11 * s11 + r12 * s21
    m12 = r10 * s02 + r11 * s12 + r12 * s22
    m20 = r20 * s00 + r21 * s10 + r22 * s20
    m21 = r20 * s01 + r21 * s11 + r22 * s21
    m22 = r20 * s02 + r21 * s12 + r22 * s22

    px, py, pz = position[0], position[1], position[2]
    return [
        m00, m10, m20, 0.0,   # col 0
        m01, m11, m21, 0.0,   # col 1
        m02, m12, m22, 0.0,   # col 2
        px, py, pz, 1.0,      # col 3
    ]


def _iwt_as_column_major(values: tuple[float, ...]) -> list[float]:
    """Reinterpret the 16 on-disk IWT floats as column-major 4×4. No
    transpose — locked by the bind-pose Mskin invariant smoke test."""
    if len(values) != 16:
        return _identity_mat4()
    return [float(v) for v in values]


def _animation_track_map(animation_set, sample_t: float) -> dict[str, dict[str, list[float] | None]]:
    """Flatten every transform-track across every track-group of the
    first animation in `animation_set`. Mirrors `evaluateAnimation` in
    GrannyAnimation.js (which the JS test pipeline also calls via
    `Granny.poseAt`)."""
    out: dict[str, dict[str, list[float] | None]] = {}
    if not animation_set.animations:
        return out
    animation = animation_set.animations[0]
    used_groups = set(animation.track_group_names)
    for group in animation_set.track_groups:
        if group.name not in used_groups:
            continue
        for track in group.transform_tracks:
            entry: dict[str, list[float] | None] = {
                "position": None,
                "orientation": None,
                "scale_shear": None,
            }
            if track.position is not None:
                values = _evaluate_curve(track.position, sample_t)
                entry["position"] = [float(v) for v in values] if values else None
            if track.orientation is not None:
                values = _evaluate_curve(track.orientation, sample_t)
                entry["orientation"] = [float(v) for v in values] if values else None
            if track.scale_shear is not None:
                values = _evaluate_curve(track.scale_shear, sample_t)
                entry["scale_shear"] = [float(v) for v in values] if values else None
            out[track.name] = entry
    return out


_IDENTITY_POSITION = (0.0, 0.0, 0.0)
_IDENTITY_ORIENTATION = (0.0, 0.0, 0.0, 1.0)
_IDENTITY_SCALE_SHEAR = (1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)


def _shape_position(values):
    """Match JS `shapeTransformComponent` (GrannyAnimation.js) : null /
    malformed curve outputs collapse to IDENTITY values, NOT to bind
    pose. JS treats a TransformTrack with a null curve as « zero offset
    on that channel », not « inherit bind ». Python oracle mirrors this
    so per-bone matrices match elementwise."""
    if values is None or len(values) != 3:
        return _IDENTITY_POSITION
    return (values[0], values[1], values[2])


def _shape_orientation(values):
    if values is None or len(values) != 4:
        return _IDENTITY_ORIENTATION
    return (values[0], values[1], values[2], values[3])


def _shape_scale_shear(values):
    if values is None:
        return _IDENTITY_SCALE_SHEAR
    if len(values) == 9:
        return tuple(values)
    if len(values) == 3:
        # Uniform scale curve expands to diagonal 3×3 (matches the JS
        # shapeTransformComponent in GrannyAnimation.js).
        return (values[0], 0.0, 0.0, 0.0, values[1], 0.0, 0.0, 0.0, values[2])
    return _IDENTITY_SCALE_SHEAR


def snapshot(model_path: Path, animation_path: Path | None, sample_t: float) -> dict:
    model = load_sections(read_gr2(model_path))
    skeletons = extract_skeletons(model)
    if not skeletons:
        raise SystemExit(f"no skeleton in {model_path}")
    skeleton = skeletons[0]
    track_map: dict[str, dict[str, list[float] | None]] = {}
    if animation_path is not None:
        anim_loaded = load_sections(read_gr2(animation_path))
        anim_set = extract_animation_set(anim_loaded)
        track_map = _animation_track_map(anim_set, sample_t)

    bone_records = []
    world_matrices: list[list[float]] = []
    for index, bone in enumerate(skeleton.bones):
        bind = bone.transform
        sampled = track_map.get(bone.name)
        if sampled is None:
            # No TransformTrack for this bone : bind pose passes through
            # untouched (matches `poseSkeletonAt` in GrannyPose.js).
            position = tuple(bind.position)
            orientation = tuple(bind.orientation)
            scale_shear = tuple(bind.scale_shear)
        else:
            # Bone HAS a TransformTrack : each channel falls back to
            # IDENTITY (not bind pose) when its curve is null. This is
            # the contract `evaluateTransformTrack` enforces in JS.
            position = _shape_position(sampled["position"])
            orientation = _shape_orientation(sampled["orientation"])
            scale_shear = _shape_scale_shear(sampled["scale_shear"])

        local = _quat_to_local_matrix(position, orientation, scale_shear)
        parent = bone.parent_index
        if parent < 0 or parent >= index:
            world = list(local)
        else:
            world = _matmul_cm(world_matrices[parent], local)
        world_matrices.append(world)

        iwt = _iwt_as_column_major(tuple(bone.inverse_world_transform))
        skin = _matmul_cm(world, iwt)

        bone_records.append({
            "name": bone.name,
            "parent_index": bone.parent_index,
            "world_matrix": world,
            "skinning_matrix": skin,
        })

    return {
        "model": model_path.name,
        "animation": animation_path.name if animation_path else None,
        "sample_t": sample_t,
        "bone_count": len(skeleton.bones),
        "bones": bone_records,
    }


def parse_triple(fixture_dir: Path, triple: str) -> tuple[Path, Path | None, float]:
    parts = triple.split(":")
    if len(parts) != 3:
        raise SystemExit(f"expected model:animation:t triple, got {triple}")
    model = fixture_dir / parts[0]
    animation = None if parts[1] == "-" else fixture_dir / parts[1]
    t = float(parts[2])
    if not model.exists():
        raise SystemExit(f"model fixture missing : {model}")
    if animation is not None and not animation.exists():
        raise SystemExit(f"animation fixture missing : {animation}")
    return model, animation, t


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.exit("usage: python-pose-oracle.py <fixture_dir> <model:animation:t> [...]")
    fixture_dir = Path(argv[0])
    for triple in argv[1:]:
        model, animation, t = parse_triple(fixture_dir, triple)
        snap = snapshot(model, animation, t)
        sys.stdout.write(json.dumps(snap) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
