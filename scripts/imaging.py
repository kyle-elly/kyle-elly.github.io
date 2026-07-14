#!/usr/bin/env python3
"""Shared image processing for guest and booth gallery sync workflows.

Single source of truth for thumbnail/large-image sizing, quality, and
JPEG encoding parameters. Both sync_gallery.py (guest photos from Drive)
and sync_booth.py (booth photos from Drive) import from this module to
guarantee visually identical output across both pipelines.
"""

import io
from pathlib import Path

from PIL import Image, ImageOps
from pillow_heif import register_heif_opener

# Register HEIC support once at import time. Idempotent — safe if the
# caller also calls it, but callers no longer need to.
register_heif_opener()

# ---- Public constants -------------------------------------------------
# These define the "look" of the gallery. Change here → both pipelines
# regenerate matching output on next run.

THUMB_MAX = 400   # max edge, px, for grid thumbnails
LARGE_MAX = 800   # max edge, px, for lightbox images
THUMB_Q   = 78    # JPEG quality for thumbnails (barely visible < 80)
LARGE_Q   = 85    # JPEG quality for lightbox
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

def make_variants(raw: bytes,
                  out_id: str,
                  thumb_dir: Path,
                  large_dir: Path) -> tuple[int, int]:
    """Generate the 400px thumbnail and 800px large variant from source bytes.

    Args:
        raw:       Original image bytes (JPEG/PNG/HEIC/etc.).
        out_id:    Base filename (without extension). Output files will
                   be written as {out_id}.jpg in each directory.
        thumb_dir: Destination directory for the 400px thumbnail.
        large_dir: Destination directory for the 800px large image.

    Returns:
        (width, height) of the *large* variant, for manifest metadata.

    Raises:
        PIL.UnidentifiedImageError: bytes are not a decodable image.
        OSError: image is truncated or otherwise unreadable.
    """
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im)   # honor camera rotation
        im = im.convert("RGB")             # HEIC/PNG alpha → JPEG-safe

        # 800px lightbox variant (written first so its dimensions are
        # what goes in the manifest even if the thumb write fails)
        large = im.copy()
        large.thumbnail((LARGE_MAX, LARGE_MAX), RESAMPLE)
        large_dir.mkdir(parents=True, exist_ok=True)
        large.save(large_dir / f"{out_id}.jpg", quality=LARGE_Q, **JPEG_KWARGS)
        w, h = large.size

        # 400px grid variant
        small = im.copy()
        small.thumbnail((THUMB_MAX, THUMB_MAX), RESAMPLE)
        thumb_dir.mkdir(parents=True, exist_ok=True)
        small.save(thumb_dir / f"{out_id}.jpg", quality=THUMB_Q, **JPEG_KWARGS)

        return w, h
