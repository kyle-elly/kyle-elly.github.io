# Kyle & Elly's Wedding Guest Photobook

A lightweight, static wedding photo site hosted on **GitHub Pages**. Guests upload
photos and videos from their phones; a scheduled pipeline pulls new photos from
Google Drive, generates thumbnails, and republishes the site. There is no server
and no database — just static files plus a nightly sync.

**Live site:** https://kyle-elly.github.io

---

## How it works (at a glance)

```
Guest phone              Google Drive               GitHub Actions          GitHub Pages
-----------              ------------               --------------          ------------
upload.html      ──▶  Apps Script ─▶ Drive (guest photos) ─▶ sync_gallery.py ─▶ thumbnails/ + manifest.json
                       (cred broker)                          (nightly cron)        │
video-upload.html ─▶  Apps Script ─▶ Drive (video CACHE) ──┐                        │
                       (cred broker)                        │                       │
                                                            ▼                        │
                                                    NAS rsync job pulls videos,      │
                                                    then DELETES them off Drive      │
                                                                                     │
Booth PC (separate) ──────────────▶ Drive (booth photos) ─▶ sync_booth.py ─▶ booth_thumbnails/ + booth_manifest.json
                                                                                     │
                                                                     static.yml deploys ──▶ live site
```

- **Frontend:** hand-written static HTML/CSS/JS. No framework, no build step for the pages themselves.
- **Uploads:** `upload.html` (photos) and `video-upload.html` (videos) are **both** Google Apps Script credential brokers — the Apps Script holds the Drive credentials so no secrets ever live in the browser. Upload endpoints are intentionally kept private.
- **Photos** flow into a guest Drive folder that the nightly sync turns into thumbnails + `manifest.json`.
- **Videos** use Drive only as a **temporary cache**: an rsync job on the couple's NAS periodically pulls new videos out of Drive, stores them locally, and **deletes them from Drive** so the Drive quota never fills with large video files. Videos never appear in any public gallery.
- **Photo booth** is a **separate application running on a PC at the venue** (not part of this repo). It uploads its captures straight to a dedicated booth Drive folder, which `sync_booth.py` turns into `booth_thumbnails/` + `booth_manifest.json`. See **[docs/PHOTOBOOTH_SETUP.md](docs/PHOTOBOOTH_SETUP.md)**.
- **Thumbnails:** generated server-side in the Actions runner (600px grid thumbnails).
- **Full images:** served directly from the Google Drive CDN (`lh3.googleusercontent.com`) at view time — no large images are stored in the repo.
- **Downloads:** the "Save Hi Res Photo" link points at `drive.usercontent.google.com`.

---

## Repository layout

```
.
├── index.html               # Landing page (Share / Browse hubs)
├── gallery.html             # Guest gallery (uses manifest.json + thumbnails/)
├── photobooth.html          # Photo booth gallery (uses booth_manifest.json + booth_thumbnails/)
├── upload.html              # Guest photo upload  (Apps Script credential broker)
├── video-upload.html        # Guest video upload  (Apps Script credential broker; Drive used as a cache)
├── photoboothSign.html      # Printable QR sign for the booth
├── under-construction.html  # Orphaned placeholder (not linked; safe to delete)
│
├── gallery.js               # Shared gallery + lightbox logic (both galleries)
├── shared.css               # Shared styling for every page
├── favicon.ico
├── fonts/
│   └── alex-brush-latin-regular.woff2
│
├── manifest.json            # Guest gallery manifest (id, name, w, h, caption, uploadedAt)
├── thumbnails/              # Guest grid thumbnails (<id>.jpg)
├── booth_manifest.json      # Booth gallery manifest
├── booth_thumbnails/        # Booth grid thumbnails
│
├── docs/
│   └── PHOTOBOOTH_SETUP.md  # Setup for the separate booth PC that uploads to Drive
│
├── scripts/
│   ├── imaging.py           # Shared thumbnail sizing/quality (single source of truth)
│   ├── sync_gallery.py      # Pull new guest photos from Drive → thumbnails + manifest
│   ├── sync_booth.py        # Same, for the booth Drive folder
│   ├── prune_gallery.py     # Manual: remove entries no longer in Drive
│   └── prune_booth.py       # Manual: same, for booth
├── requirements.txt         # Python deps for the sync scripts
│
└── .github/workflows/
    ├── sync-gallery.yml     # Nightly guest sync (cron 17 3 * * *)
    ├── sync-booth.yml       # Nightly booth sync (cron 37 3 * * *)
    ├── prune-gallery.yml    # Manual prune (workflow_dispatch, dry-run default)
    ├── prune-booth.yml      # Manual prune (workflow_dispatch, dry-run default)
    └── static.yml           # Deploy to Pages after a successful sync
```

