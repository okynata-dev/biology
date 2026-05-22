#!/usr/bin/env python3
"""
make-drop-counter.py — 3×3 petri-dish grid montage.

A wider 1920×1080 video showing 9 dishes lined up on a lab counter,
each containing a different biom. Subtle ambient drift (slow scale
breathing per dish, offset phases) — the kind of motion a real
microscope view has when nothing is "happening" but the world is
alive.

Output: /Users/okynata/Desktop/bioms-counter-grid.mp4
"""

import math
import shutil
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

W, H = 1920, 1080
FPS = 30
DURATION_S = 10
TOTAL = FPS * DURATION_S

# 9 hand-picked dishes — varied morphologies so the grid reads as a
# range, not "9 of the same thing".
SEEDS = [44, 132, 2, 247, 38, 64, 156, 1500, 2222]

BG    = (236, 233, 224, 255)
PAPER = (244, 241, 232)
AGAR_T = (244, 241, 232)
AGAR_B = (235, 231, 221)

PNG_DIR = Path("/Users/okynata/Desktop/bioms/pngs/preview")
OUT = Path("/Users/okynata/Desktop/bioms-counter-grid.mp4")

# Layout: 3 cols × 3 rows centered, with breathing room
COLS, ROWS = 3, 3
GAP = 36
DISH_W = (W - GAP * (COLS + 1)) // COLS  # ≈ 600
DISH_H = (H - GAP * (ROWS + 1)) // ROWS  # ≈ 320
# Force square dishes (smaller dimension wins)
DISH_SIZE = min(DISH_W, DISH_H)
# Recompute centered grid
GRID_W = COLS * DISH_SIZE + (COLS - 1) * GAP
GRID_H = ROWS * DISH_SIZE + (ROWS - 1) * GAP
OFF_X = (W - GRID_W) // 2
OFF_Y = (H - GRID_H) // 2

DISH_R = 36
BIOM_INSET = 32   # rim of agar around each biom

def make_one_dish_template(size):
    """One reusable dish template (no biom yet). Returns RGBA layer."""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))

    # Drop shadow
    sh = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle((0, 12, size, size), radius=DISH_R, fill=(28, 26, 22, 60))
    sh = sh.filter(ImageFilter.GaussianBlur(18))
    layer = Image.alpha_composite(layer, sh)

    # Agar
    body = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle((0, 0, size, size), radius=DISH_R, fill=PAPER + (255,))
    mask = body.split()[3]
    # Gradient
    grad = Image.new('RGB', (1, size), 0)
    for y in range(size):
        t = y / size
        r = int(AGAR_T[0] * (1 - t) + AGAR_B[0] * t)
        g = int(AGAR_T[1] * (1 - t) + AGAR_B[1] * t)
        b = int(AGAR_T[2] * (1 - t) + AGAR_B[2] * t)
        grad.putpixel((0, y), (r, g, b))
    grad = grad.resize((size, size)).convert('RGBA')
    grad_masked = Image.composite(grad, Image.new('RGBA', (size, size), (0,0,0,0)), mask)
    layer = Image.alpha_composite(layer, grad_masked)

    # Top catch-light
    catch = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(catch)
    cx, cy = size // 2, 60
    cd.ellipse((cx - 200, cy - 100, cx + 200, cy + 100), fill=(255, 255, 255, 60))
    catch = catch.filter(ImageFilter.GaussianBlur(40))
    catch_masked = Image.composite(catch, Image.new('RGBA', (size, size), (0,0,0,0)), mask)
    layer = Image.alpha_composite(layer, catch_masked)

    # Outer rim
    rim = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle((0, 0, size - 1, size - 1), radius=DISH_R, outline=(28,26,22,40), width=2)
    layer = Image.alpha_composite(layer, rim)

    # Inner glass
    inner = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ind = ImageDraw.Draw(inner)
    ind.rounded_rectangle((2, 2, size - 3, size - 3), radius=DISH_R - 2, outline=(255,255,255,160), width=1)
    layer = Image.alpha_composite(layer, inner)
    return layer

def load_biom_scaled(seed, target):
    p = PNG_DIR / f"{seed:05d}.png"
    img = Image.open(p).convert('RGBA')
    return img.resize((target, target), Image.LANCZOS)

def render_frame(petri_template, bioms, frame_idx):
    # Plain cream background
    canvas = Image.new('RGBA', (W, H), BG)

    # Each dish gets its own slow breathing phase (cos wave at 0.4Hz
    # offset by index×0.7 radians). Scale 0.985..1.015 — sub-2% in
    # either direction, barely perceptible per-frame but adds life.
    for i, seed in enumerate(SEEDS):
        col = i % COLS
        row = i // COLS
        x = OFF_X + col * (DISH_SIZE + GAP)
        y = OFF_Y + row * (DISH_SIZE + GAP)

        # Composite dish + biom
        # Breathing transform: tiny vertical bob (±1.5px) + scale (±1%)
        t = frame_idx / FPS  # seconds
        bob_y = math.sin(t * 0.8 + i * 0.7) * 1.5
        scale = 1 + math.sin(t * 0.6 + i * 1.1) * 0.012

        # Compose this cell on a transparent canvas first
        cell = Image.new('RGBA', (DISH_SIZE, DISH_SIZE), (0, 0, 0, 0))
        cell = Image.alpha_composite(cell, petri_template)
        # Biom inside (with scale)
        biom_size_base = DISH_SIZE - 2 * BIOM_INSET
        biom_size = int(biom_size_base * scale)
        biom_size = max(1, biom_size)
        biom_img = bioms[i].resize((biom_size, biom_size), Image.LANCZOS)
        bx = (DISH_SIZE - biom_size) // 2
        by = (DISH_SIZE - biom_size) // 2
        cell.paste(biom_img, (bx, by), biom_img)

        # Place cell on the canvas with vertical bob
        canvas.alpha_composite(cell, dest=(x, int(y + bob_y)))

    return canvas.convert('RGB')

def main():
    tmp = Path('/tmp/bioms-counter-frames')
    if tmp.exists():
        shutil.rmtree(tmp)
    tmp.mkdir(parents=True)

    print(f"  → dish template (1×, {DISH_SIZE}×{DISH_SIZE}) …")
    template = make_one_dish_template(DISH_SIZE)

    print(f"  → loading {len(SEEDS)} bioms …")
    biom_target = DISH_SIZE - 2 * BIOM_INSET
    bioms = [load_biom_scaled(s, biom_target) for s in SEEDS]

    print(f"  → rendering {TOTAL} frames …")
    for i in range(TOTAL):
        frame = render_frame(template, bioms, i)
        frame.save(tmp / f"{i:05d}.png", optimize=False)
        if (i + 1) % 30 == 0:
            print(f"     {i+1}/{TOTAL}")

    print("  → ffmpeg → MP4 …")
    if OUT.exists():
        OUT.unlink()
    subprocess.check_call([
        '/opt/homebrew/bin/ffmpeg', '-y',
        '-framerate', str(FPS),
        '-i', str(tmp / '%05d.png'),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-crf', '19',
        '-preset', 'medium',
        '-movflags', '+faststart',
        str(OUT),
    ])
    print(f"  ✓ saved → {OUT}  ({OUT.stat().st_size / 1024 / 1024:.1f} MB)")
    shutil.rmtree(tmp)

if __name__ == '__main__':
    main()
