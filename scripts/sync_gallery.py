#!/usr/bin/env python3
"""Download new guest photos from Drive, generate 400px grid thumbnails
   and 800px lightbox images, and update manifest.json.
   Idempotent: only new files are processed."""

import io
import json
import os
import sys
from pathlib import Path

from google.oauth2 import service_account
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload
from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

register_heif_opener()  # HEIC support for iPhone uploads

FOLDER_ID = os.environ["GDRIVE_FOLDER_ID"]
SA_FILE   = os.environ["GDRIVE_SA_FILE"]

THUMB_DIR = Path("thumbnails")   # 400px grid thumbs
LARGE_DIR = Path("large")        # 800px lightbox images
MANIFEST  = Path("manifest.json")

THUMB_MAX = 400
LARGE_MAX = 800
THUMB_Q   = 78
LARGE_Q   = 85

SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]
MIME_IMAGE_PREFIXES = ("image/",)


def load_manifest() -> dict:
    if MANIFEST.exists():
        data = json.loads(MANIFEST.read_text())
        return {e["id"]: e for e in data}
    return {}


def save_manifest(entries: dict) -> None:
    # sort newest first by uploadedAt so gallery ordering is stable
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


def make_variants(raw: bytes, fid: str) -> tuple[int, int]:
    """Generate 400px thumb + 800px large. Returns (w, h) of the large one."""
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im)   # fix phone rotation
        im = im.convert("RGB")             # HEIC/PNG → JPEG-safe

        # 800px lightbox image
        large = im.copy()
        large.thumbnail((LARGE_MAX, LARGE_MAX), Image.LANCZOS)
        LARGE_DIR.mkdir(parents=True, exist_ok=True)
        large.save(LARGE_DIR / f"{fid}.jpg",
                   "JPEG", quality=LARGE_Q, optimize=True, progressive=True)
        w, h = large.size

        # 400px grid thumb
        small = im.copy()
        small.thumbnail((THUMB_MAX, THUMB_MAX), Image.LANCZOS)
        THUMB_DIR.mkdir(parents=True, exist_ok=True)
        small.save(THUMB_DIR / f"{fid}.jpg",
                   "JPEG", quality=THUMB_Q, optimize=True, progressive=True)

        return w, h


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
        # Skip only if both variants already exist AND manifest knows about it
        if (fid in manifest
                and (THUMB_DIR / f"{fid}.jpg").exists()
                and (LARGE_DIR / f"{fid}.jpg").exists()):
            continue

        try:
            raw = download_bytes(svc, fid)
            w, h = make_variants(raw, fid)
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
