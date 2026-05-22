#!/usr/bin/env python3
"""
make-drop-poster.py — static PNG poster for Twitter cards / OG / share.

Two outputs:
  bioms-poster-wide.png   1200×630   Twitter summary_large_image card
  bioms-poster-square.png 1080×1080  Instagram-style square

Both: petri dish row composition + minimal type, brand cream palette.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_WIDE   = Path("/Users/okynata/Desktop/bioms-poster-wide.png")
OUT_SQUARE = Path("/Users/okynata/Desktop/bioms-poster-square.png")
PNG_DIR    = Path("/Users/okynata/Desktop/bioms/pngs/preview")

BG    = (236, 233, 224)
PAPER = (244, 241, 232)
INK   = (28, 26, 22)
INK_2 = (91, 85, 74)

# 4 dishes hand-picked for visual range (purple, green, pink, ghost)
SEEDS_WIDE   = [44, 132, 247, 1500]
# Square poster gets a tighter 3-pack
SEEDS_SQUARE = [44, 247, 1500]

def render_dish(seed, size):
    """Return RGBA petri-dish layer of `size`×`size` with biom inside."""
    layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    R = max(24, size // 16)  # corner radius

    # Drop shadow
    sh = Image.new('RGBA', (size, size + 30), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sh)
    sd.rounded_rectangle((0, 16, size, size + 16), radius=R, fill=(28, 26, 22, 70))
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    layer.alpha_composite(sh, dest=(0, 0))

    # Agar
    body = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(body)
    bd.rounded_rectangle((0, 0, size, size), radius=R, fill=PAPER + (255,))
    mask = body.split()[3]
    # Top-to-bottom subtle gradient
    grad = Image.new('RGB', (1, size), 0)
    for y in range(size):
        t = y / size
        r = int(PAPER[0] * (1 - t) + 235 * t)
        g = int(PAPER[1] * (1 - t) + 231 * t)
        b = int(PAPER[2] * (1 - t) + 221 * t)
        grad.putpixel((0, y), (r, g, b))
    grad = grad.resize((size, size)).convert('RGBA')
    grad_m = Image.composite(grad, Image.new('RGBA', (size, size), (0,0,0,0)), mask)
    layer = Image.alpha_composite(layer, grad_m)

    # Top catch-light
    catch = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    cd = ImageDraw.Draw(catch)
    cx, cy = size // 2, size // 8
    catch_r = size // 3
    cd.ellipse((cx - catch_r, cy - catch_r // 2, cx + catch_r, cy + catch_r // 2),
               fill=(255, 255, 255, 70))
    catch = catch.filter(ImageFilter.GaussianBlur(max(20, size // 18)))
    catch_m = Image.composite(catch, Image.new('RGBA', (size, size), (0,0,0,0)), mask)
    layer = Image.alpha_composite(layer, catch_m)

    # Biom centered inside
    biom_inset = size // 12
    biom_target = size - 2 * biom_inset
    biom = Image.open(PNG_DIR / f"{seed:05d}.png").convert('RGBA')
    biom = biom.resize((biom_target, biom_target), Image.LANCZOS)
    layer.paste(biom, (biom_inset, biom_inset), biom)

    # Outer rim
    rim = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    rd = ImageDraw.Draw(rim)
    rd.rounded_rectangle((0, 0, size - 1, size - 1), radius=R, outline=(28,26,22,40), width=2)
    layer = Image.alpha_composite(layer, rim)

    # Inner glass ring
    inner = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ind = ImageDraw.Draw(inner)
    ind.rounded_rectangle((2, 2, size - 3, size - 3), radius=R - 2, outline=(255,255,255,160), width=1)
    layer = Image.alpha_composite(layer, inner)

    return layer

def find_font(size, weight='regular'):
    """Pick a reasonable system font for the poster type. Falls back
    to PIL default if SF/Helvetica aren't available."""
    candidates = [
        '/System/Library/Fonts/Helvetica.ttc',
        '/System/Library/Fonts/SFNS.ttf',
        '/Library/Fonts/Arial.ttf',
        '/System/Library/Fonts/Supplemental/Arial.ttf',
    ]
    for path in candidates:
        try:
            return ImageFont.truetype(path, size)
        except Exception:
            continue
    return ImageFont.load_default()

