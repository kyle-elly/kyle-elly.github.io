# Photo Booth PC — Setup Guide

The photo booth is the open-source **[PhotoboothProject/photobooth](https://github.com/PhotoboothProject/photobooth)**
app running on a **dedicated Linux PC at the venue** (a self-hosted PHP/JS "photo box" with
live preview, collages, and printing). It is **not** part of the website repository. Its only
connection to the site is a shared Google Drive folder: the booth uploads its captures there,
and the site's `sync-booth.yml` workflow turns them into `booth_thumbnails/` +
`booth_manifest.json` and publishes them to `photobooth.html`.

```
Booth PC (PhotoboothProject)        Google Drive                  Website (GitHub)
----------------------------        ------------                  ----------------
capture photo                       BOOTH Drive folder            sync-booth.yml
   │                                     ▲                         → booth_thumbnails/
   ▼                                     │                         → booth_manifest.json
post-capture command:                    │                         → deployed to photobooth.html
  1. upload image to Drive ──────────────┘                                 ▲
  2. POST workflow_dispatch (fine-grained PAT) ─────────────────────────────┘
     → triggers sync-booth NOW
```

Photobooth supports **user-defined commands that run after a capture**. That hook is where
the two booth-side actions live: push the new image to the booth Drive folder, then call the
GitHub API to trigger `sync-booth.yml` so captures appear on the site within minutes. The
scheduled cron stays on as a backstop.

This document covers standing up that PC — the **Drive folder, credentials, the post-capture
command, and the sync contract** the website depends on. Full installation of Photobooth
itself is covered by that project's own docs; this guide assumes it's already installed and
capturing.

---

## 1. Prerequisites

- A **Linux PC** at the venue (Raspberry Pi 3/4/5 on Bookworm/Trixie, or a generic Debian/Ubuntu PC) with **[Photobooth](https://github.com/PhotoboothProject/photobooth)** installed and capturing (via its installer). Requires Node ≥ v20, PHP ≥ 8.4, and Apache/Nginx per that project.
- A camera Photobooth supports (Pi camera module, gphoto2 DSLR, or a webcam via `fswebcam`).
- Reliable internet at the venue (or a mobile hotspot as backup).
- A way to upload from the PC to Drive (e.g. **`rclone`** configured for the booth Google account, or a small upload script).
- The booth Drive **folder ID** (the long string in the folder's URL).

> **Security note (from the Photobooth project):** Photobooth is *not* hardened for untrusted
> networks and should never be exposed directly to the internet. Keep the booth PC on a
> private/local network at the venue; only its outbound Drive upload and GitHub dispatch calls
> reach the internet.

---

## 2. Create the booth Drive folder

1. In Google Drive, create a folder used **only** by the booth (keep it separate from the
   guest photo folder and the video cache folder).
2. Open the folder and copy its ID from the URL:
   `https://drive.google.com/drive/folders/`**`<THIS_IS_THE_FOLDER_ID>`**
3. Share the folder with whatever identity the booth PC uploads as:
   - **Service account (recommended):** share the folder with the service account's
     `client_email`, granting **Editor**.
   - **Personal Google account:** just sign in on the booth PC with that account.

> Keep this folder distinct from the guest gallery folder. The website runs
> `sync_booth.py` against *this* folder specifically, and mixing booth and guest photos
> would cross-populate the two galleries.

---

## 3. Give the website pipeline read access

The site's GitHub Actions workflow (`.github/workflows/sync-booth.yml`) reads the booth
folder using a **read-only service account**. Two repository secrets must be set:

| Secret | Value |
|--------|-------|
| `BOOTH_DRIVE_FOLDER_ID` | The folder ID from step 2 |
| `BOOTH_DRIVE_SA_FILE` | The service-account JSON with **read** access to that folder |

The booth PC's *upload* credentials and the website's *read* credentials can be different
identities — the only requirement is that both can see the same folder.

---

## 3a. Give the booth permission to trigger the sync (fine-grained PAT)

So booth photos appear within minutes instead of waiting for the scheduled cron, the booth's
upload path calls the GitHub API to start `sync-booth.yml` right after an upload. This needs
a **fine-grained personal access token**:

1. GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token.**
2. **Resource owner:** the account that owns this repo. **Repository access:** *Only select
   repositories* → this repo **only**.
3. **Permissions:** under *Repository permissions*, set **Actions → Read and write**. Nothing
   else is required — do not grant broader scopes.
4. **Expiration:** set an explicit expiry and **a calendar reminder to rotate it before the
   wedding**, since fine-grained PATs expire and a dead token silently disables the instant
   trigger (the cron still runs).
5. Store the token where the booth's uploader reads it — **never** in any file that ships to
   a browser or gets committed to the repo. If the booth uploads through an Apps Script,
   keep it in **Script Properties**; if it's a local script on the PC, keep it in an
   environment variable or OS credential store.

To match the guest uploader, use **`workflow_dispatch`**: `POST` to
`https://api.github.com/repos/<owner>/<repo>/actions/workflows/sync-booth.yml/dispatches`
with body `{"ref":"main"}` and headers `Authorization: Bearer <PAT>`,
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.

---

## 4. Configure Photobooth's post-capture command

In the Photobooth **Admin panel** you can set commands that run when a picture is taken.
Point that hook at a small script on the booth PC that does two things, in order:

1. **Upload the new capture to the booth Drive folder.** With `rclone` this is roughly:
   ```bash
   rclone copy "$FILEPATH" booth-drive:WeddingBooth --drive-root-folder-id "$BOOTH_FOLDER_ID"
   ```
2. **Trigger the sync** (only needs to fire once photos exist; debouncing isn't required
   since booth capture volume is low):
   ```bash
   curl -s -X POST \
     -H "Authorization: Bearer $GITHUB_PAT" \
     -H "Accept: application/vnd.github+json" \
     -H "X-GitHub-Api-Version: 2022-11-28" \
     https://api.github.com/repos/<owner>/<repo>/actions/workflows/sync-booth.yml/dispatches \
     -d '{"ref":"main"}'
   ```

Whatever mechanism you use, confirm:

- **Destination:** the booth Drive folder (folder ID from step 2) — *not* the guest folder.
- **Format:** JPEG. The website's thumbnailer (`scripts/imaging.py`) expects still images;
  it resizes to a 600px grid thumbnail at quality 78.
- **One file per capture.** If you use Photobooth's **collage** feature, decide whether you
  want each individual frame *and*/or the final collage synced — each JPEG in the folder
  becomes one gallery tile.
- **Leave originals full-resolution.** The site only ever stores a 600px thumbnail in the
  repo; the full image is streamed from the Drive CDN at view time, so higher-quality
  booth originals are fine and encouraged.
- **Keep secrets out of the repo.** `GITHUB_PAT` and `BOOTH_FOLDER_ID` belong in the booth
  PC's environment or a root-only script — never committed anywhere.

### Filename / caption behavior

Booth photos are captioned **"Photobooth"** automatically by `sync_booth.py` regardless of
filename, so you do **not** need any special naming convention on the booth PC — Photobooth's
default date-formatted or random names are both fine. (This differs from guest uploads, whose
captions are parsed from the `YYYYMMDD-HHMMSS_<guest>_<hex>` filename the PhotoUploader Apps
Script assigns.)

---

## 5. Test before the event

1. Take a test capture on the booth PC and confirm the post-capture command uploaded the file
   into the booth Drive folder (and that the `workflow_dispatch` call returned HTTP 2xx).
2. If needed, trigger the site sync manually:
   **GitHub → Actions → “sync-booth” → Run workflow.**
3. After it completes, confirm the deploy ran and the test photo appears on
   `https://kyle-elly.github.io/photobooth.html`.
4. Delete the test capture from Drive and, if you want it gone from the site too, run the
   **prune-booth** workflow (see below).

Doing this dry run once end-to-end is the single best way to catch a mis-shared folder or a
wrong folder ID before guests are relying on it.

---

## 6. Timing & expectations on the day

- **Near-real-time by default.** After each capture the booth's post-capture command triggers
  `sync-booth.yml` via the GitHub API, so photos normally appear on the site **within a few
  minutes** — no waiting for the scheduled run.
- **Scheduled cron is a backstop.** `sync-booth.yml` also runs on a cron, so even if a trigger
  call fails (expired token, dropped network), everything still gets picked up on the next
  scheduled run.
- **Manual run always available.** You can also start **sync-booth** from the Actions tab at
  any time; it picks up everything in the folder so far and deploys.
- **The sync is idempotent.** Re-running only processes *new* captures, so triggered runs,
  cron runs, and manual runs never duplicate or collide.
- **If instant updates stop working**, the token has most likely expired — see the
  troubleshooting table. Photos will still arrive on the next scheduled cron in the meantime.

---

## 7. Removing booth photos later

Pruning is **manual and defaults to a dry run** for safety:

- Delete the unwanted capture(s) from the booth Drive folder.
- Run the **prune-booth** workflow (GitHub → Actions → “prune-booth” → Run workflow).
  - It lists what *would* be removed first (dry run).
  - Re-run with the dry-run option disabled to actually remove the manifest/thumbnail entries.
- **Safety guard:** the pruner refuses to delete anything if Drive returns zero images, so a
  transient API hiccup can't wipe the booth gallery.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Booth photos never appear on the site | Wrong `BOOTH_DRIVE_FOLDER_ID`, or the read service account isn't shared on the folder | Re-check the folder ID and share the folder with the SA `client_email` |
| Booth photos show up in the **guest** gallery | Booth PC uploaded to the guest folder, or `photobooth.html` isn't setting `MANIFEST_URL`/`THUMB_DIR` | Point the booth at the booth folder; confirm the page's inline `<script>` sets the booth manifest/thumb dir |
| A capture appears but has no thumbnail | Non-image or corrupt file uploaded | Ensure the booth exports standard JPEGs |
| Uploads used to appear instantly, now only overnight | Fine-grained PAT expired or revoked, so the trigger call fails and only the cron runs | Generate a new fine-grained PAT (repo-only, Actions read & write) and update it where the booth uploader reads it |
| Instant trigger never worked at all | Token missing/wrong scope, or wrong repo selected | Confirm the PAT targets *this* repo with **Actions: read & write**, and that the uploader is calling the right workflow |
| Deleted a photo from Drive but it's still on the site | Manifest/thumbnail still committed | Run the **prune-booth** workflow |

---

Booth is intentionally decoupled: it only has to put JPEGs into one Drive folder. Everything
downstream — thumbnails, manifest, deploy — is handled by the website's existing pipeline.
