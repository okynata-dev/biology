#!/usr/bin/env python3
"""
render-premint.py — re-render the ~550 pre-minted elevated tokens.

The base 8000 batch rendered every seed as a plain Genesis biom. This
overwrites the masters for the elevated tokens (Hybrid/Chimera/Phoenix)
using the exact force-param query in premint.json, so they look like the
burn-survivors their metadata says they are.

Reads premint.json, renders preview.html?<force>&static=1 at 3000px WEBP
into pngs/preview/<id>.webp (OVERWRITES the base render — these seeds
already have a file). Run AFTER the base master batch completes.

Usage:
  python3 scripts/render-premint.py [--workers 2] [--port 8798] [--size 3000]
"""
import argparse
import json
import http.server
import socketserver
import threading
import platform
from io import BytesIO
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from PIL import Image
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PREMINT = ROOT / 'premint.json'
OUT = ROOT / 'pngs' / 'preview'


def find_chrome():
    if platform.system() == 'Darwin':
        for c in ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                  '/Applications/Chromium.app/Contents/MacOS/Chromium']:
            if Path(c).exists():
                return c
    return None


def start_server(directory, port):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=directory, **k)
    httpd = socketserver.TCPServer(('127.0.0.1', port), handler)
    httpd.allow_reuse_address = True
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    return httpd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--port', type=int, default=8798)
    ap.add_argument('--size', type=int, default=3000)
    ap.add_argument('--webp-quality', type=int, default=90)
    ap.add_argument('--settle', type=float, default=1.5)
    args = ap.parse_args()

    data = json.loads(PREMINT.read_text())
    items = [(int(tid), t['force']) for tid, t in data['tokens'].items()]
    items.sort()
    print(f'Re-rendering {len(items)} pre-minted elevated masters at {args.size}px → {OUT}')

    chrome = find_chrome()
    httpd = start_server(str(ROOT), args.port)
    RESTART_EVERY = 80

    def launch(p):
        kw = {'headless': True, 'args': ['--no-sandbox', '--disable-dev-shm-usage']}
        if chrome:
            kw['executable_path'] = chrome
        b = p.chromium.launch(**kw)
        ctx = b.new_context(viewport={'width': args.size, 'height': args.size}, device_scale_factor=1)
        return b, ctx.new_page()

    def render_slice(widx, slice_items):
        failed = []
        with sync_playwright() as p:
            browser, page = launch(p)
            since = 0
            for i, (tid, force) in enumerate(slice_items):
                url = f'http://127.0.0.1:{args.port}/preview.html?{force}&static=1'
                out = OUT / f'{tid:05d}.webp'
                ok = False
                for attempt in range(2):
                    try:
                        page.goto(url, wait_until='load', timeout=15000)
                        page.wait_for_timeout(int(args.settle * 1000))
                        buf = page.screenshot(clip={'x': 0, 'y': 0, 'width': args.size, 'height': args.size})
                        Image.open(BytesIO(buf)).save(str(out), 'WEBP', quality=args.webp_quality, method=6)
                        ok = True
                        break
                    except Exception as e:
                        if attempt == 0:
                            try: browser.close()
                            except Exception: pass
                            browser, page = launch(p); since = 0
                        else:
                            failed.append(tid)
                            print(f'  [w{widx}] gave up #{tid}: {type(e).__name__}')
                if not ok:
                    continue
                since += 1
                if (i + 1) % 25 == 0:
                    print(f'  [w{widx}] {i+1}/{len(slice_items)}')
                if since >= RESTART_EVERY:
                    try: browser.close()
                    except Exception: pass
                    browser, page = launch(p); since = 0
            try: browser.close()
            except Exception: pass
        return failed

    try:
        chunks = [items[i::args.workers] for i in range(args.workers)]
        all_failed = []
        with ThreadPoolExecutor(max_workers=args.workers) as ex:
            for f in [ex.submit(render_slice, i, c) for i, c in enumerate(chunks)]:
                all_failed.extend(f.result() or [])
        print(f'\nDone. {len(items) - len(all_failed)}/{len(items)} elevated masters re-rendered.')
        if all_failed:
            print(f'! failed: {sorted(all_failed)}')
    finally:
        httpd.shutdown()


if __name__ == '__main__':
    main()