def render_wide():
    """1200×630 — Twitter summary_large_image."""
    canvas = Image.new('RGB', (1200, 630), BG)
    W, H = canvas.size

    # 4 dishes in a row, centered horizontally, vertically centered
    DISH = 360
    GAP  = 32
    total_w = len(SEEDS_WIDE) * DISH + (len(SEEDS_WIDE) - 1) * GAP
    x0 = (W - total_w) // 2
    y0 = (H - DISH) // 2 + 30  # slight downward bias to leave room for type above

    # "Bioms" wordmark top-center
    font_brand = find_font(54)
    d = ImageDraw.Draw(canvas)
    bbox = d.textbbox((0, 0), 'Bioms', font=font_brand)
    text_w = bbox[2] - bbox[0]
    d.text(((W - text_w) // 2, 56), 'Bioms', font=font_brand, fill=INK)

    # Tagline under wordmark
    font_tag = find_font(20)
    tag = 'Three thousand living microbes. On Ethereum.'
    bbox = d.textbbox((0, 0), tag, font=font_tag)
    tw = bbox[2] - bbox[0]
    d.text(((W - tw) // 2, 120), tag, font=font_tag, fill=INK_2)

    # Dishes
    for i, seed in enumerate(SEEDS_WIDE):
        dish = render_dish(seed, DISH)
        canvas.paste(dish, (x0 + i * (DISH + GAP), y0), dish)

    canvas.save(OUT_WIDE, optimize=True)
    print(f"  ✓ {OUT_WIDE.name}  ({OUT_WIDE.stat().st_size / 1024:.0f} KB)")

def render_square():
    """1080×1080 — square card for Instagram, X feed scrolling, etc."""
    canvas = Image.new('RGB', (1080, 1080), BG)
    W, H = canvas.size

    # 3 dishes in a row, centered
    DISH = 280
    GAP  = 40
    total_w = len(SEEDS_SQUARE) * DISH + (len(SEEDS_SQUARE) - 1) * GAP
    x0 = (W - total_w) // 2
    y0 = (H - DISH) // 2 + 40

    # Bigger wordmark + tagline pair
    d = ImageDraw.Draw(canvas)
    font_brand = find_font(78)
    bbox = d.textbbox((0, 0), 'Bioms', font=font_brand)
    text_w = bbox[2] - bbox[0]
    d.text(((W - text_w) // 2, 140), 'Bioms', font=font_brand, fill=INK)

    font_tag = find_font(22)
    tag = 'Three thousand living microbes. On Ethereum.'
    bbox = d.textbbox((0, 0), tag, font=font_tag)
    tw = bbox[2] - bbox[0]
    d.text(((W - tw) // 2, 230), tag, font=font_tag, fill=INK_2)

    # Dishes
    for i, seed in enumerate(SEEDS_SQUARE):
        dish = render_dish(seed, DISH)
        canvas.paste(dish, (x0 + i * (DISH + GAP), y0), dish)

    # Footer URL
    font_url = find_font(18)
    bbox = d.textbbox((0, 0), 'thebioms.com', font=font_url)
    uw = bbox[2] - bbox[0]
    d.text(((W - uw) // 2, H - 80), 'thebioms.com', font=font_url, fill=INK_2)

    canvas.save(OUT_SQUARE, optimize=True)
    print(f"  ✓ {OUT_SQUARE.name}  ({OUT_SQUARE.stat().st_size / 1024:.0f} KB)")

if __name__ == '__main__':
    print('  → rendering wide poster …')
    render_wide()
    print('  → rendering square poster …')
    render_square()
