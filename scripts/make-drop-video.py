#!/usr/bin/env python3
"""
make-drop-video.py — generate a Twitter-ready drop announcement video.

Renders a Petri-dish frame (matching the site's brand language) with
a sequence of bioms cross-fading inside. 1080×1080, 30fps, ~12s.

  python3 make-drop-video.py            # generates default cycle
  python3 make-drop-video.py --counter  # 3×3 grid montage variant

Output: /Users/okynata/Desktop/bioms-specimens-cycle.mp4
"""

import os
import sys
import math
import shutil
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

# ---------------- Configuration ----------------

# Square 1080 — Twitter timeline favourite. Crops cleanly into 4:5 cards.
SIZE = 1080
FPS = 30
DURATION_PER_BIOM_S = 1.4   # stable display
CROSSFADE_S         = 0.5   # blend between specimens
# Curated handful — picked for visual diversity (colours, morphologies,
# rare anomalies). Matches the landing-page catalog seed list to avoid
# revealing tokens that don't already appear publicly.
SEEDS = [44, 132, 2, 247, 38, 156, 1500, 2222]

# Brand palette (mirrors design.css)
BG     = (236, 233, 224)   # --bg cream
PAPER  = (244, 241, 232)   # --paper
INK    = (28, 26, 22)      # --ink
AGAR_T = (244, 241, 232)   # agar top of gradient
AGAR_B = (235, 231, 221)   # agar bottom of gradient

# Where the local 3000×3000 masters live
PNG_DIR = Path("/Users/okynata/Desktop/bioms/pngs/preview")
OUT_PATH = Path("/Users/okynata/Desktop/bioms-specimens-cycle.mp4")

# Petri dish geometry inside the 1080 square
DISH_INSET = 90           # px from each edge to the dish outer
DISH_R     = 56           # corner radius (square-ish dish for shareability)
BIOM_INSET = DISH_INSET + 60  # specimen sits inside the rim

# ---------------- Frame composition ----------------

def make_petri_dish_layer():
    """Pre-render the Petri dish (without the biom) on a transparent
    layer so we can composite it once and reuse for every frame. This
    is the expensive operation — drop shadow, gradient, rim — so we
    cache it. The biom is just an alpha-paste on top inside the rim."""
    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))

    # 1. Drop shadow — gaussian-blurred dish silhouette offset down.
    shadow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle(
        (DISH_INSET, DISH_INSET + 20, SIZE - DISH_INSET, SIZE - DISH_INSET + 20),
        radius=DISH_R, fill=(28, 26, 22, 80),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(36))
    layer = Image.alpha_composite(layer, shadow)

    # 2. Dish body — agar gradient inside the rounded rect.
    body = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    # Background fill (will be replaced by gradient via mask compositing).
    bd.rounded_rectangle(
        (DISH_INSET, DISH_INSET, SIZE - DISH_INSET, SIZE - DISH_INSET),
        radius=DISH_R, fill=PAPER + (255,),
    )
    # Vertical agar gradient via row-by-row paint inside the same shape.
    grad = Image.new('RGB', (1, SIZE), 0)
    for y in range(SIZE):
        t = max(0, min(1, (y - DISH_INSET) / (SIZE - 2 * DISH_INSET)))
        r = int(AGAR_T[0] * (1 - t) + AGAR_B[0] * t)
        g = int(AGAR_T[1] * (1 - t) + AGAR_B[1] * t)
        b = int(AGAR_T[2] * (1 - t) + AGAR_B[2] * t)
        grad.putpixel((0, y), (r, g, b))
    grad = grad.resize((SIZE, SIZE))
    grad_rgba = grad.convert('RGBA')
    # Use body's alpha as a mask so the gradient only fills the dish area.
    mask = body.split()[3]
    body_with_grad = Image.composite(grad_rgba, Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0)), mask)
    layer = Image.alpha_composite(layer, body_with_grad)

    # 3. Top catch-light — soft white radial in the upper third.
    catch = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    cd = ImageDraw.Draw(catch)
    cx, cy = SIZE // 2, DISH_INSET + 140
    cd.ellipse((cx - 380, cy - 200, cx + 380, cy + 200), fill=(255, 255, 255, 70))
    catch = catch.filter(ImageFilter.GaussianBlur(60))
    catch_masked = Image.composite(catch, Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0)), mask)
    layer = Image.alpha_composite(layer, catch_masked)

    # 4. Outer rim — 2px warm ink hairline.
    rim = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle(
        (DISH_INSET, DISH_INSET, SIZE - DISH_INSET, SIZE - DISH_INSET),
        radius=DISH_R, outline=(28, 26, 22, 36), width=2,
    )
    layer = Image.alpha_composite(layer, rim)

    # 5. Inner glass ring — 1px white hairline just inside the rim.
    inner = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    ind = ImageDraw.Draw(inner)
    ind.rounded_rectangle(
        (DISH_INSET + 2, DISH_INSET + 2, SIZE - DISH_INSET - 2, SIZE - DISH_INSET - 2),
        radius=DISH_R - 2, outline=(255, 255, 255, 150), width=1,
    )
    layer = Image.alpha_composite(layer, inner)

    return layer

