#!/usr/bin/env python3
"""
Batch screenshot generator for bacteria PFP collection.

Usage:
    python3 batch_screenshots.py <html_path> <output_dir> <count> [--start SEED] [--size 1000] [--format FORMAT]

Format options:
    preview         — square preview (1:1, sized via --size)  [DEFAULT]
    square          — 1500x1500 download asset (white bg)
    twitter_header  — 1500x500 with brand text
    twitter_post    — 1200x675 with brand text
    opensea_banner  — 1400x400 with brand text
    profile_picture — 800x800

Examples:
    python3 batch_screenshots.py preview.html ./images 1000
    python3 batch_screenshots.py asset-template.html ./assets/square 1000 --format square
    python3 batch_screenshots.py asset-template.html ./assets/twitter 1000 --format twitter_header
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
from playwright.sync_api import sync_playwright


def find_chrome():
    """Auto-detect Chrome binary on macOS / Linux. Returns None if not found (lets Playwright pick its own)."""
    system = platform.system()
    candidates = []
    if system == "Darwin":  # macOS
        candidates = [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
            "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
        ]
    elif system == "Linux":
        candidates = [
            "/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome",  # Anthropic container
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

# Asset format dimensions
FORMAT_SIZES = {
    'preview':         (None, None),     # uses --size for both
    'square':          (1500, 1500),
    'twitter_header':  (1500, 500),
    'twitter_post':    (1200, 675),
    'opensea_banner':  (1400, 400),
    'profile_picture': (800, 800),
}


def start_server(directory, port):
    """Start a simple HTTP server in a background thread."""
    handler = lambda *args, **kwargs: http.server.SimpleHTTPRequestHandler(
        *args, directory=directory, **kwargs
    )
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("html_path", help="Path to HTML (preview.html or asset-template.html)")
    parser.add_argument("output_dir", help="Directory to save PNGs")
    parser.add_argument("count", type=int, help="How many specimens to render")
    parser.add_argument("--start", type=int, default=0, help="Starting seed")
    parser.add_argument("--size", type=int, default=1000, help="Output PNG size (only used for 'preview' format)")
    parser.add_argument("--port", type=int, default=8765, help="Local server port")
    parser.add_argument("--settle", type=float, default=1.5, help="Wait seconds for animation")
    parser.add_argument("--format", default="preview", choices=list(FORMAT_SIZES.keys()),
                        help="Asset format. 'preview' renders the bare token; others use asset-template.html.")
    parser.add_argument("--workers", type=int, default=1,
                        help="Parallel browser instances. On M-series Macs 4-6 works well. Linux container: keep at 1.")
    args = parser.parse_args()

    html_path = Path(args.html_path).resolve()
    if not html_path.exists():
        print(f"Error: {html_path} not found")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    serve_dir = html_path.parent
    html_name = html_path.name

    # Determine dimensions
    if args.format == 'preview':
        width = height = args.size
    else:
        width, height = FORMAT_SIZES[args.format]

    print(f"Serving {serve_dir} on port {args.port}")
    server = start_server(str(serve_dir), args.port)
    time.sleep(0.3)

    print(f"Rendering {args.count} specimens at {width}x{height} (format={args.format}) using {args.workers} worker(s)")
    print(f"Output: {output_dir}")

    # Restart the browser every N renders so a worker's RAM/CPU footprint
    # stays bounded across thousands of seeds. With 6 workers × 3000-px viewport,
    # a single browser starts thrashing after ~300-400 renders on a 16 GB Mac.
    RESTART_EVERY = 200

    def _launch(p):
        launch_kwargs = {
            "headless": True,
            "args": ["--no-sandbox", "--disable-dev-shm-usage"],
        }
        if CHROME_PATH:
            launch_kwargs["executable_path"] = CHROME_PATH
        browser = p.chromium.launch(**launch_kwargs)
        context = browser.new_context(
            viewport={"width": width, "height": height},
            device_scale_factor=1,
        )
        page = context.new_page()
        return browser, page

    def render_range(worker_idx, seeds):
        """One worker renders its slice of seeds. Resilient to transient
        timeouts: retries each goto once, skips on second failure. Skips
        seeds whose PNG already exists on disk so reruns resume cheaply.
        Restarts the browser every RESTART_EVERY successful renders.
        """
        with sync_playwright() as p:
            browser, page = _launch(p)
            rendered_since_restart = 0
            skipped_existing = 0
            failed = []

            for i, seed in enumerate(seeds):
                out_path = output_dir / f"{seed:05d}.png"
                if out_path.exists() and out_path.stat().st_size > 0:
                    skipped_existing += 1
                    continue

                if args.format == 'preview':
                    url = f"http://127.0.0.1:{args.port}/{html_name}?seed={seed}&static=1"
                else:
                    url = f"http://127.0.0.1:{args.port}/{html_name}?seed={seed}&format={args.format}&static=1"

                ok = False
                for attempt in range(2):
                    try:
                        # `load` is enough — preview.html doesn't fetch over the
                        # network after the document body finishes. `networkidle`
                        # was hanging once the system got hot.
                        page.goto(url, wait_until="load", timeout=15000)
                        page.wait_for_timeout(int(args.settle * 1000))
                        page.screenshot(
                            path=str(out_path),
                            clip={"x": 0, "y": 0, "width": width, "height": height},
                        )
                        ok = True
                        break
                    except Exception as e:
                        if attempt == 0:
                            # Bounce the browser before retrying — usually it's
                            # an exhausted browser, not a bad page.
                            print(f"  [worker {worker_idx}] retry seed {seed} after: {type(e).__name__}")
                            try:
                                browser.close()
                            except Exception:
                                pass
                            browser, page = _launch(p)
                            rendered_since_restart = 0
                        else:
                            failed.append(seed)
                            print(f"  [worker {worker_idx}] ! gave up on seed {seed}: {type(e).__name__}")

                if not ok:
                    continue

                rendered_since_restart += 1
                if (i + 1) % 10 == 0 or i == 0:
                    print(f"  [worker {worker_idx}] {i+1}/{len(seeds)} → seed {seed}"
                          + (f" (skipped {skipped_existing} existing)" if skipped_existing else ""))

                if rendered_since_restart >= RESTART_EVERY:
                    try:
                        browser.close()
                    except Exception:
                        pass
                    browser, page = _launch(p)
                    rendered_since_restart = 0

            try:
                browser.close()
            except Exception:
                pass

            if failed:
                print(f"  [worker {worker_idx}] ! {len(failed)} seeds failed: {failed[:20]}{'...' if len(failed) > 20 else ''}")
            return failed

    try:
        all_seeds = [args.start + i for i in range(args.count)]
        if CHROME_PATH:
            print(f"Using Chrome: {CHROME_PATH}")
        else:
            print("Using Playwright's bundled Chromium (run `playwright install chromium` if missing)")

        all_failed = []
        if args.workers <= 1:
            failed = render_range(0, all_seeds) or []
            all_failed.extend(failed)
        else:
            from concurrent.futures import ThreadPoolExecutor
            chunks = [all_seeds[i::args.workers] for i in range(args.workers)]
            with ThreadPoolExecutor(max_workers=args.workers) as ex:
                futures = [ex.submit(render_range, i, chunk) for i, chunk in enumerate(chunks)]
                for f in futures:
                    failed = f.result() or []
                    all_failed.extend(failed)

        existing = sorted(int(p.stem) for p in output_dir.glob("*.png"))
        print(f"\nDone. {len(existing)} / {args.count} PNGs in {output_dir}/")
        if all_failed:
            print(f"! {len(all_failed)} seeds failed after retry: {sorted(all_failed)}")
            print(f"  Rerun the same command — already-rendered PNGs are skipped, only the gaps will be re-attempted.")
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
