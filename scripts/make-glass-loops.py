#!/usr/bin/env python3
"""
make-glass-loops.py — perfect-loop mp4 of each glass biom, ready for Twitter.

Renders deterministic frames over exactly one loop period (window.__LOOP) via
window.__seek(t), so the clip loops seamlessly. Frames -> h264 mp4 (yuv420p),
tuned to land ~10-20 MB.

    python3 scripts/make-glass-loops.py --ids 11 25 46      # samples
    python3 scripts/make-glass-loops.py --range 1 500        # everything
    python3 scripts/make-glass-loops.py --res 1280 --fps 25 --crf 20
"""
import argparse, functools, http.server, os, socket, socketserver, subprocess, sys, threading
from playwright.sync_api import sync_playwright

# GPU on the Mac (Metal via ANGLE); software SwiftShader on Linux CI (no GPU)
GL_ARGS = (["--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist"]
           if sys.platform == "darwin" else
           ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"])

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "loops")

def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *a, **k: None
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port

def render_one(page, port, cid, res, fps, crf, td):
    page.set_viewport_size({"width": res, "height": res})
    page.goto(f"http://127.0.0.1:{port}/glass-500.html?id={cid}&token=1&z=1.12", wait_until="load", timeout=60000)
    page.wait_for_function("window.__biomReady === true", timeout=45000)
    L = page.evaluate("window.__LOOP")
    n = int(round(L * fps))
    for i in range(n):
        t = i * L / n
        page.evaluate("(t)=>window.__seek(t)", t)
        page.screenshot(path=os.path.join(td, f"f{i:04d}.png"))
    out = os.path.join(OUT, f"glass-{cid:03d}.mp4")
    subprocess.run(["ffmpeg", "-y", "-framerate", str(fps), "-i", os.path.join(td, "f%04d.png"),
                    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", str(crf),
                    "-preset", "slow", "-movflags", "+faststart",
                    "-vf", "format=yuv420p", out],
                   check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for f in os.listdir(td):
        if f.endswith(".png"): os.remove(os.path.join(td, f))
    return out, os.path.getsize(out)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", type=int, nargs="*")
    ap.add_argument("--only", type=str, help="comma-separated ids (for CI)")
    ap.add_argument("--range", type=int, nargs=2)
    ap.add_argument("--res", type=int, default=1280)
    ap.add_argument("--fps", type=int, default=25)
    ap.add_argument("--crf", type=int, default=20)
    args = ap.parse_args()
    if args.only:
        ids = [int(x) for x in args.only.split(",") if x.strip()]
    else:
        ids = args.ids or (list(range(args.range[0], args.range[1] + 1)) if args.range else [11, 25, 46])
    os.makedirs(OUT, exist_ok=True)
    httpd, port = serve(ROOT)
    print(f"serving :{port}  ->  {len(ids)} token(s), {args.res}px @ {args.fps}fps crf{args.crf}")
    import tempfile
    td = tempfile.mkdtemp()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=GL_ARGS)
        page = browser.new_page(device_scale_factor=1)
        for cid in ids:
            dst = os.path.join(OUT, f"glass-{cid:03d}.mp4")
            if os.path.exists(dst) and os.path.getsize(dst) > 0:
                print(f"  #{cid:<3} skip (exists)", flush=True); continue
            # resilient: a transient browser hiccup shouldn't kill the batch
            for attempt in (1, 2, 3):
                try:
                    out, sz = render_one(page, port, cid, args.res, args.fps, args.crf, td)
                    print(f"  #{cid:<3} -> {os.path.basename(out)}  {sz/1_048_576:.1f} MB", flush=True)
                    break
                except Exception as e:
                    print(f"  #{cid:<3} attempt {attempt} failed: {str(e).splitlines()[0]}", flush=True)
                    try: page.close()
                    except Exception: pass
                    page = browser.new_page(device_scale_factor=1)
            else:
                print(f"  #{cid:<3} GAVE UP after 3 tries", flush=True)
        browser.close()
    httpd.shutdown()
    print("done:", OUT)

if __name__ == "__main__":
    main()
