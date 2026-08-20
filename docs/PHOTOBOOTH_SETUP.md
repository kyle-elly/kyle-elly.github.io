# Photo Booth PC — Setup Guide

The photo booth is the open-source **[PhotoboothProject/photobooth](https://github.com/PhotoboothProject/photobooth)**
app running on a **dedicated Linux PC at the venue** (a self-hosted PHP/JS "photo box" with
live preview, collages, and printing). It is **not** part of the website repository. Its only
connection to the site is a shared Google Drive folder: an **upload cron job on the booth PC**
pushes new captures there, and the site's `sync-booth.yml` workflow turns them into
`booth_thumbnails/` + `booth_manifest.json` and publishes them to `photobooth.html`.

```
Booth PC (PhotoboothProject)          Google Drive                Website (GitHub)
----------------------------          ------------                ----------------
Photobooth writes captures            BOOTH Drive folder          sync-booth.yml
to a local output folder                   ▲                       → booth_thumbnails/
   │                                        │                      → booth_manifest.json
   ▼                                        │                      → deployed to photobooth.html
upload cron job (every N min):              │                              ▲
  1. poll the local folder for new files    │                              │
  2. upload new files to Drive ─────────────┘                              │
  3. POST workflow_dispatch (fine-grained PAT) ─────────────────────────────┘
     → triggers sync-booth
```

Rather than hooking Photobooth's per-capture command, a **cron job polls Photobooth's local
output folder** on an interval, uploads any new images to the booth Drive folder, and then
triggers `sync-booth.yml`. The site's own scheduled cron stays on as a backstop.

This document covers standing up that PC — the **Drive folder, credentials, the upload cron
job, and the sync contract** the website depends on. Full installation of Photobooth itself is
covered by that project's own docs; this guide assumes it's already installed and capturing.

---

## 1. Prerequisites

- A **Linux PC** at the venue (Raspberry Pi 3/4/5 on Bookworm/Trixie, or a generic Debian/Ubuntu PC) with **[Photobooth](https://github.com/PhotoboothProject/photobooth)** installed and capturing (via its installer). Requires Node ≥ v20, PHP ≥ 8.4, and Apache/Nginx per that project.
- A camera Photobooth supports (Pi camera module, gphoto2 DSLR, or a webcam via `fswebcam`).
- Reliable internet at the venue (or a mobile hotspot as backup).
- **`cron`** available on the PC (standard on Linux) to run the upload job on an interval.
- A way to upload from the PC to Drive — e.g. **`rclone`** configured for the booth Google account.
- The path to **Photobooth's local image output folder** (where captures/collages are written).
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
   - **Personal Google account:** authorize `rclone` on the booth PC with that account.

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

So booth photos appear within minutes instead of waiting for the scheduled cron, the upload
job calls the GitHub API to start `sync-booth.yml` after it uploads. This needs a
**fine-grained personal access token**:

1. GitHub → **Settings → Developer settings → Fine-grained tokens → Generate new token.**
2. **Resource owner:** the account that owns the site repo. **Repository access:** *Only select
   repositories* → the site repo **only**.
3. **Permissions:** under *Repository permissions*, set **Actions → Read and write**. Nothing
   else is required — do not grant broader scopes.
4. **Expiration:** set an explicit expiry and **a calendar reminder to rotate it before the
   wedding**, since fine-grained PATs expire and a dead token silently disables the instant
   trigger (the site cron still runs).
5. Store the token on the booth PC where the cron job can read it — in an **environment file
   or OS credential store**, never committed anywhere.

The job triggers the workflow via **`workflow_dispatch`**: `POST` to
`https://api.github.com/repos/<owner>/<repo>/actions/workflows/sync-booth.yml/dispatches`
with body `{"ref":"main"}` and headers `Authorization: Bearer <PAT>`,
`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`.

---

## 4. Configure the upload cron job

The booth PC runs a **cron job that polls Photobooth's local output folder** and syncs new
images up to Drive. `rclone copy` is ideal here because it only transfers files that aren't
already at the destination, so re-running it every few minutes is cheap and idempotent.

A minimal upload script (`/opt/booth/upload.sh`):

```bash
#!/usr/bin/env bash
set -euo pipefail

BOOTH_LOCAL_DIR="/var/www/html/photobooth/data/images"   # Photobooth output folder
BOOTH_FOLDER_ID="<BOOTH_DRIVE_FOLDER_ID>"
GITHUB_PAT="<fine-grained PAT>"                            # source from env in practice
REPO="<owner>/<repo>"

# 1. Poll + upload only NEW files (rclone skips ones already in Drive)
rclone copy "$BOOTH_LOCAL_DIR" booth-drive: \
  --drive-root-folder-id "$BOOTH_FOLDER_ID" \
  --include "*.jpg" --max-age 24h --no-traverse

# 2. Nudge the site to re-sync (safe to call each run; GitHub just queues one)
curl -s -X POST \
  -H "Authorization: Bearer $GITHUB_PAT" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "https://api.github.com/repos/$REPO/actions/workflows/sync-booth.yml/dispatches" \
  -d '{"ref":"main"}' >/dev/null || true
```

Install it in cron (every 3 minutes):

```cron
*/3 * * * * /opt/booth/upload.sh >> /var/log/booth-upload.log 2>&1
```

Whatever interval you pick, confirm:

- **Source:** Photobooth's real output folder. Point `BOOTH_LOCAL_DIR` at wherever your
  install writes captures (and collages, if you want those too).
- **Destination:** the booth Drive folder (folder ID from step 2) — *not* the guest folder.
- **Format:** JPEG. The website's thumbnailer (`scripts/imaging.py`) expects still images;
  it resizes to a 600px grid thumbnail at quality 78.
- **One file per capture.** If you use Photobooth's **collage** feature, decide whether you
  want each individual frame and/or the final collage synced — each JPEG that lands in Drive
  becomes one gallery tile. Use `rclone`'s `--include`/`--exclude` to control this.
- **Leave originals full-resolution.** The site only ever stores a 600px thumbnail in the
  repo; the full image is streamed from the Drive CDN at view time, so higher-quality
  booth originals are fine and encouraged.
- **Keep secrets out of the repo.** `GITHUB_PAT` and `BOOTH_FOLDER_ID` belong in the booth
  PC's environment or a root-only script — never committed anywhere.

> **Idempotency matters.** Because the job re-scans the same folder every few minutes, the
> upload step must only transfer *new* files (that's what `rclone copy` does). The trigger is
> safe to call each run — GitHub coalesces overlapping `workflow_dispatch` calls and the sync
> itself only processes captures it hasn't seen.

### Filename / caption behavior

Booth photos are captioned **"Photobooth"** automatically by `sync_booth.py` regardless of
filename, so you do **not** need any special naming convention on the booth PC — Photobooth's
default date-formatted or random names are both fine. (This differs from guest uploads, whose
captions are parsed from the `YYYYMMDD-HHMMSS_<guest>_<hex>` filename the PhotoUploader Apps
Script assigns.)

---

## 5. Test before the event

1. Take a test capture on the booth PC and confirm it appears in Photobooth's local output folder.
2. Run the upload script by hand once and confirm the file lands in the booth Drive folder and
   the `workflow_dispatch` call returns HTTP 2xx:
   ```bash
   /opt/booth/upload.sh
   ```
3. (Or trigger the site sync manually: **GitHub → Actions → “sync-booth” → Run workflow.**)
4. After it completes, confirm the deploy ran and the test photo appears on
   `https://kyle-elly.github.io/photobooth.html`.
5. Confirm the **cron entry** is installed (`crontab -l`) and check `/var/log/booth-upload.log`
   after a few minutes to see it polling cleanly.
6. Delete the test capture from Drive and, if you want it gone from the site too, run the
   **prune-booth** workflow (see below).

Doing this dry run once end-to-end is the single best way to catch a mis-shared folder, a wrong
folder ID, or a wrong local path before guests are relying on it.

---

## 6. Timing & expectations on the day

- **Near-real-time by default.** The cron job polls every few minutes; new captures normally
  appear on the site **within a few minutes** of being taken.
- **Scheduled cron is a backstop.** `sync-booth.yml` also runs on a cron, so even if the booth
  PC's upload job or its trigger call fails, everything still gets picked up on the next
  scheduled run.
- **Manual run always available.** You can also start **sync-booth** from the Actions tab at
  any time; it picks up everything in the folder so far and deploys.
- **The sync is idempotent.** Re-running only processes *new* captures, so the polling job,
  the site cron, and manual runs never duplicate or collide.
- **If instant updates stop working**, either the booth PC's upload job stalled or the token
  expired — see the troubleshooting table. Photos will still arrive on the next scheduled cron
  in the meantime.

---

## 7. Removing booth photos later

Pruning is **manual and defaults to a dry run** for safety:

- Delete the unwanted capture(s) from the booth Drive folder.
- Run the **prune-booth** workflow (GitHub → Actions → “prune-booth” → Run workflow).
  - It lists what *would* be removed first (dry run).
  - Re-run with the dry-run option disabled to actually remove the manifest/thumbnail entries.
- **Safety guard:** the pruner refuses to delete anything if Drive returns zero images, so a
  transient API hiccup can't wipe the booth gallery.

> If a photo is still in Photobooth's **local** folder, the polling job will just re-upload it
> on the next run. Remove it locally too (or `rclone`-exclude it) if you want it gone for good.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Booth photos never appear on the site | Wrong `BOOTH_DRIVE_FOLDER_ID`, or the read service account isn't shared on the folder | Re-check the folder ID and share the folder with the SA `client_email` |
| Nothing uploads from the booth PC | Cron job not installed, wrong `BOOTH_LOCAL_DIR`, or `rclone` not authorized | Check `crontab -l`, verify the local path, and run `/opt/booth/upload.sh` by hand to see the error |
| Booth photos show up in the **guest** gallery | Uploaded to the guest folder, or `photobooth.html` isn't setting `MANIFEST_URL`/`THUMB_DIR` | Point the cron job at the booth folder; confirm the page's inline `<script>` sets the booth manifest/thumb dir |
| A capture appears but has no thumbnail | Non-image or corrupt file uploaded | Ensure the upload job only includes standard JPEGs |
| Uploads used to appear instantly, now only on the schedule | Fine-grained PAT expired/revoked, or the PC lost internet | Generate a new fine-grained PAT (repo-only, Actions read & write) and update it in the booth PC's env; check connectivity |
| Instant trigger never worked at all | Token missing/wrong scope, or wrong repo | Confirm the PAT targets the site repo with **Actions: read & write**, and that the job calls the right workflow |
| Same photo uploaded repeatedly | Upload step isn't skipping existing files | Use `rclone copy` (not `rclone copyto` on a fixed name); it skips files already in Drive |
| Deleted a photo from Drive but it's still on the site | Manifest/thumbnail still committed | Run the **prune-booth** workflow |

---

Booth is intentionally decoupled: it only has to poll a local folder and drop JPEGs into one
Drive folder. Everything downstream — thumbnails, manifest, deploy — is handled by the
website's existing pipeline.
