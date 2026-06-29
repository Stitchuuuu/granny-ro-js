#!/usr/bin/env python3
"""Run Rasetsuu/blendergranny's clean-room Oodle0 / NoCompression decoder
against each .gr2 fixture and emit per-section SHA-256 + decompressed size
as JSON Lines.

Usage : python3 python-oracle.py <fixture.gr2> [<fixture.gr2> ...]
        → one JSON object per line, with shape :
          {
            "file": "treasurebox_2.gr2",
            "sections": [
              {"index": 0, "compression": "oodle0",
               "decompressed_size": 27416,
               "sha256": "489aa242095a36b3..."},
              ...
            ]
          }
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

# Adapt to the gitignored /tmp clone produced at granny-pipeline S1.
BLENDERGRANNY_PATH = Path("/tmp/granny-audit/blendergranny")
if not BLENDERGRANNY_PATH.exists():
    sys.exit(
        f"FATAL: {BLENDERGRANNY_PATH} missing — "
        "re-clone via : git clone --depth=1 --branch=main "
        f"https://github.com/Rasetsuu/blendergranny {BLENDERGRANNY_PATH}"
    )
sys.path.insert(0, str(BLENDERGRANNY_PATH))

from io_scene_gr2.gr2.file import read_gr2  # noqa: E402
from io_scene_gr2.gr2.decompress.base import decompress_section  # noqa: E402


def main(argv: list[str]) -> int:
    if not argv:
        sys.exit("usage: python-oracle.py <fixture.gr2> [...]")
    for path_str in argv:
        path = Path(path_str)
        gr2 = read_gr2(path)
        sections = []
        for sec in gr2.sections:
            compressed = gr2.section_bytes(sec)
            decompressed = decompress_section(sec, compressed)
            sections.append({
                "index": sec.index,
                "compression": sec.compression_name,
                "decompressed_size": len(decompressed),
                "sha256": hashlib.sha256(decompressed).hexdigest(),
            })
        sys.stdout.write(json.dumps({
            "file": path.name,
            "sections": sections,
        }) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
