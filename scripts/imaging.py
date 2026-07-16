#!/usr/bin/env python3
"""Shared image processing for guest and booth gallery sync workflows.

Single source of truth for thumbnail sizing, quality, and JPEG encoding
parameters. Both sync_gallery.py (guest photos from Drive) and
sync_booth.py (booth photos from Drive) import from this module to
guarantee visually identical output across both pipelines.

Lightbox/large images are served directly from the Drive CDN
(lh3.googleusercontent.com/d/<id>=w####) at view time, so we no longer
generate a `large/` directory on disk.
"""

import io
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

# Register HEIC support once at import time. Idempotent — safe if the
# caller also calls it, but callers no longer need to.
register_heif_opener()

# ---- Public constants -------------------------------------------------
# These define the "look" of the gallery grid. Change here → both
# pipelines regenerate matching output on next run.
#
# Lightbox images are served from Drive at =w1200 / =w1600 / =w2048
# via srcset in gallery.js; no build-side setting controls them.

THUMB_MAX = 600   # max edge, px, for grid thumbnails
THUMB_Q   = 78    # JPEG quality for thumbnails (barely visible < 80)
JPEG_KWARGS = {
    "format": "JPEG",
    "optimize": True,
    "progressive": True,
}

# Resampling filter — LANCZOS is best quality for downscaling.
# Pillow 10+ moved the enum; fall back for older versions.
try:
    RESAMPLE = Image.Resampling.LANCZOS
except AttributeError:  # Pillow < 10
    RESAMPLE = Image.LANCZOS


# ---- Public API -------------------------------------------------------

def make_thumbnail(raw: bytes,
                   out_id: str,
                   thumb_dir: Path) -> tuple[int, int]:
    """Generate the 600px grid thumbnail from source bytes.

    Args:
        raw:       Original image bytes (JPEG/PNG/HEIC/etc.).
        out_id:    Base filename (without extension). Output will be
                   written as {out_id}.jpg in thumb_dir.
        thumb_dir: Destination directory for the 400px thumbnail.

    Returns:
        (width, height) of the *original* image, for manifest metadata.
        This is used by the frontend to compute aspect ratios / reserve
        grid space before the thumbnail loads. The lightbox itself
        pulls sized versions from the Drive CDN, so we no longer need
        to report a "large" size here.

    Raises:
        PIL.UnidentifiedImageError: bytes are not a decodable image.
        OSError: image is truncated or otherwise unreadable.
    """
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im)   # honor camera rotation
        im = im.convert("RGB")             # HEIC/PNG alpha → JPEG-safe

        # Capture original dimensions before downscaling — useful for
        # aspect-ratio hints in the manifest.
        orig_w, orig_h = im.size

        # 400px grid variant
        small = im.copy()
        small.thumbnail((THUMB_MAX, THUMB_MAX), RESAMPLE)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        small.save(thumb_dir / f"{out_id}.jpg", quality=THUMB_Q, **JPEG_KWARGS)

        return orig_w, orig_h
