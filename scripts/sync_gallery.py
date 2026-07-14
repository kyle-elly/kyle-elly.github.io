#!/usr/bin/env python3
"""Download new guest photos from Drive, generate thumbnails and
   large images, and update manifest.json.
   Idempotent: only new files are processed."""

import io
import json
import os
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

from imaging import make_variants   # ← shared with sync_booth.py

FOLDER_ID = os.environ["GDRIVE_FOLDER_ID"]
SA_FILE   = os.environ["GDRIVE_SA_FILE"]

THUMB_DIR = Path("thumbnails")
LARGE_DIR = Path("large")
MANIFEST  = Path("manifest.json")

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
MIME_IMAGE_PREFIXES = ("image/",)


def load_manifest() -> dict:
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text())
        return {e["id"]: e for e in data}
    return {}


def save_manifest(entries: dict) -> None:
    ordered = sorted(entries.values(),
                     key=lambda e: e.get("uploadedAt", ""),
                     reverse=True)
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
    print(f"Drive returned {len(drive_files)} image files; "
          f"manifest has {len(manifest)} entries.")

    added = 0
    for f in drive_files:
        fid = f["id"]
        if (fid in manifest
                and (THUMB_DIR / f"{fid}.jpg").exists()
                and (LARGE_DIR / f"{fid}.jpg").exists()):
            continue

        try:
            raw = download_bytes(svc, fid)
            w, h = make_variants(raw, fid, THUMB_DIR, LARGE_DIR)
        except Exception as e:
            print(f"  !! {f['name']} ({fid}) failed: {e}", file=sys.stderr)
            continue

        manifest[fid] = {
            "id": fid,
            "name": f["name"],
            "uploadedAt": f.get("createdTime", ""),
            "w": w,
            "h": h,
        }
        added += 1
        print(f"  + {f['name']} ({w}x{h})")

    save_manifest(manifest)
    print(f"Done. Added {added} new files. Total: {len(manifest)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
