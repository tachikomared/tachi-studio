#!/usr/bin/env python3
# Extracts full-silhouette left/right crab-claw PNGs from the hero art, with a
# feathered inner edge, and verifies no border has a straight (over-opaque) cut.
"""Cut claw-left.png / claw-right.png out of hero-source.png — FULL silhouettes.

Why this script exists
----------------------
The first pair of claw strips were plain rectangular crops of the hero art
(`hero[55:901, 55:345]` and its mirror). Two things were wrong with them:

  1. The crop ran THROUGH the app window drawn in the hero. The window's own
     dark 2px frame (hero columns x≈339-349 / x≈1241-1249) was baked into the
     strip, so the art carried a 740px fully-opaque black bar down its inner
     border — a straight wall that painted over the real UI.
  2. Because that wall was unhideable, the renderer masked 56px off the inner
     edge. The limb then evaporated ~56px BEFORE it reached the app plate, so
     the claws read as severed stumps floating next to the window instead of
     limbs reaching behind it.

This script fixes both by (a) cutting strictly OUTSIDE the drawn window — left
of the frame for the left claw, right of it for the right claw — so no window
pixels survive, and (b) baking a short alpha ramp on that inner edge so the
limb dissolves exactly where it slides behind the app plate. Everything else
(the whole pincer, both legs, every blade tip) is kept at full opacity with a
natural, anti-aliased outline.

Background removal is a FLOOD FILL from the crop border through near-white
pixels, not a global white threshold: the crab's armour is white too, and a
threshold punches holes straight through it.

Run (from anywhere):
    python apps/desktop/src/assets/crab/extract-claws.py

It rewrites claw-left.png / claw-right.png in place and prints a verification
table of the per-border contiguous fully-opaque runs. THE CONTRACT: no border
of either output may carry a contiguous fully-opaque run longer than
MAX_BORDER_RUN_PX — that is what "no straight cut" means, measured.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

HERE = Path(__file__).resolve().parent
HERO = HERE / "hero-source.png"

# ── Source geometry (measured on hero-source.png, 1586x992) ──────────────────
# The app window drawn in the hero occupies x≈339..1249. Its frame is a dark
# near-vertical line: columns 339-349 on the left, 1241-1249 on the right (at
# rows below the crab, x=330..338 and x=1250..1260 are clean background). The
# claws are therefore everything strictly outside those two columns.
PLATE_LEFT_X = 339   # first hero column that belongs to the window frame
PLATE_RIGHT_X = 1250  # first hero column right of the window frame

# ── Alpha extraction ─────────────────────────────────────────────────────────
# A pixel is background only if it is near-white AND flood-connected to the
# crop border. WHITE_HI/WHITE_LO drive the ~2px anti-aliased edge ramp.
BG_SEED = 240
WHITE_HI = 246
WHITE_LO = 232
# Speckle floor: the hero has a handful of 1-2px JPEG-ish crumbs.
MIN_COMPONENT_PX = 600

# Width (px, source scale) of the alpha ramp baked onto the INNER edge — the
# side that meets the app window. At the render scale used by CrabChrome
# (~0.62) this is ~16 rendered px, i.e. exactly the tip that crosses the plate,
# so the limb is solid everywhere in the transparent gutter and only dissolves
# once it is over the plate.
INNER_RAMP_PX = 26

# Contract: the longest contiguous run of fully-opaque pixels allowed on any
# border of an output PNG. Anything longer is a straight cut.
MAX_BORDER_RUN_PX = 40


def load_hero() -> np.ndarray:
    if not HERO.exists():
        raise SystemExit(f"missing hero art: {HERO}")
    return np.array(Image.open(HERO).convert("RGB")).astype(np.int16)


def alpha_from_region(rgb: np.ndarray) -> np.ndarray:
    """Float alpha (0..1) for one cropped region of the hero.

    Background = near-white pixels flood-connected to the crop border. Pockets
    that only escaped through the window (the gaps between arm and legs on the
    plate side) open onto the crop border after the cut, so they drop out too.
    Enclosed near-white regions are ARMOUR, and stay opaque.
    """
    mn = rgb.min(axis=2)
    near_white = mn >= BG_SEED
    lbl, _ = ndimage.label(near_white)
    border_ids = set(lbl[0, :]) | set(lbl[-1, :]) | set(lbl[:, 0]) | set(lbl[:, -1])
    border_ids.discard(0)
    bg = np.isin(lbl, sorted(border_ids))
    fg = ~bg

    # Drop crumbs so autocrop can't be dragged out by a stray pixel.
    lbl_fg, n = ndimage.label(fg)
    if n:
        sizes = np.bincount(lbl_fg.ravel())
        keep = np.zeros(sizes.shape, dtype=bool)
        keep[1:] = sizes[1:] >= MIN_COMPONENT_PX
        fg = keep[lbl_fg]

    # ~2px anti-aliased rim: how far a pixel is from paper-white. Interior
    # pixels are forced solid so white armour never turns translucent.
    soft = np.clip((WHITE_HI - mn) / float(WHITE_HI - WHITE_LO), 0.0, 1.0)
    interior = ndimage.binary_erosion(fg, iterations=2, border_value=1)
    alpha = np.where(interior, 1.0, np.where(fg, soft, 0.0))
    return alpha.astype(np.float32)


def inner_ramp(width: int, side: str) -> np.ndarray:
    """Column multiplier that fades the plate-facing edge to zero."""
    x = np.arange(width, dtype=np.float32)
    if side == "left":
        # inner edge = right border of the crop
        ramp = (width - 1 - x) / float(INNER_RAMP_PX)
    else:
        # inner edge = left border of the crop
        ramp = x / float(INNER_RAMP_PX)
    return np.clip(ramp, 0.0, 1.0)


def autocrop(rgb: np.ndarray, alpha: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    ys, xs = np.where(alpha > 0.0)
    if len(ys) == 0:
        raise SystemExit("extraction produced an empty image")
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1
    return rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1]


def extract(hero: np.ndarray, side: str) -> Image.Image:
    if side == "left":
        region = hero[:, :PLATE_LEFT_X]
    else:
        region = hero[:, PLATE_RIGHT_X:]
    alpha = alpha_from_region(region)
    alpha = alpha * inner_ramp(alpha.shape[1], side)[None, :]
    rgb, alpha = autocrop(region, alpha)

    out = np.zeros((*alpha.shape, 4), dtype=np.uint8)
    out[:, :, :3] = np.clip(rgb, 0, 255).astype(np.uint8)
    out[:, :, 3] = np.rint(alpha * 255.0).astype(np.uint8)
    return Image.fromarray(out)


# ── Verification ─────────────────────────────────────────────────────────────

def longest_opaque_run(vec: np.ndarray) -> int:
    solid = vec >= 255
    best = run = 0
    for v in solid:
        run = run + 1 if v else 0
        best = max(best, run)
    return best


def border_runs(img: Image.Image) -> dict[str, tuple[int, int]]:
    a = np.array(img)[:, :, 3]
    return {
        "top": (longest_opaque_run(a[0, :]), a.shape[1]),
        "bottom": (longest_opaque_run(a[-1, :]), a.shape[1]),
        "left": (longest_opaque_run(a[:, 0]), a.shape[0]),
        "right": (longest_opaque_run(a[:, -1]), a.shape[0]),
    }


def main() -> int:
    hero = load_hero()
    failures: list[str] = []
    print(f"hero {HERO.name}: {hero.shape[1]}x{hero.shape[0]}")
    print(f"cut: left claw = x < {PLATE_LEFT_X}, right claw = x >= {PLATE_RIGHT_X} "
          f"(app-window frame excluded), inner ramp {INNER_RAMP_PX}px\n")
    print(f"{'file':<16}{'size':>12}{'w/h':>8}   " + "  ".join(f"{b:>14}" for b in ("top", "bottom", "left", "right")))
    print("-" * 96)

    for side in ("left", "right"):
        img = extract(hero, side)
        path = HERE / f"claw-{side}.png"
        img.save(path, optimize=True)
        runs = border_runs(img)
        w, h = img.size
        cells = []
        for border in ("top", "bottom", "left", "right"):
            run, span = runs[border]
            flag = "!" if run > MAX_BORDER_RUN_PX else " "
            cells.append(f"{run:>5}/{span:<5}{flag}".rjust(14))
            if run > MAX_BORDER_RUN_PX:
                failures.append(f"claw-{side}.png {border} border: {run}px opaque run")
        print(f"{path.name:<16}{f'{w}x{h}':>12}{w / h:>8.3f}   " + "  ".join(cells))

    print("-" * 96)
    print(f"contract: no border may hold a contiguous fully-opaque run > {MAX_BORDER_RUN_PX}px")
    if failures:
        for f in failures:
            print(f"  FAIL {f}")
        return 1
    print("  PASS - every border is a natural, feathered outline")
    return 0


if __name__ == "__main__":
    sys.exit(main())
