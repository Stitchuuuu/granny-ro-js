#!/usr/bin/env python3
"""Run Rasetsuu/blendergranny's clean-room type-tree + RootObject walker
against each .gr2 fixture and emit a normalized JSON snapshot the JS
comparator can diff against.

Mirrors scripts/python-oracle.py (which validates the Oodle0 codec) but
for the S5 type-tree layer. The snapshot covers :
  - typeTreeMemberNames : member names from header.root_type (in order)
  - rootKeys            : top-level keys exposed by the root object
  - arrayCounts         : per-name count for `_to_array` / `_of_references`
                          / `_to_variant_array` members of the root

Usage : python3 python-typetree-oracle.py <fixture.gr2> [<fixture.gr2> ...]
        → one JSON object per line.
"""
from __future__ import annotations

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
from io_scene_gr2.gr2.fixup import PointerRef, load_sections  # noqa: E402
from io_scene_gr2.gr2.types import (  # noqa: E402
    parse_type_definition_array,
    summarize_root_object,
)


# Member types that carry a `count` field in the materialized output —
# match the JS-side mapping in parseObject().
ARRAY_TYPES = frozenset({
    "reference_to_array",
    "array_of_references",
    "reference_to_variant_array",
})


def snapshot(path: Path) -> dict:
    gr2 = read_gr2(path)
    loaded = load_sections(gr2)

    root_type = PointerRef(*gr2.header.root_type)
    type_tree = parse_type_definition_array(loaded, root_type)
    type_tree_member_names = [member.name for member in type_tree]

    root = summarize_root_object(loaded)
    root_fields = root.get("fields", [])
    root_keys = [field["name"] for field in root_fields]
    array_counts = {
        field["name"]: field["count"]
        for field in root_fields
        if field["type"] in ARRAY_TYPES and "count" in field
    }

    return {
        "file": path.name,
        "typeTreeMemberCount": len(type_tree),
        "typeTreeMemberNames": type_tree_member_names,
        "rootKeys": root_keys,
        "arrayCounts": array_counts,
    }


def main(argv: list[str]) -> int:
    if not argv:
        sys.exit("usage: python-typetree-oracle.py <fixture.gr2> [...]")
    for path_str in argv:
        path = Path(path_str)
        snap = snapshot(path)
        sys.stdout.write(json.dumps(snap) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
