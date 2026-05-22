#!/usr/bin/env python3
"""
make-cutouts.py — render alpha-PNG cutouts of every biom (no card background).

Each output is a tightly-cropped square PNG with full alpha channel, ready
for direct use in the /make collage feature (or anywhere else a clean,
non-rectangular biom is needed). No more JS-side flood-fill heuristics →
no stripping artifacts at zoom.

Pipeline per seed:
  Playwright opens preview.html?seed=N&cutout=1&static=1&fit=1
    ↓ wait for __biomReady
    ↓ page.screenshot(omit_background=True)        — RGBA PNG
    ↓ PIL: find bbox of α>0 pixels, pad 5 %, center in a square canvas
    ↓ save pngs/cutout/{seed:05d}.png  +  .webp

Usage:
    python3 scripts/make-cutouts.py                 # all 3000
    python3 scripts/make-cutouts.py --only 44,132   # specific seeds
    python3 scripts/make-cutouts.py --workers 4     # parallel browsers
    python3 scripts/make-cutouts.py --size 800      # source render size

Output:
    pngs/cutout/00000.png  pngs/cutout/00000.webp
    ...

After running, upload via:
    bash scripts_upload_cutouts.sh
"""

import argparse
import http.server
import io
import os
import platform
import socketserver
import sys
import threading
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from PIL import Image
from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent.parent
DST  = ROOT / "pngs" / "cutout"


def find_chrome():
    """Auto-detect Chrome binary on macOS / Linux. None lets Playwright pick its own."""
    system = platform.system()
    candidates = []
    if system == "Darwin":
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
    elif system == "Linux":
        candidates = [
            "/usr/bin/google-chrome",
            "/usr/bin/chromium-browser",
            "/usr/bin/chromium",
        ]
    for p in candidates:
        if os.path.exists(p):
            return p
    return None


def start_server(directory, port):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    return httpd


def crop_to_bbox(img: Image.Image, pad_pct: float = 0.05) -> Image.Image:
    """Crop the input RGBA image to the bbox of opaque pixels (α > 0) with
    pad_pct padding on every side, then place that crop centred in a
    square output canvas (max-dim of the bbox). Returns RGBA Image."""
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    bbox = img.getbbox()  # finds non-zero alpha bbox
    if not bbox:
        # Entirely transparent — return as-is (shouldn't happen, but defensive)
        return img
    l, t, r, b = bbox
    bw, bh = r - l, b - t
    pad = int(max(bw, bh) * pad_pct)
    l2 = max(0, l - pad)
    t2 = max(0, t - pad)
    r2 = min(img.width,  r + pad)
    b2 = min(img.height, b + pad)
    cropped = img.crop((l2, t2, r2, b2))
    cw, ch = cropped.size
    side = max(cw, ch)
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    ox = (side - cw) // 2
    oy = (side - ch) // 2
    out.paste(cropped, (ox, oy), cropped)
    return out


def render_one(playwright_ctx, port: int, seed: int, render_size: int,
               webp_quality: int, settle_ms: int, write_png: bool):
    """Open the preview page for `seed`, screenshot transparent, crop, save.
    Returns (seed, ok, error_msg)."""
    browser, page = playwright_ctx
    url = f"http://127.0.0.1:{port}/preview.html?seed={seed}&cutout=1&static=1&fit=1"
    try:
        page.goto(url, wait_until="load", timeout=15000)
        # Wait for engine ready signal (preview.html sets body.engine-ready)
        page.wait_for_selector("body.engine-ready", timeout=8000)
        page.wait_for_timeout(settle_ms)
        png_bytes = page.screenshot(
            clip={"x": 0, "y": 0, "width": render_size, "height": render_size},
            omit_background=True,                 # critical — gives transparent BG
            type="png",
        )
        img = Image.open(io.BytesIO(png_bytes))
        cropped = crop_to_bbox(img, pad_pct=0.05)
        padded = f"{seed:05d}"
        if write_png:
            cropped.save(DST / f"{padded}.png", "PNG", optimize=True)
        cropped.save(DST / f"{padded}.webp", "WEBP", quality=webp_quality, method=6)
        return (seed, True, None)
    except Exception as e:
        return (seed, False, f"{type(e).__name__}: {e}")


def worker_run(worker_idx: int, seeds_chunk, port: int, render_size: int,
               webp_quality: int, settle_ms: int, write_png: bool, chrome_path):
    results = []
    with sync_playwright() as p:
        launch_args = {"headless": True}
        if chrome_path:
            launch_args["executable_path"] = chrome_path
        browser = p.chromium.launch(**launch_args)
        try:
            ctx = browser.new_context(viewport={"width": render_size, "height": render_size})
            page = ctx.new_page()
            for i, seed in enumerate(seeds_chunk):
                r = render_one((browser, page), port, seed, render_size, webp_quality, settle_ms, write_png)
                results.append(r)
                if (i + 1) % 25 == 0:
                    ok_so_far = sum(1 for _, ok, _ in results if ok)
                    print(f"  [w{worker_idx}] {i+1}/{len(seeds_chunk)}  ok={ok_so_far}", flush=True)
        finally:
            browser.close()
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="Comma-separated seed list (default: 0..2999)")
    ap.add_argument("--size", type=int, default=800,
                    help="Source render size (square). Output crops are <= this. Default 800.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--settle", type=int, default=600, help="ms to wait after engine-ready")
    ap.add_argument("--webp-quality", type=int, default=88)
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--skip-png", action="store_true", help="Skip PNG fallback (webp only)")
    args = ap.parse_args()

    if args.only:
        seeds = [int(s) for s in args.only.split(",")]
    else:
        seeds = list(range(3000))

    DST.mkdir(parents=True, exist_ok=True)
    chrome = find_chrome()

    httpd = start_server(ROOT, args.port)
    print(f"  → static server on :{args.port} (root: {ROOT})")
    print(f"  → rendering {len(seeds)} seeds at {args.size}px through {args.workers} worker(s)")
    if chrome:
        print(f"  → using Chrome: {chrome}")
    t0 = time.time()

    # Split seeds across workers
    chunks = [[] for _ in range(args.workers)]
    for i, s in enumerate(seeds):
        chunks[i % args.workers].append(s)

    all_results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(worker_run, i, chunk, args.port, args.size,
                        args.webp_quality, args.settle, not args.skip_png, chrome)
            for i, chunk in enumerate(chunks) if chunk
        ]
        for f in as_completed(futures):
            all_results.extend(f.result())

    ok = sum(1 for _, k, _ in all_results if k)
    fail = [(s, e) for s, k, e in all_results if not k]
    dt = time.time() - t0
    print(f"\nDone: {ok}/{len(seeds)} in {dt:.0f}s ({dt/max(1,len(seeds))*1000:.0f}ms/seed)")
    if fail:
        print(f"Failed: {len(fail)}")
        for s, e in fail[:10]:
            print(f"  {s:05d}  {e}")
    if ok > 0:
        sample = sorted([s for s, k, _ in all_results if k])[0]
        webp = DST / f"{sample:05d}.webp"
        if webp.exists():
            print(f"Sample size: {webp.stat().st_size/1024:.1f} KB ({webp})")

    httpd.shutdown()


if __name__ == "__main__":
    main()