---

## The two galleries

`gallery.html` and `photobooth.html` share the **same** `gallery.js`. They differ only
by two globals set in an inline `<script>` **before** `gallery.js` loads:

```html
<!-- gallery.html -->
<script>
  window.MANIFEST_URL = 'manifest.json';
  window.THUMB_DIR = 'thumbnails';
</script>

<!-- photobooth.html -->
<script>
  window.MANIFEST_URL = 'booth_manifest.json';
  window.THUMB_DIR = 'booth_thumbnails';
</script>
```

`gallery.js` falls back to the guest defaults (`manifest.json` / `thumbnails`) if these
are not set, so the booth page **must** set them or it will silently show guest photos.

---

## Frontend features (`gallery.js`)

- **Infinite scroll** — renders 60 photos per batch via an `IntersectionObserver` on a sentinel element (400px root margin).
- **Lightbox** — click a thumbnail to open a full-size view with prev/next arrows, keyboard nav (←/→/Esc), and swipe gestures on touch devices.
- **Neighbor prefetch** — after the current lightbox image finishes loading, the next photo in the direction of travel is warmed (deferred so it never competes with the visible image for bandwidth).
- **Responsive image sizing** — phones request `=w1200`, desktop/tablet request `=w2048`, matched to the device so prefetch always fetches what the browser will actually use.
- **History-aware close** — opening the lightbox pushes exactly one history entry; both the ✕ button and the browser Back button pop that single entry and return to the gallery (never overshooting to the home page).
- **Graceful failure** — a broken image shows "This photo couldn't load — swipe to continue" instead of a broken-image icon.

---

## Uploads (guest-facing)

Both upload pages are thin frontends over a **Google Apps Script web app** that acts as
a credential broker: the browser never sees Drive credentials, it just POSTs files to the
Apps Script `/exec` endpoint, which writes them into Drive on the user's behalf.

- **`upload.html` (photos)** — writes into the guest photo Drive folder. `sync_gallery.py` later turns these into gallery thumbnails.
- **`video-upload.html` (videos)** — writes into a **video cache** Drive folder. Videos are *not* published to the site. Instead, an **rsync job on the couple's NAS** periodically:
  1. checks the video cache folder in Drive for new files,
  2. downloads them to the NAS, and
  3. **deletes them from Drive** once safely stored.

  This keeps Drive from filling up with large video files while still giving guests a
  simple phone-friendly upload path. The NAS is the system of record for videos; Drive is
  only a short-lived hand-off buffer.

## The photo booth (separate project)

The photo booth is a **standalone application on a PC at the venue** — it is *not* part of
this repository. It captures booth photos and uploads them directly to a dedicated **booth
Drive folder**. From there the pipeline is identical to the guest gallery: `sync_booth.py`
generates `booth_thumbnails/` + `booth_manifest.json`, and `photobooth.html` displays them.

Full setup and operational notes for that PC live in
**[docs/PHOTOBOOTH_SETUP.md](docs/PHOTOBOOTH_SETUP.md)**.

## The sync pipeline

Both sync scripts are structurally identical and share `scripts/imaging.py` so the two
galleries produce visually identical thumbnails.

