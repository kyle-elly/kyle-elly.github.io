#!/usr/bin/env python3
"""Download new honeymoon photos from Drive, generate 600px grid thumbnails,
   and update honeymoon_manifest.json.
   Idempotent: only new files are processed.

   Structurally identical to sync_photographer.py / sync_booth.py / sync_gallery.py
   but reads from a different Drive folder (via HONEYMOON_DRIVE_FOLDER_ID) and
   writes to honeymoon_thumbnails/ and honeymoon_manifest.json so the pipelines
   never touch each other's files.

   Same two intentional DIFFs as the photographer set, because the honeymoon
   photos are also a curated one-time bulk drop rather than a live feed:
     * caption is blank ("") — filenames like IMG_1234 make poor captions.
     * the manifest is sorted by NAME ASCENDING (see save_manifest), so the
       gallery reads in camera/date order instead of the jumbled createdTime
       order you'd get from a bulk upload. To match the guest gallery's
       newest-first behavior instead, change the sort key back to "uploadedAt"
       with reverse=True.

   Lightbox images are served directly from the Drive CDN at view time
   (lh3.googleusercontent.com/d/<id>=w####), so no `large/` directory is
   generated on disk.
"""

import io
import json
import os
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from imaging import make_thumbnail   # shared with the other sync scripts

FOLDER_ID = os.environ["HONEYMOON_DRIVE_FOLDER_ID"]   # honeymoon folder ID, injected by workflow
SA_FILE   = os.environ["HONEYMOON_DRIVE_SA_FILE"]

THUMB_DIR = Path("honeymoon_thumbnails")
MANIFEST  = Path("honeymoon_manifest.json")

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
MIME_IMAGE_PREFIXES = ("image/",)

# 0 = no cap (process everything in one run). Set via the workflow env to
# checkpoint a large one-time drop into resumable batches; each run commits
# what it did, and re-running picks up where it left off (idempotent).
MAX_PER_RUN = int(os.environ.get("HONEYMOON_MAX_PER_RUN", "0"))

def taken_at(f):
    """Capture time from EXIF (imageMediaMetadata.time), normalized to
    ISO-ish 'YYYY-MM-DDTHH:MM:SS' so it sorts alongside createdTime.
    Falls back to Drive's createdTime when a file has no EXIF timestamp
    (screenshots, edited exports, etc.)."""
    meta = f.get("imageMediaMetadata") or {}
    t = meta.get("time")            # EXIF format: "YYYY:MM:DD HH:MM:SS"
    if t and len(t) >= 19:
        date, _, clock = t.partition(" ")
        return date.replace(":", "-") + "T" + clock
    return f.get("createdTime", "")

def load_manifest() -> dict:
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text())
        return {e["id"]: e for e in data}
    return {}


def save_manifest(entries: dict) -> None:
    # ← DIFF: sort by filename ascending so the curated set reads in the
    #   intended order. (Booth/guest sort by uploadedAt desc.)
    ordered = sorted(entries.values(),
                     key=lambda e: e.get("takenAt") or e.get("uploadedAt", ""))
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
    print(f"Drive returned {len(drive_files)} honeymoon images; "
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
            "takenAt": taken_at(f),
            "w": w,
            "h": h,
            "caption": "",          # ← DIFF: honeymoon photos carry no caption
        }
        added += 1
        print(f"  + {f['name']} ({w}x{h})")

        if MAX_PER_RUN and added >= MAX_PER_RUN:
            print(f"Reached per-run cap ({MAX_PER_RUN}); stopping early. "
                  f"Re-run to continue where this left off.")
            break

    save_manifest(manifest)
    print(f"Done. Added {added} new honeymoon files. Total: {len(manifest)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
