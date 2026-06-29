#!/usr/bin/env python3
"""Run Rasetsuu/blendergranny's animation extractor + curve evaluator
against each .gr2 fixture and emit a normalized JSON snapshot the JS
comparator can diff against (S7 of the granny-pipeline rollout).

Mirrors scripts/python-skeleton-mesh-oracle.py shape but targets the
extract_animation_set + _evaluate_curve entry points. The snapshot
covers exactly the fields GrannyAnimationLive.test.js compares :

  - animations  : per-animation (name, duration, time_step,
    oversampling, default_loop_count, flags, track_group_names)
  - track_groups : per-group (name, transform_track_count + per-track
    name + flags + per-curve codec + format + degree + dimension +
    knot_count + first/last knot value + evaluated transform sample
    at t = duration/2)

Pure-model fixtures resolve to empty `animations` + `track_groups`
arrays. Animation-only fixtures populate them fully.

Usage : python3 python-animation-oracle.py <fixture.gr2> [...]
        → one JSON object per line.
"""
from __future__ import annotations

import json
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
from io_scene_gr2.gr2.animation import (  # noqa: E402
    extract_animation_set,
    _evaluate_curve,
)


def _curve_snapshot(curve, t: float) -> dict | None:
    if curve is None:
        return None
    first_knot = float(curve.knot_values[0]) if curve.knot_values else None
    last_knot = float(curve.knot_values[-1]) if curve.knot_values else None
    sample = list(_evaluate_curve(curve, t)) if curve.knot_values or curve.sample_value else []
    return {
        "codec": curve.codec,
        "format": curve.format,
        "degree": curve.degree,
        "dimension": curve.dimension,
        "knot_control_count": curve.knot_control_count,
        "knot_count": len(curve.knot_values),
        "first_knot": first_knot,
        "last_knot": last_knot,
        "sample_value": list(curve.sample_value),
        "evaluated": [float(v) for v in sample],
    }


def _transform_track_snapshot(track, t: float) -> dict:
    return {
        "name": track.name,
        "flags": track.flags,
        "orientation": _curve_snapshot(track.orientation, t),
        "position": _curve_snapshot(track.position, t),
        "scale_shear": _curve_snapshot(track.scale_shear, t),
    }


def _track_group_snapshot(group, t: float) -> dict:
    return {
        "name": group.name,
        "transform_track_count": group.transform_track_count,
        "text_track_count": group.text_track_count,
        "vector_track_count": group.vector_track_count,
        "accumulation_flags": group.accumulation_flags,
        "loop_translation": group.loop_translation,
        "transform_tracks": [
            _transform_track_snapshot(track, t) for track in group.transform_tracks
        ],
    }


def _animation_snapshot(animation, sample_t: float) -> dict:
    return {
        "name": animation.name,
        "duration": animation.duration,
        "time_step": animation.time_step,
        "oversampling": animation.oversampling,
        "default_loop_count": animation.default_loop_count,
        "flags": animation.flags,
        "track_group_names": list(animation.track_group_names),
    }


def snapshot(path: Path) -> dict:
    gr2 = read_gr2(path)
    loaded = load_sections(gr2)
    animation_set = extract_animation_set(loaded)
    sample_t = 0.0
    if animation_set.animations:
        first = animation_set.animations[0]
        if first.duration > 0:
            sample_t = first.duration * 0.5
    return {
        "file": path.name,
        "animations": [
            _animation_snapshot(animation, sample_t)
            for animation in animation_set.animations
        ],
        "track_groups": [
            _track_group_snapshot(group, sample_t)
            for group in animation_set.track_groups
        ],
        "sample_t": sample_t,
    }


def main(argv: list[str]) -> int:
    if not argv:
        sys.exit("usage: python-animation-oracle.py <fixture.gr2> [...]")
    for path_str in argv:
        path = Path(path_str)
        snap = snapshot(path)
        sys.stdout.write(json.dumps(snap) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
