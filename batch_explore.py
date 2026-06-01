#!/usr/bin/env python3
"""
Renders the 46 trait-isolation PNGs consumed by explore.html and the landing
stain showcase. Each entry corresponds to one card in the Trait Explorer.

Run once, then upload the output to R2 (or commit if size permits — these are
small, ~10 MB total at 1200 px).

Usage:
    python3 batch_explore.py ./pngs/explore [--size 1200] [--workers 4]

The manifest below is the source of truth — keep it in sync with the trait
arrays in explore.html if new traits are added.
"""

import sys
import os
import argparse
import http.server
import socketserver
import threading
import time
import platform
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from playwright.sync_api import sync_playwright

# Common URL params — match explore.html's COMMON constant.
COMMON = "fit=1&static=1&nointeract=1&noise=0"


def build_manifest():
    """Returns a list of (category, trait_id, source_url) tuples.
    The output filename will be `{category}-{trait_id}.png`.
    """
    items = []

    # MORPHOLOGY (11)
    morphs = [
        ('coccus', 0), ('bacillus', 1), ('vibrio', 11), ('spirillum', 47),
        ('filament', 28), ('cluster', 18), ('diplo', 7),
        ('streptobacillus', 33), ('tetrad', 91), ('sarcina', 145),
        ('mycelium', 312),
    ]
    for tid, seed in morphs:
        items.append(('morph', tid, f"preview.html?seed={seed}&{COMMON}&forceMorph={tid}"))

    # STAIN (9 standard + 3 rare = 12)
    stains_standard = [
        ('gramPositive', 0), ('gramNegative', 2), ('fluorescent', 11),
        ('methylene', 8), ('darkfield', 5), ('acid_fast', 64),
        ('giemsa', 38), ('safranin', 109), ('india_ink', 156),
        # 2026-06 expansion — 7 new single microbiology stains.
        ('malachite', 7), ('carbol_fuchsin', 21), ('bismarck_brown', 33),
        ('nile_blue', 44), ('congo_red', 13), ('toluidine', 70), ('eosin', 52),
    ]
    for tid, seed in stains_standard:
        items.append(('stain', tid, f"preview.html?seed={seed}&{COMMON}&forceStain={tid}"))

    # Dual stains — two dyes alternate per cell, so force a multi-cell
    # morphology + extra cells to make the duality read on the card.
    stains_dual = [
        ('ziehl_dual', 88),
        ('spore_dual', 91),
    ]
    for tid, seed in stains_dual:
        items.append(('stain', tid, f"preview.html?seed={seed}&{COMMON}&forceStain={tid}&forceMorph=sarcina&forceCells=6"))

    # Rare stains — preview.html?forceStain= works for these too (the engine
    # supports all 12 palettes natively). No need for the legacy rare-*.html
    # forks. Seeds picked to give pleasant compositions.
    stains_rare = [
        ('iridescent_aurora', 17),
        ('ghost',             23),
        ('gram_variable',     31),
    ]
    for tid, seed in stains_rare:
        items.append(('stain', tid, f"preview.html?seed={seed}&{COMMON}&forceStain={tid}"))

    # ORGANELLES (10) — clean coccus, only the named organelle visible
    organelles = [
        ('nucleoid',  14, 'capsule,nucleoid',  'coccus'),
        ('pili',      22, 'capsule,pili',      'coccus'),
        ('ribosomes',  6, 'capsule,ribosomes', 'coccus'),
        ('plasmid',   71, 'capsule,plasmid',   'coccus'),
        ('flagellum', 88, 'capsule,flagellum', 'coccus'),
        ('eyespot',   27, 'capsule,eyespot',   'coccus'),
        ('inclusion', 41, 'capsule,inclusion', 'coccus'),
        ('endospore',130, 'capsule,endospore', 'coccus'),
        ('axial',    196, 'capsule,axial',     'spirillum'),
        ('capsule',    4, 'capsule',           'coccus'),
    ]
    for tid, seed, organelles_str, morph in organelles:
        items.append((
            'organelle', tid,
            f"preview.html?seed={seed}&{COMMON}&forceMorph={morph}"
            f"&forceStain=gramPositive&forceOrganelles={organelles_str}&forceCells=4"
        ))

    # RESERVES (6) — clean coccus + reserve
    reserves = [
        ('none', 4), ('phb', 56), ('volutin', 73),
        ('magnetosomes', 211), ('sulfur', 287), ('crystalline', 425),
    ]
    for tid, seed in reserves:
        items.append((
            'reserve', tid,
            f"preview.html?seed={seed}&{COMMON}&forceMorph=coccus"
            f"&forceStain=gramPositive&forceReserve={tid}&forceCells=4"
        ))

    # LIFECYCLE (4)
    lifecycles = [
        ('vegetative',     4,    'bacillus', 'vegetative'),
        ('binary_fission', 89,   'bacillus', 'binary_fission'),
        ('sporulating',    154,  'bacillus', 'sporulating'),
        ('heterocyst',     1247, 'filament', 'heterocyst'),
    ]
    for tid, seed, morph, lc in lifecycles:
        items.append((
            'lifecycle', tid,
            f"preview.html?seed={seed}&{COMMON}&forceMorph={morph}"
            f"&forceStain=gramPositive&forceLifecycle={lc}&forceCells=3"
        ))

    # ULTRA RARE (3) — clean coccus + methylene + the anomaly flag
    ultra = [
        ('phage',   89,  'forcePhage=1'),
        ('endo',    412, 'forceEndo=1'),
        ('biofilm', 277, 'forceBiofilm=1'),
    ]
    for tid, seed, flag in ultra:
        items.append((
            'ultra', tid,
            f"preview.html?seed={seed}&{COMMON}&forceMorph=coccus"
            f"&forceStain=methylene&{flag}&forceCells=2"
        ))

    return items


