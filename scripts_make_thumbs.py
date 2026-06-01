#!/usr/bin/env python3
"""
Generate 600×600 WebP+PNG thumbnails from the 3000×3000 master PNGs.

Why:
  Catalog grid on the landing page references R2 master PNGs at full
  resolution (3000×3000, ~6.25MB each). For thumbnails displayed at
  ~250px on screen this is enormous waste — single user scrolling the
  catalog can pull ~75MB of pixels they never see at full res.

  This script downsamples each master to a 600×600 thumb (~30-80KB
  WebP, ~150KB PNG), suitable for the showcase grid. Originals stay
  untouched and remain the source for save-as-PNG, banner downloads,
  and the actual mint-quality NFT image.

Output:
  pngs/thumb/00000.webp ... 02999.webp   (preferred — smaller)
  pngs/thumb/00000.png  ... 02999.png    (fallback for non-WebP)

After running:
  Upload the pngs/thumb/ folder to R2 alongside pngs/preview/:
    npx wrangler r2 object put bioms-bucket/thumb/00000.webp \\
      --file=pngs/thumb/00000.webp

  Or bulk via aws-cli pointed at the R2 S3 endpoint.

Usage:
  python3 scripts_make_thumbs.py               # all 3000
  python3 scripts_make_thumbs.py --only 44,132,2,176,5,247,38,64,156,109,1500,2222
"""

import argparse
import sys
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).parent
SRC = ROOT / 'pngs' / 'preview'
DST = ROOT / 'pngs' / 'thumb'
SIZE = 600

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--only', help='Comma-separated seed list (default: all 3000)')
    p.add_argument('--size', type=int, default=SIZE, help='Output size (default 600)')
    p.add_argument('--webp-quality', type=int, default=85, help='WebP quality 1-100 (default 85)')
    p.add_argument('--skip-png', action='store_true', help='Skip the PNG fallback output')
    args = p.parse_args()

    DST.mkdir(parents=True, exist_ok=True)

    if args.only:
        seeds = [int(s) for s in args.only.split(',')]
    else:
        seeds = list(range(1, 8001))

    done = 0
    skipped = 0
    failed = []
    total = len(seeds)

    for seed in seeds:
        # Masters are WEBP as of the 2026-06 8000 regen; fall back to the
        # legacy PNG master if a webp isn't present.
        src = SRC / f'{seed:05d}.webp'
        if not src.exists():
            src = SRC / f'{seed:05d}.png'
        if not src.exists():
            failed.append(seed)
            continue

        webp_out = DST / f'{seed:05d}.webp'
        png_out = DST / f'{seed:05d}.png'

        # Skip if both already exist and are newer than source.
        if (webp_out.exists() and (args.skip_png or png_out.exists())
                and webp_out.stat().st_mtime > src.stat().st_mtime):
            skipped += 1
            continue

        try:
            img = Image.open(src).convert('RGBA')
            img.thumbnail((args.size, args.size), Image.Resampling.LANCZOS)
            # WebP — smaller, modern browsers.
            img.save(webp_out, 'WEBP', quality=args.webp_quality, method=6)
            # PNG fallback — for marketplaces / old browsers.
            if not args.skip_png:
                img.save(png_out, 'PNG', optimize=True)
            done += 1
        except Exception as e:
            print(f'  [seed {seed}] FAILED: {e}', file=sys.stderr)
            failed.append(seed)

        if done % 50 == 0 and done > 0:
            print(f'  {done}/{total} done...')

    print()
    print(f'Done: {done}')
    print(f'Skipped (already up-to-date): {skipped}')
    print(f'Failed: {len(failed)}')
    if failed and len(failed) < 50:
        print(f'  failed seeds: {failed}')

    # Report size savings on first file.
    if done > 0:
        sample = DST / f'{seeds[0]:05d}.webp'
        if sample.exists():
            src_kb = (SRC / f'{seeds[0]:05d}.png').stat().st_size / 1024
            dst_kb = sample.stat().st_size / 1024
            print(f'Sample size: {src_kb:.0f}KB master → {dst_kb:.1f}KB WebP thumb ({dst_kb/src_kb*100:.1f}%)')

if __name__ == '__main__':
    main()
