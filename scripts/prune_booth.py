#!/usr/bin/env python3
"""Manual pruner: remove booth thumbnails and manifest entries for files
   no longer present in the booth Drive folder. Not run by scheduled sync.
   Usage:  python scripts/prune_booth.py [--dry-run]
"""

import argparse
import json
import os
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build

FOLDER_ID = os.environ["BOOTH_DRIVE_FOLDER_ID"]
SA_FILE   = os.environ["BOOTH_DRIVE_SA_FILE"]
THUMB_DIR = Path("booth_thumbnails")
MANIFEST  = Path("booth_manifest.json")
SCOPES    = ["https://www.googleapis.com/auth/drive.readonly"]


def list_drive_ids(svc) -> set:
    """Return the set of image file IDs currently in the Drive folder."""
    ids: set = set()
    page_token = None
    q = f"'{FOLDER_ID}' in parents and trashed = false"
    while True:
        resp = svc.files().list(
            q=q,
            pageSize=1000,
            fields="nextPageToken, files(id,mimeType)",
            pageToken=page_token,
        ).execute()
        for f in resp.get("files", []):
            if f["mimeType"].startswith("image/"):
                ids.add(f["id"])
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return ids


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true",
                   help="Show what would be deleted without doing it.")
    args = p.parse_args()

    creds = service_account.Credentials.from_service_account_file(
        SA_FILE, scopes=SCOPES)
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)

    drive_ids = list_drive_ids(svc)
    if not drive_ids:
        print("!! Drive returned 0 image files. Refusing to prune.",
              file=sys.stderr)
        return 1

    manifest_entries = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else []
    manifest = {e["id"]: e for e in manifest_entries}

    stale = [fid for fid in manifest if fid not in drive_ids]
    print(f"Drive: {len(drive_ids)} files.  Manifest: {len(manifest)} entries.  "
          f"Stale: {len(stale)}.")

    if not stale:
        print("Nothing to prune.")
        return 0

    for fid in stale:
        name = manifest[fid].get("name", "?")
        marker = "[dry-run]" if args.dry_run else "-"
        print(f"  {marker} {name} ({fid})")

    if args.dry_run:
        print("Dry run complete. Re-run without --dry-run to actually delete.")
        return 0

    # Actually prune
    for fid in stale:
        (THUMB_DIR / f"{fid}.jpg").unlink(missing_ok=True)
        del manifest[fid]

    ordered = sorted(manifest.values(),
                     key=lambda e: e.get("uploadedAt", ""), reverse=True)
    MANIFEST.write_text(json.dumps(ordered, indent=2))
    print(f"Pruned {len(stale)} entries.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