def load_biom(seed):
    """Load a biom PNG and downscale to fit inside the dish rim."""
    p = PNG_DIR / f"{seed:05d}.png"
    if not p.exists():
        sys.exit(f"missing: {p}")
    img = Image.open(p).convert('RGBA')
    # Target square — fit inside (SIZE - 2*BIOM_INSET) box.
    target = SIZE - 2 * BIOM_INSET
    img = img.resize((target, target), Image.LANCZOS)
    return img

def make_biom_layer(biom_img, alpha=255):
    """Place a biom image centered inside the dish at given alpha."""
    layer = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    if alpha < 255:
        # Multiply alpha channel by ratio
        r, g, b, a = biom_img.split()
        a = a.point(lambda v: int(v * alpha / 255))
        biom_img = Image.merge('RGBA', (r, g, b, a))
    layer.paste(biom_img, (BIOM_INSET, BIOM_INSET), biom_img)
    return layer

def render_frame(petri, bioms_loaded, frame_idx, total_frames, frames_per_cycle, fade_frames):
    """Render one frame: cream bg + petri + biom(s) blended."""
    cycle = (frame_idx // frames_per_cycle) % len(SEEDS)
    within = frame_idx % frames_per_cycle

    # Background
    bg = Image.new('RGBA', (SIZE, SIZE), BG + (255,))

    # Petri dish
    bg = Image.alpha_composite(bg, petri)

    # Biom layer — last `fade_frames` of each cycle blend toward the next
    stable_frames = frames_per_cycle - fade_frames
    biom_a = bioms_loaded[cycle]

    if within < stable_frames:
        # Fully stable
        bg = Image.alpha_composite(bg, make_biom_layer(biom_a, 255))
    else:
        # Crossfade — fade_progress 0..1
        fp = (within - stable_frames) / max(1, fade_frames)
        # Smoother easing (ease-in-out cubic)
        fp = 3 * fp * fp - 2 * fp * fp * fp
        alpha_a = int(255 * (1 - fp))
        alpha_b = int(255 * fp)
        biom_b = bioms_loaded[(cycle + 1) % len(SEEDS)]
        bg = Image.alpha_composite(bg, make_biom_layer(biom_a, alpha_a))
        bg = Image.alpha_composite(bg, make_biom_layer(biom_b, alpha_b))

    return bg.convert('RGB')

# ---------------- Main ----------------

def main():
    out = OUT_PATH
    tmp = Path('/tmp/bioms-drop-frames')
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    print(f"  → pre-rendering petri dish layer ({SIZE}×{SIZE}) …")
    petri = make_petri_dish_layer()

    print(f"  → loading {len(SEEDS)} biom specimens …")
    bioms_loaded = [load_biom(s) for s in SEEDS]

    frames_per_cycle = int((DURATION_PER_BIOM_S + CROSSFADE_S) * FPS)
    fade_frames = int(CROSSFADE_S * FPS)
    total = frames_per_cycle * len(SEEDS)

    print(f"  → rendering {total} frames at {FPS}fps ({total/FPS:.1f}s) …")
    for i in range(total):
        frame = render_frame(petri, bioms_loaded, i, total, frames_per_cycle, fade_frames)
        frame.save(tmp / f"{i:05d}.png", optimize=False)
        if (i + 1) % 30 == 0:
            print(f"     {i+1}/{total}")

    print(f"  → assembling MP4 via ffmpeg …")
    if out.exists():
        out.unlink()
    cmd = [
        '/opt/homebrew/bin/ffmpeg',
        '-y',
        '-framerate', str(FPS),
        '-i', str(tmp / '%05d.png'),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        # CRF 18 = visually lossless. Plenty of detail for the cream
        # palette + biom panels; H.264 handles gradients well at this q.
        '-crf', '18',
        # Tune for visual content with smooth gradients — disables some
        # detail-preserving optimisations that don't help here.
        '-preset', 'medium',
        # Web-optimised: moov atom at the front for instant playback in
        # Twitter / browsers without full-file download.
        '-movflags', '+faststart',
        str(out),
    ]
    subprocess.check_call(cmd)
    print(f"  ✓ saved → {out}  ({out.stat().st_size / 1024 / 1024:.1f} MB)")

    # Clean up frames
    shutil.rmtree(tmp)

if __name__ == '__main__':
    main()
