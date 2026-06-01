#!/usr/bin/env python3
# Fast parallel thumb derivation: pngs/preview/<id>.webp (3000px master)
# -> pngs/thumb/<id>.webp (600px). Multiprocessing + method=4 (the single
# -threaded method=6 path was ~9s/thumb). Gallery uses these.
#
# Usage: python3 scripts/make-thumbs-fast.py [--size 600] [--workers 6] [--quality 82]
import argparse, os
from pathlib import Path
from multiprocessing import Pool
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'pngs' / 'preview'
DST = ROOT / 'pngs' / 'thumb'

def one(args):
    seed, size, quality = args
    src = SRC / f'{seed:05d}.webp'
    if not src.exists():
        return ('miss', seed)
    out = DST / f'{seed:05d}.webp'
    try:
        if out.exists() and out.stat().st_mtime > src.stat().st_mtime:
            return ('skip', seed)
        img = Image.open(src).convert('RGBA')
        img.thumbnail((size, size), Image.Resampling.LANCZOS)
        img.save(out, 'WEBP', quality=quality, method=4)
        return ('ok', seed)
    except Exception as e:
        return ('fail', (seed, str(e)))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', type=int, default=600)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--quality', type=int, default=82)
    ap.add_argument('--start', type=int, default=1)
    ap.add_argument('--end', type=int, default=8000)
    a = ap.parse_args()
    DST.mkdir(parents=True, exist_ok=True)
    seeds = [(s, a.size, a.quality) for s in range(a.start, a.end + 1)]
    ok = skip = miss = 0
    fails = []
    with Pool(a.workers) as p:
        for i, (status, payload) in enumerate(p.imap_unordered(one, seeds, chunksize=16)):
            if status == 'ok': ok += 1
            elif status == 'skip': skip += 1
            elif status == 'miss': miss += 1
            else: fails.append(payload)
            if (i + 1) % 1000 == 0:
                print(f'  {i+1}/{len(seeds)}  ok={ok} skip={skip} miss={miss} fail={len(fails)}', flush=True)
    print(f'Done. ok={ok} skip={skip} miss={miss} fail={len(fails)}')
    if fails: print('fails:', fails[:20])

if __name__ == '__main__':
    main()
