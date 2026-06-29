#!/usr/bin/env python3
"""Time Rasetsuu/blendergranny's decompressor over a set of .gr2 fixtures.

Usage : python3 python-bench.py <iterations> <fixture.gr2> [<fixture.gr2> ...]
        → emits JSON on stdout :
          {
            "iterations": N,
            "per_fixture": {
              "treasurebox_2.gr2": {
                "best_ms": 4.21,
                "mean_ms": 4.45,
                "decompressed_bytes": 56072
              },
              ...
            },
            "total_best_ms": 73.5,
            "total_mean_ms": 78.1,
            "total_decompressed_bytes": 1234567
          }

Reports the **best of N** as the headline number (matches JS micro-bench
convention — best run filters out GC / OS jitter), plus the mean for
context.
"""
from __future__ import annotations

import json
import sys
import os
import time
from pathlib import Path

BLENDERGRANNY_PATH = Path(os.environ.get("BLENDERGRANNY_PATH") or str(Path.home() / ".cache" / "granny-ro-js" / "blendergranny"))
if not BLENDERGRANNY_PATH.exists():
    sys.exit(
        f"FATAL: {BLENDERGRANNY_PATH} missing — re-clone via : "
        f"git clone --depth=1 --branch=main "
        f"https://github.com/Rasetsuu/blendergranny {BLENDERGRANNY_PATH}"
    )
sys.path.insert(0, str(BLENDERGRANNY_PATH))

from io_scene_gr2.gr2.file import read_gr2  # noqa: E402
from io_scene_gr2.gr2.decompress.base import decompress_section  # noqa: E402


def time_one(path: Path) -> tuple[float, int]:
    """Return (elapsed_ms, decompressed_bytes) for one parse+decompress pass."""
    t0 = time.perf_counter()
    gr2 = read_gr2(path)
    total_bytes = 0
    for sec in gr2.sections:
        compressed = gr2.section_bytes(sec)
        out = decompress_section(sec, compressed)
        total_bytes += len(out)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return elapsed_ms, total_bytes


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        sys.exit("usage: python-bench.py <iterations> <fixture.gr2> [...]")
    iterations = int(argv[0])
    fixture_paths = [Path(p) for p in argv[1:]]
    if iterations < 1:
        sys.exit("iterations must be ≥ 1")

    per_fixture: dict[str, dict] = {}
    for path in fixture_paths:
        times: list[float] = []
        total_bytes = 0
        for _ in range(iterations):
            ms, b = time_one(path)
            times.append(ms)
            total_bytes = b  # same every iteration
        per_fixture[path.name] = {
            "best_ms": min(times),
            "mean_ms": sum(times) / len(times),
            "decompressed_bytes": total_bytes,
        }

    # Total = sum of per-fixture bests (best-case end-to-end), and sum of means.
    total_best = sum(f["best_ms"] for f in per_fixture.values())
    total_mean = sum(f["mean_ms"] for f in per_fixture.values())
    total_bytes_all = sum(f["decompressed_bytes"] for f in per_fixture.values())

    sys.stdout.write(json.dumps({
        "iterations": iterations,
        "per_fixture": per_fixture,
        "total_best_ms": total_best,
        "total_mean_ms": total_mean,
        "total_decompressed_bytes": total_bytes_all,
    }) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
