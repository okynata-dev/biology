#!/usr/bin/env python3
"""
make-glass-scenes.py — a few seamless-loop "group portrait" mp4s: diverse bioms
staggered in depth on ONE canvas (no cropping). Auto-picks distinct, varied sets
(different forms + stains; no token reused across clips).

    python3 scripts/make-glass-scenes.py                 # 3 clips, 9 each
    python3 scripts/make-glass-scenes.py --clips 3 --n 9 --res 1440
"""
import argparse, functools, http.server, os, socket, socketserver, subprocess, tempfile, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "loops")
RANK = {"Mythic": 4, "Epic": 3, "Rare": 2, "Uncommon": 1, "Common": 0}
FORMS = ["Coccus","Morula","Bacilli","Staphylo","Strepto","Acanthar","Nassella","Lattice","Coral","Discus"]

def serve(directory):
    h = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    h.log_message = lambda *a, **k: None
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    httpd = socketserver.TCPServer(("127.0.0.1", port), h)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port

def all_traits(page, port):
    page.goto(f"http://127.0.0.1:{port}/glass-500.html", wait_until="load")
    page.wait_for_function("typeof window.__traitOf==='function'", timeout=30000)
    return page.evaluate("()=>{const o={};for(let i=1;i<=500;i++)o[i]=window.__traitOf(i);return o;}")

def pick_sets(tr, clips, n):
    byform = {f: [] for f in FORMS}
    for i in range(1, 501):
        byform[tr[str(i)]["form"]].append(i)
    for f in byform:  # most interesting first
        byform[f].sort(key=lambda i: (-RANK[tr[str(i)]["tier"]], i))
    used = set(); sets = []
    for c in range(clips):
        order = FORMS[c % len(FORMS):] + FORMS[:c % len(FORMS)]
        chosen = []; stains = set()
        for relax in (False, True):
            for f in order:
                if len(chosen) >= n: break
                for i in byform[f]:
                    if i in used: continue
                    if not relax and tr[str(i)]["stain"] in stains: continue
                    chosen.append(i); used.add(i); stains.add(tr[str(i)]["stain"]); break
            if len(chosen) >= n: break
        sets.append(chosen[:n])
    return sets

def render(page, port, ids, res, fps, crf, out):
    page.set_viewport_size({"width": res, "height": res})
    page.goto(f"http://127.0.0.1:{port}/glass-scene.html?ids={','.join(map(str,ids))}", wait_until="load")
    page.wait_for_function("window.__seekAll && window.__LOOP", timeout=45000)
    page.wait_for_timeout(400)
    L = page.evaluate("window.__LOOP"); nf = int(round(L * fps))
    td = tempfile.mkdtemp()
    for i in range(nf):
        page.evaluate("(t)=>window.__seekAll(t)", i * L / nf)
        page.screenshot(path=os.path.join(td, f"f{i:04d}.png"))
    subprocess.run(["ffmpeg","-y","-framerate",str(fps),"-i",os.path.join(td,"f%04d.png"),
                    "-c:v","libx264","-pix_fmt","yuv420p","-crf",str(crf),"-preset","slow",
                    "-movflags","+faststart",out],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for f in os.listdir(td):
        os.remove(os.path.join(td, f))
    return os.path.getsize(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--clips", type=int, default=3)
    ap.add_argument("--n", type=int, default=9)
    ap.add_argument("--res", type=int, default=1440)
    ap.add_argument("--fps", type=int, default=18)
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    httpd, port = serve(ROOT)
    with sync_playwright() as p:
        b = p.chromium.launch(headless=True, args=["--use-gl=angle","--use-angle=metal","--ignore-gpu-blocklist"])
        page = b.new_page()
        tr = all_traits(page, port)
        sets = pick_sets(tr, args.clips, args.n)
        for c, ids in enumerate(sets, 1):
            print(f"clip {c}: {ids}")
            print("   forms:", [tr[str(i)]["form"] for i in ids])
            out = os.path.join(OUT, f"glass-scene-{c}.mp4")
            sz = render(page, port, ids, args.res, args.fps, args.crf, out)
            print(f"   -> {os.path.basename(out)}  {sz/1_048_576:.1f} MB", flush=True)
        b.close()
    httpd.shutdown()
    print("done:", OUT)

if __name__ == "__main__":
    main()