def find_chrome():
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
    elif system == "Windows":
        candidates = [
            r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


CHROME_PATH = find_chrome()


def start_server(directory, port):
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=directory, **kw)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("output_dir", help="Where to write the PNGs, e.g. ./pngs/explore")
    parser.add_argument("--size", type=int, default=1200, help="Output PNG size (square)")
    parser.add_argument("--port", type=int, default=8766)
    parser.add_argument("--settle", type=float, default=1.5, help="Wait seconds for layout to settle")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parent
    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    manifest = build_manifest()
    print(f"Serving {repo_root} on port {args.port}")
    server = start_server(str(repo_root), args.port)
    time.sleep(0.3)

    print(f"Rendering {len(manifest)} trait PNGs at {args.size}×{args.size} "
          f"using {args.workers} worker(s)")
    print(f"Output: {output_dir}")
    if CHROME_PATH:
        print(f"Using Chrome: {CHROME_PATH}")
    else:
        print("Using Playwright's bundled Chromium")

    def render_chunk(worker_idx, chunk):
        with sync_playwright() as p:
            launch_kwargs = {
                "headless": True,
                "args": ["--no-sandbox", "--disable-dev-shm-usage"],
            }
            if CHROME_PATH:
                launch_kwargs["executable_path"] = CHROME_PATH
            browser = p.chromium.launch(**launch_kwargs)
            context = browser.new_context(
                viewport={"width": args.size, "height": args.size},
                device_scale_factor=1,
            )
            page = context.new_page()
            for i, (cat, tid, url_path) in enumerate(chunk):
                url = f"http://127.0.0.1:{args.port}/{url_path}"
                out_path = output_dir / f"{cat}-{tid}.png"
                page.goto(url, wait_until="networkidle")
                page.wait_for_timeout(int(args.settle * 1000))
                page.screenshot(
                    path=str(out_path),
                    clip={"x": 0, "y": 0, "width": args.size, "height": args.size},
                )
                print(f"  [worker {worker_idx}] {i+1}/{len(chunk)} → {cat}-{tid}")
            browser.close()

    try:
        if args.workers <= 1:
            render_chunk(0, manifest)
        else:
            chunks = [manifest[i::args.workers] for i in range(args.workers)]
            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                futures = [ex.submit(render_chunk, i, ch) for i, ch in enumerate(chunks)]
                for f in futures:
                    f.result()
        print(f"\nDone. {len(manifest)} trait PNGs saved to {output_dir}/")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
