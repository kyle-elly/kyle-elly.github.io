#!/usr/bin/env python3
"""Re-sort an existing gallery manifest in NATURAL filename order, in place.

Fixes the lexicographic-sort bug where 'weddingphotos-10.jpg' sorted before
'weddingphotos-2.jpg'. Reads no Drive data and touches no thumbnails — it only
reorders the JSON array you already have, so it's instant and safe to re-run.

Usage:
    python resort_manifest.py photographer_manifest.json
    python resort_manifest.py honeymoon_manifest.json
    python resort_manifest.py *_manifest.json        # several at once
"""

import json
import re
import sys
from pathlib import Path


def natural_key(entry):
    """Compare digit-runs as integers so '-2' sorts before '-10'."""
    name = entry.get("name", "")
    return [int(tok) if tok.isdigit() else tok.lower()
            for tok in re.split(r'(\d+)', name)]


def resort(path: Path) -> None:
    entries = json.loads(path.read_text())
    before = [e.get("name", "") for e in entries]
    entries.sort(key=natural_key)
    after = [e.get("name", "") for e in entries]

    path.write_text(json.dumps(entries, indent=2))

    changed = before != after
    print(f"{path}: {len(entries)} entries "
          f"{'REORDERED' if changed else 'already in order'}")
    if changed:
        print(f"    first 3 now: {after[:3]}")
        print(f"    last 3 now:  {after[-3:]}")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    for arg in sys.argv[1:]:
        p = Path(arg)
        if not p.exists():
            print(f"!! {p} not found, skipping", file=sys.stderr)
            continue
        resort(p)
    return 0


if __name__ == "__main__":
    sys.exit(main())