**What a sync run does:**
1. List image files in the target Drive folder (service-account, read-only).
2. For each *new* file (not already in the manifest with a thumbnail on disk):
   - download the bytes,
   - generate a 600px grid thumbnail (`THUMB_MAX = 600`, `THUMB_Q = 78`, progressive JPEG),
   - record `{ id, name, uploadedAt, w, h, caption }` in the manifest.
3. Write the manifest sorted newest-first.

The run is **idempotent** — only new files are processed, so re-runs are cheap.

**Captions** are parsed from the guest upload filename
(`YYYYMMDD-HHMMSS_First_Last_<6hex>_...`). `anonymous` / `guest` and non-matching
names fall back to a blank caption. Booth photos are always captioned `Photobooth`.

### Required environment / secrets

Injected by the workflows (not stored in the repo):

| Variable | Purpose |
|----------|---------|
| `GDRIVE_FOLDER_ID` | Guest photo Drive folder |
| `GDRIVE_SA_FILE` | Service-account JSON for the guest folder |
| `BOOTH_DRIVE_FOLDER_ID` | Booth photo Drive folder |
| `BOOTH_DRIVE_SA_FILE` | Service-account JSON for the booth folder |

Scope used: `https://www.googleapis.com/auth/drive.readonly`.

---

## Workflows

| Workflow | Trigger | What it does |
|----------|---------|--------------|
| `sync-gallery.yml` | cron `17 3 * * *` + manual | Sync guest photos |
| `sync-booth.yml` | cron `37 3 * * *` + manual | Sync booth photos (offset 20 min to avoid overlap) |
| `static.yml` | after a successful sync (`workflow_run`) + manual | Deploy the site to GitHub Pages |
| `prune-gallery.yml` | manual (`workflow_dispatch`) | Remove manifest/thumbnail entries no longer in Drive |
| `prune-booth.yml` | manual (`workflow_dispatch`) | Same, for booth |

The two sync jobs use **separate concurrency groups** (`gallery-sync` / `booth-sync`) so
they never collide. `static.yml` gates on the sync's `conclusion == 'success'` and skips
deploying if `main` hasn't moved.

**Pruning is deliberately manual and defaults to a dry run.** Both pruners refuse to
delete anything if Drive returns zero image files (guards against wiping the gallery on
a transient API error).

---

## Local development

The pages are pure static files — open them directly or serve the folder:

```bash
# Any static server works; e.g.
python -m http.server 8000
# then visit http://localhost:8000/gallery.html
```

To run a sync locally (needs a service-account JSON and the folder ID):

```bash
pip install -r requirements.txt
export GDRIVE_FOLDER_ID="..."
export GDRIVE_SA_FILE="/path/to/service-account.json"
python scripts/sync_gallery.py

# Preview what a prune would remove (safe):
python scripts/prune_gallery.py --dry-run
```

---

## Design decisions & notes

- **Static frontend + serverless backend.** No server to run or pay for; GitHub Pages hosts the site and Actions does the periodic work.
- **Full images are never committed.** Only 600px thumbnails live in the repo; full-resolution views stream from the Drive CDN, keeping the repo small.
- **Videos stay private and off the site.** `video-upload.html` writes to a Drive *cache* folder; a NAS rsync job pulls videos down and deletes them from Drive so the quota never fills. Videos never appear in any public gallery.
- **The booth is a separate system.** Booth capture/upload software runs on a venue PC outside this repo; it only shares a Drive folder with the pipeline. See `docs/PHOTOBOOTH_SETUP.md`.
- **Preconnect the CDN, not `drive.google.com`.** Lightbox images come from `lh3.googleusercontent.com` and downloads from `drive.usercontent.google.com` — those are the origins worth warming.
- **`under-construction.html` is orphaned** and can be deleted; it's a leftover pre-launch placeholder.

---

Kyle & Elly · August 8th, 2026 · 💚
