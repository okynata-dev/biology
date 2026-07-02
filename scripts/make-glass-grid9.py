#!/usr/bin/env python3
"""
make-glass-grid9.py — one seamless-loop mp4 of the 9 rarest glass bioms in a
tight 3×3 board (single page, 9 token renders touching — no cropping).

    python3 scripts/make-glass-grid9.py                 # auto-pick 9 rarest
    python3 scripts/make-glass-grid9.py --ids 11 6 ...   # force ids
    python3 scripts/make-glass-grid9.py --cell 512 --fps 18 --crf 20
"""
import argparse, functools, http.server, os, socket, socketserver, subprocess, tempfile, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "loops")
RANK = {"Mythic": 4, "Epic": 3, "Rare": 2, "Uncommon": 1, "Common": 0}

def serve(directory):
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    h.log_message = lambda *a, **k: None
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    httpd = socketserver.TCPServer(("127.0.0.1", port), h)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port

def rarest(page, port, n=9):
    page.goto(f"http://127.0.0.1:{port}/glass-500.html", wait_until="load")
    page.wait_for_function("typeof window.__tierOf==='function'", timeout=30000)
    tiers = page.evaluate("()=>{const o={};for(let i=1;i<=500;i++)o[i]=window.__tierOf(i);return o;}")
    ids = sorted(range(1, 501), key=lambda i: (-RANK.get(tiers[str(i)], 0), i))
    return ids[:n], {i: tiers[str(i)] for i in ids[:n]}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", type=int, nargs="*")
    ap.add_argument("--cell", type=int, default=512)
    ap.add_argument("--fps", type=int, default=18)
    ap.add_argument("--crf", type=int, default=20)
    ap.add_argument("--z", default="1.06")
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    httpd, port = serve(ROOT)
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=[
            "--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"])
        page = b.new_page()
        ids = args.ids[:9] if args.ids else None
        if not ids:
            ids, meta = rarest(page, port)
            print("9 rarest:", ", ".join(f"#{i}({meta[i]})" for i in ids))
        side = args.cell * 3
        page.set_viewport_size({"width": side, "height": side})
        url = f"http://127.0.0.1:{port}/glass-grid9.html?ids={','.join(map(str,ids))}&cell={args.cell}&z={args.z}"
        page.goto(url, wait_until="load")
        page.wait_for_function("window.__readyAll && window.__readyAll()===true", timeout=90000)
        page.wait_for_timeout(500)
        L = page.evaluate("window.__LOOP"); n = int(round(L * args.fps))
        td = tempfile.mkdtemp()
        print(f"board {side}px, {n} frames @ {args.fps}fps")
        for i in range(n):
            page.evaluate("(t)=>window.__seekAll(t)", i * L / n)
            page.wait_for_timeout(12)
            page.screenshot(path=os.path.join(td, f"f{i:04d}.png"))
        out = os.path.join(OUT, "glass-grid9.mp4")
        subprocess.run(["ffmpeg", "-y", "-framerate", str(args.fps), "-i", os.path.join(td, "f%04d.png"),
                        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(args.crf),
                        "-preset", "slow", "-movflags", "+faststart", out],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(f"-> {out}  {os.path.getsize(out)/1_048_576:.1f} MB")
        b.close()
    httpd.shutdown()

if __name__ == "__main__":
    main()
