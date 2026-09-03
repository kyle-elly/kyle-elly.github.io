#!/usr/bin/env python3
"""Download new photographer photos from Drive, generate 600px grid thumbnails,
   and update photographer_manifest.json.
   Idempotent: only new files are processed.

   Structurally identical to sync_booth.py / sync_gallery.py but reads from a
   different Drive folder (via PHOTOG_DRIVE_FOLDER_ID) and writes to
   photographer_thumbnails/ and photographer_manifest.json so the three
   pipelines never touch each other's files.

   Two intentional DIFFs from booth/guest, because the photographer set is a
   curated one-time delivery rather than a live feed:
     * caption is blank ("") — filenames like IMG_1234 make poor captions,
       and a repeated "Photographer" label on every tile is just noise.
     * the manifest is sorted by NAME (natural order; see save_manifest), so the
       gallery reads in the photographer's own sequence (ceremony -> reception)
       instead of the jumbled createdTime order you'd get from a bulk upload.
       To match the guest gallery's newest-first behavior instead, change the
       sort key back to "uploadedAt" with reverse=True.

   Lightbox images are served directly from the Drive CDN at view time
   (lh3.googleusercontent.com/d/<id>=w####), so no `large/` directory is
   generated on disk.
"""

import io
import json
import os
import re
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from imaging import make_thumbnail   # shared with sync_gallery.py / sync_booth.py

FOLDER_ID = os.environ["PHOTOG_DRIVE_FOLDER_ID"]   # photographer folder ID, injected by workflow
SA_FILE   = os.environ["PHOTOG_DRIVE_SA_FILE"]

THUMB_DIR = Path("photographer_thumbnails")
MANIFEST  = Path("photographer_manifest.json")

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
MIME_IMAGE_PREFIXES = ("image/",)


def _natural_key(entry):
    """Natural sort key: compare digit-runs as integers so
    'weddingphotos-2.jpg' sorts before 'weddingphotos-10.jpg'
    (plain string sort would put '10' before '2')."""
    name = entry.get("name", "")
    return [int(tok) if tok.isdigit() else tok.lower()
            for tok in re.split(r'(\d+)', name)]


def load_manifest() -> dict:
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text())
        return {e["id"]: e for e in data}
    return {}


def save_manifest(entries: dict) -> None:
    # ← DIFF: sort by filename in NATURAL order so the curated set reads in the
    #   photographer's intended order. (Booth/guest sort by uploadedAt desc.)
    ordered = sorted(entries.values(), key=_natural_key)
    MANIFEST.write_text(json.dumps(ordered, indent=2))


def list_drive_files(svc):
    files, page_token = [], None
    q = f"'{FOLDER_ID}' in parents and trashed = false"
    while True:
        resp = svc.files().list(
            q=q,
            pageSize=1000,
            fields="nextPageToken, files(id,name,mimeType,createdTime,imageMediaMetadata)",
            pageToken=page_token,
            supportsAllDrives=False,
        ).execute()
        files.extend(resp.get("files", []))
        page_token = resp.get("nextPageToken")
        if not page_token:
            break
    return [f for f in files if f["mimeType"].startswith(MIME_IMAGE_PREFIXES)]


def download_bytes(svc, file_id: str) -> bytes:
    buf = io.BytesIO()
    req = svc.files().get_media(fileId=file_id)
    dl = MediaIoBaseDownload(buf, req, chunksize=1024 * 1024)
    done = False
    while not done:
        _, done = dl.next_chunk()
    return buf.getvalue()


def main() -> int:
    creds = service_account.Credentials.from_service_account_file(
        SA_FILE, scopes=SCOPES)
    svc = build("drive", "v3", credentials=creds, cache_discovery=False)

    manifest = load_manifest()
    drive_files = list_drive_files(svc)
    print(f"Drive returned {len(drive_files)} photographer images; "
          f"manifest has {len(manifest)} entries.")

    added = 0
    for f in drive_files:
        fid = f["id"]
        # Skip if already processed AND the thumbnail still exists on disk
        if fid in manifest and (THUMB_DIR / f"{fid}.jpg").exists():
            continue

        try:
            raw = download_bytes(svc, fid)
            w, h = make_thumbnail(raw, fid, THUMB_DIR)
        except Exception as e:
            print(f"  !! {f['name']} ({fid}) failed: {e}", file=sys.stderr)
            continue

        manifest[fid] = {
            "id": fid,
            "name": f["name"],
            "uploadedAt": f.get("createdTime", ""),
            "w": w,
            "h": h,
            "caption": "",          # ← DIFF: photographer photos carry no caption
        }
        added += 1
        print(f"  + {f['name']} ({w}x{h})")

    save_manifest(manifest)
    print(f"Done. Added {added} new photographer files. Total: {len(manifest)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
