#!/usr/bin/env python3
"""
make-collage.py — tight N×N mp4 collages of the live glass bioms.

Each cell is a live capture of glass-500.html?id=N&token=1 (one biom, no UI),
recorded off the canvas via MediaRecorder, then tiled edge-to-edge with ffmpeg
(hstack rows + vstack). No frames, no gaps, nothing extra.

    python3 scripts/make-collage.py                 # 3x3, 4x4, 8x8
    python3 scripts/make-collage.py --grids 4       # just 4x4
    python3 scripts/make-collage.py --cell 256 --dur 6
"""
import argparse, base64, functools, http.server, os, socket, socketserver, subprocess, sys, tempfile, threading
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT  = os.path.join(ROOT, "collage")

def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *a, **k: None
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close()
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port

def ids_for(n, total=500):
    k = n * n
    return [int(round(1 + i * (total - 1) / (k - 1))) for i in range(k)]

REC_JS = """
async ([fps, dur]) => {
  const c = document.querySelector('canvas');
  const stream = c.captureStream(fps);
  const rec = new MediaRecorder(stream, {mimeType:'video/webm;codecs=vp9', videoBitsPerSecond: 10_000_000});
  const chunks = []; rec.ondataavailable = e => e.data.size && chunks.push(e.data);
  const stopped = new Promise(r => rec.onstop = r);
  rec.start();
  await new Promise(r => setTimeout(r, dur * 1000));
  rec.stop(); await stopped;
  const buf = await new Blob(chunks, {type:'video/webm'}).arrayBuffer();
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}
"""

def record_cell(page, port, cid, cell, fps, dur):
    page.set_viewport_size({"width": cell, "height": cell})
    page.goto(f"http://127.0.0.1:{port}/glass-500.html?id={cid}&token=1", wait_until="load")
    page.wait_for_function("window.__biomReady === true", timeout=30000)
    page.wait_for_timeout(400)  # let a few frames settle
    return base64.b64decode(page.evaluate(REC_JS, [fps, dur]))

def tile(cells, n, fps, dur, out_path):
    filt = ""
    for r in range(n):
        ins = "".join(f"[{r*n+c}:v]" for c in range(n))
        filt += f"{ins}hstack=inputs={n}[row{r}];"
    filt += "".join(f"[row{r}]" for r in range(n)) + f"vstack=inputs={n}[out]"
    cmd = ["ffmpeg", "-y"]
    for f in cells:
        cmd += ["-i", f]
    cmd += ["-filter_complex", filt, "-map", "[out]",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-r", str(fps), "-t", str(dur),
            "-movflags", "+faststart", out_path]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--grids", type=int, nargs="*", default=[3, 4, 8])
    ap.add_argument("--cell", type=int, default=256)
    ap.add_argument("--dur", type=float, default=6.0)
    ap.add_argument("--fps", type=int, default=30)
    args = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    httpd, port = serve(ROOT)
    print(f"serving on :{port}")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, args=[
            "--use-gl=angle", "--use-angle=metal", "--ignore-gpu-blocklist",
            "--enable-features=Vulkan", "--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page()
        for n in args.grids:
            ids = ids_for(n)
            print(f"\n{n}x{n}: {len(ids)} cells -> ids {ids[0]}..{ids[-1]}")
            with tempfile.TemporaryDirectory() as td:
                cells = []
                for i, cid in enumerate(ids):
                    data = record_cell(page, port, cid, args.cell, args.fps, args.dur)
                    fp = os.path.join(td, f"c{i:03d}.webm")
                    open(fp, "wb").write(data)
                    cells.append(fp)
                    print(f"  [{i+1}/{len(ids)}] id={cid}  {len(data)//1024} KB", flush=True)
                out = os.path.join(OUT, f"collage-{n}x{n}.mp4")
                print(f"  tiling -> {out}")
                tile(cells, n, args.fps, args.dur, out)
        browser.close()
    httpd.shutdown()
    print("\ndone:", OUT)

if __name__ == "__main__":
    main()
