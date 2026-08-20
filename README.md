# Kyle & Elly's Wedding Guest Photobook

A lightweight, static wedding photo site hosted on **GitHub Pages**. Guests upload
photos and videos from their phones; a pipeline pulls new photos from Google Drive,
generates thumbnails, and republishes the site. There is no server and no database —
just static files plus a sync that runs on demand (triggered by uploads) and on a
scheduled cron as a safety net.

**Live site:** https://kyle-elly.github.io

**Related repos:**
- [`kyle-elly/PhotoUploader`](https://github.com/kyle-elly/PhotoUploader) — the Google Apps Script (`code.gs`) that brokers guest photo uploads and triggers the sync.
- [`PhotoboothProject/photobooth`](https://github.com/PhotoboothProject/photobooth) — the open-source photo booth app that runs on the venue PC.

---

## How it works (at a glance)

```
Guest phone            Apps Script broker        Google Drive          GitHub Actions        GitHub Pages
-----------            ------------------        ------------          --------------        ------------
upload.html      ─▶ mint resumable upload URL ─▶ browser PUTs bytes ─▶ Drive (guest photos) ─▶ sync_gallery.py ─▶ thumbnails/ + manifest.json
                    then debounced workflow_dispatch ─────────────────────────────▶ (triggers sync)   │
video-upload.html ─▶ (video cred broker) ──────▶ Drive (video CACHE) ──┐                               │
                                                                        ▼                               │
                                                        NAS rsync pulls videos, DELETES them off Drive  │
                                                                                                        │
Booth PC (PhotoboothProject) ─▶ post-capture cmd ─▶ Drive (booth photos) ─▶ sync_booth.py ─▶ booth_thumbnails/ + booth_manifest.json
                                + workflow_dispatch ──────────────────────────────▶ (triggers sync)    │
                                                                                    static.yml deploys ──▶ live site
```

- **Frontend:** hand-written static HTML/CSS/JS. No framework, no build step for the pages themselves.
- **Uploads use a signed-URL (resumable) pattern.** The Apps Script brokers **do not receive the photo bytes**. The browser asks the Apps Script to *mint* a Drive **resumable upload session URL** (created with the script's own OAuth token), then uploads the file bytes **directly to Drive**. So no Drive credentials ever reach the browser, and large files never pass through Apps Script. Upload endpoints are intentionally kept private.
- **Photos** flow into a guest Drive folder; the sync turns them into thumbnails + `manifest.json`.
- **Videos** use Drive only as a **temporary cache**: an rsync job on the couple's NAS periodically pulls new videos out of Drive, stores them locally, and **deletes them from Drive** so the Drive quota never fills with large video files. Videos never appear in any public gallery.
- **Photo booth** is the open-source **[PhotoboothProject](https://github.com/PhotoboothProject/photobooth)** app running on a Linux PC at the venue (not part of this repo). A post-capture command uploads each shot to a dedicated booth Drive folder and triggers `sync-booth.yml`. See **[docs/PHOTOBOOTH_SETUP.md](docs/PHOTOBOOTH_SETUP.md)**.
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
    ├── sync-gallery.yml     # Guest sync (workflow_dispatch + scheduled cron safety net)
    ├── sync-booth.yml       # Booth sync (workflow_dispatch + scheduled cron safety net)
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

The guest photo uploader is the **Google Apps Script in [`kyle-elly/PhotoUploader`](https://github.com/kyle-elly/PhotoUploader)** (`code.gs`). It is a
**credential broker that mints signed upload URLs** — it never handles the photo bytes itself.

**How a guest photo upload works:**
1. The browser sends the Apps Script a batch of file descriptors (name, MIME type, size) via the `initPhotoUploadBatch` action.
2. For each valid file (image only, ≤ 50 MB, ≤ 25 per batch), the script uses its own OAuth token to create a Drive **resumable upload session** and returns the session `uploadUrl`. All sessions in a batch are created **concurrently** with `UrlFetchApp.fetchAll`, so a 25-photo batch costs one round trip, not 25.
3. The browser then **PUTs the actual bytes straight to Drive** at those session URLs. Nothing large ever passes through Apps Script.
4. Filenames are normalized server-side to `YYYYMMDD-HHMMSS_<guest>_<6hex>_<original>` so the sync can parse a caption from them later.

**Triggering the sync (debounced).** After uploading, the browser calls the `requestGalleryRefresh` action. This does **not** fire a workflow on every upload — it's coalesced:
- A **5-minute cooldown** (`DISPATCH_COOLDOWN_MS`) is the minimum gap between workflow runs.
- If an upload lands inside the cooldown, the script just sets a `GALLERY_PENDING` flag instead of dispatching.
- A **time-driven trigger (`galleryFlushTick`, every 5 min)** flushes any pending flag once the cooldown clears, so a burst of guests uploading at once collapses into a single sync run rather than dozens.
- `LockService` guards the decision so concurrent executions can't double-dispatch.

When it does dispatch, `triggerGallerySync_()` POSTs to
`…/actions/workflows/sync-gallery.yml/dispatches` with `{ "ref": "main" }`, authenticated
by a fine-grained PAT (see [Upload-triggered syncs](#upload-triggered-syncs-near-real-time)).
It's fire-and-forget: any failure is logged and simply falls back to the scheduled cron.

**Videos** (`video-upload.html`) use a **separate** credential broker writing into a
**video cache** Drive folder. Videos are *not* published to the site. Instead, an **rsync
job on the couple's NAS** periodically:
1. checks the video cache folder in Drive for new files,
2. downloads them to the NAS, and
3. **deletes them from Drive** once safely stored.

The NAS is the system of record for videos; Drive is only a short-lived hand-off buffer.

### Apps Script setup (PhotoUploader)

Configured in `code.gs` constants and **Script Properties**:

| Where | Key | Purpose |
|-------|-----|---------|
| constant | `PHOTO_FOLDER_ID` | Target guest photo Drive folder |
| constant | `ALLOWED_ORIGINS` | Origins allowed to request upload sessions (site + localhost) |
| Script Property | `GITHUB_PAT` | Fine-grained PAT used to dispatch the sync workflow |
| Script Property | `GITHUB_REPO` | `owner/repo` the dispatch targets |
| Script Property | `GALLERY_LAST_DISPATCH_MS` | (internal) last dispatch time for the cooldown |
| Script Property | `GALLERY_PENDING` | (internal) coalescing flag |

OAuth scopes (`appsscript.json`): `drive`, `script.external_request`, `script.scriptapp`.
Web app is deployed **execute as: user deploying**, **access: anyone (anonymous)**.

**One-time setup steps** in the Apps Script editor:
- Run `installGalleryFlushTrigger()` once to install the 5-minute flush trigger.
- Run `removeGalleryFlushTrigger()` **after the wedding** to stop consuming trigger runtime.
- Handy diagnostics: `testDriveAccess()`, `testInitBatch()`, `testRefreshDebounce()`, `resetDispatchState()`.

## The photo booth (separate project)

The photo booth is the open-source **[PhotoboothProject/photobooth](https://github.com/PhotoboothProject/photobooth)**
app running on a **Linux PC at the venue** — a self-hosted PHP/JS photo-box with live
preview, collages, and printing. It is *not* part of this repository.

Photobooth lets you define **custom commands that run after a capture**. That hook is used
to (a) push the new image to a dedicated **booth Drive folder** and (b) trigger
`sync-booth.yml` via the GitHub API. From there the pipeline is identical to the guest
gallery: `sync_booth.py` generates `booth_thumbnails/` + `booth_manifest.json`, and
`photobooth.html` displays them.

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
| `sync-gallery.yml` | scheduled cron (safety net) + manual + **upload-triggered** | Sync guest photos |
| `sync-booth.yml` | scheduled cron (safety net) + manual + **upload-triggered** | Sync booth photos |
| `static.yml` | after a successful sync (`workflow_run`) + manual | Deploy the site to GitHub Pages |
| `prune-gallery.yml` | manual (`workflow_dispatch`) | Remove manifest/thumbnail entries no longer in Drive |
| `prune-booth.yml` | manual (`workflow_dispatch`) | Same, for booth |

The two sync jobs use **separate concurrency groups** (`gallery-sync` / `booth-sync`) so
they never collide. `static.yml` gates on the sync's `conclusion == 'success'` and skips
deploying if `main` hasn't moved.

### Upload-triggered syncs (near-real-time)

Syncs are not only scheduled. After uploads, the guest Apps Script and the booth PC each
kick off the sync via GitHub's **`workflow_dispatch`** REST endpoint
(`POST …/actions/workflows/<file>.yml/dispatches` with `{ "ref": "main" }`) so new photos
appear within a few minutes instead of waiting for the cron:

- The guest photo Apps Script (`PhotoUploader/code.gs`) dispatches **`sync-gallery.yml`** — debounced with a 5-minute cooldown + flush trigger (see [Uploads](#uploads-guest-facing)).
- The booth PC's post-capture command dispatches **`sync-booth.yml`**.

Both are authenticated with a **fine-grained personal access token** scoped to *this repo
only*, with just the **Actions: read & write** permission needed to start a workflow. The
cron schedules remain as a safety net so nothing is missed if a dispatch call fails.

**Token care:**
- Scope each token to this single repository, Actions permission only — nothing broader.
- Store it in **Script Properties** (`GITHUB_PAT`) / the booth PC's environment, never in page or client code.
- Fine-grained PATs expire; set a calendar reminder to rotate before the wedding date.

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

