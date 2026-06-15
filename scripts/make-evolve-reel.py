#!/usr/bin/env python3
"""
make-evolve-reel.py — animated before→after evolution reel, SQUARE, no text.

For each example token it renders two short LOOPING clips the way the
token actually shows on OpenSea (cream card, no cutout): the original
mint and the evolved form. Then it composites them side by side in a
square frame — rounded "icon" tiles with a glass arrow between — and
concatenates the examples (default 2s each) into one square MP4 on the
Desktop. Both bioms are live (breathing), no captions.

Usage:
    python3 scripts/make-evolve-reel.py
    python3 scripts/make-evolve-reel.py --seeds 2,5,65 --secs 2

Requires playwright (+chromium), ffmpeg, Pillow, certifi.
"""
import argparse, http.server, socketserver, subprocess, tempfile, threading, time, platform
import json as _json, ssl, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = Path.home() / "Desktop"
DEFAULT_SEEDS = [2, 5, 11, 23, 38, 49, 65, 91, 130, 161]

CANVAS = 1080          # square output
TILE = 452             # each token tile
FPS = 25
CREAM = (236, 231, 220)


def find_chrome():
    if platform.system() == "Darwin":
        p = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        if Path(p).exists():
            return p
    return None


def serve(directory, port):
    h = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", port), h)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def mutation_params(seed):
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    req = urllib.request.Request(
        f"https://api.thebioms.com/api/state/{seed}",
        headers={"User-Agent": "Mozilla/5.0 (bioms reel)"})
    try:
        with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
            body = _json.load(r)
    except Exception:
        return ""
    m = body.get("mutations") or {}
    parts = []
    if m.get("palette"):    parts.append(f"&forceStain={m['palette']}")
    if m.get("organelles"): parts.append(f"&forceOrganelles={','.join(m['organelles'])}")
    an = m.get("anomalies") or []
    if "phageAttached" in an: parts.append("&forcePhage=1")
    if "endosymbiont" in an:  parts.append("&forceEndo=1")
    if "biofilmHalo" in an:   parts.append("&forceBiofilm=1")
    if body.get("receivedCells") is not None: parts.append(f"&forceCells={body['receivedCells']}")
    return "".join(parts)


def render_clip(page, port, seed, secs, extra, tmp, tag):
    """Render a `secs`-second seamless loop of the token's OpenSea render
    (cream card, no cutout) as a frame sequence → mp4. Returns path."""
    url = (f"http://127.0.0.1:{port}/preview.html?seed={seed}"
           f"&loop={secs}&render=1{extra}")
    page.goto(url, wait_until="load", timeout=30000)
    page.wait_for_function("window.__biomReady === true", timeout=12000)
    if not page.evaluate("() => typeof window.__seek === 'function'"):
        raise RuntimeError("no __seek")
    page.evaluate("() => { const r=document.getElementById('downloadCtaRow'); if(r) r.style.display='none'; }")
    fdir = tmp / f"{tag}_{seed}"
    fdir.mkdir(exist_ok=True)
    n = int(round(secs * FPS))
    for i in range(n):
        page.evaluate("(t) => window.__seek(t)", i / FPS)
        page.screenshot(path=str(fdir / f"f{i:04d}.jpg"), type="jpeg", quality=92)
    out = tmp / f"{tag}_{seed}.mp4"
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
        "-i", str(fdir / "f%04d.jpg"), "-c:v", "libx264", "-preset", "fast",
        "-crf", "18", "-pix_fmt", "yuv420p", str(out)], check=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default=",".join(map(str, DEFAULT_SEEDS)))
    ap.add_argument("--secs", type=float, default=2.0)
    ap.add_argument("--port", type=int, default=8793)
    ap.add_argument("--out", default=str(DESKTOP / "bioms-evolution.mp4"))
    a = ap.parse_args()
    seeds = [int(s) for s in a.seeds.split(",") if s.strip()]
    subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True)

    tmp = Path(tempfile.mkdtemp(prefix="bioms-reel2-"))

    # Rounded-corner alpha mask (Apple-ish squircle approximation).
    mask = Image.new("L", (TILE, TILE), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, TILE - 1, TILE - 1], radius=int(TILE * 0.22), fill=255)
    mask.save(tmp / "mask.png")

    # Glass arrow PNG (frosted disc + ember arrow).
    A = 150
    arrow = Image.new("RGBA", (A, A), (0, 0, 0, 0))
    d = ImageDraw.Draw(arrow)
    d.ellipse([4, 4, A - 4, A - 4], fill=(255, 255, 255, 150), outline=(255, 255, 255, 210), width=2)
    cy = A // 2
    d.line([A * 0.30, cy, A * 0.66, cy], fill=(184, 73, 44, 255), width=8)
    d.line([A * 0.54, cy - 18, A * 0.70, cy], fill=(184, 73, 44, 255), width=8)
    d.line([A * 0.54, cy + 18, A * 0.70, cy], fill=(184, 73, 44, 255), width=8)
    arrow.save(tmp / "arrow.png")

    httpd = serve(ROOT, a.port)
    chrome = find_chrome()
    print(f"  server :{a.port} · {len(seeds)} examples · {a.secs}s · square {CANVAS}")

    segments = []
    with sync_playwright() as p:
        launch = {"headless": True}
        if chrome:
            launch["executable_path"] = chrome
        browser = p.chromium.launch(**launch)
        page = browser.new_context(viewport={"width": 600, "height": 600},
                                   device_scale_factor=2).new_page()
        for i, seed in enumerate(seeds):
            base = render_clip(page, a.port, seed, a.secs, "", tmp, "base")
            evo = render_clip(page, a.port, seed, a.secs, mutation_params(seed), tmp, "evo")

            # Composite: cream square, two rounded tiles, glass arrow centered.
            gap = 56
            total_w = TILE * 2 + gap
            lx = (CANVAS - total_w) // 2
            rx = lx + TILE + gap
            ty = (CANVAS - TILE) // 2
            seg = tmp / f"seg_{i:02d}.mp4"
            fc = (
                f"color=c=0x{CREAM[0]:02x}{CREAM[1]:02x}{CREAM[2]:02x}:s={CANVAS}x{CANVAS}:d={a.secs}[bg];"
                f"[3:v]scale={TILE}:{TILE},format=gray[ma];"
                f"[4:v]scale={TILE}:{TILE},format=gray[mb];"
                f"[0:v]scale={TILE}:{TILE},format=rgba[l0];[l0][ma]alphamerge[L];"
                f"[1:v]scale={TILE}:{TILE},format=rgba[r0];[r0][mb]alphamerge[R];"
                f"[bg][L]overlay={lx}:{ty}[b1];"
                f"[b1][R]overlay={rx}:{ty}[b2];"
                f"[b2][2:v]overlay=(W-w)/2:(H-h)/2[out]"
            )
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(base), "-i", str(evo), "-i", str(tmp / "arrow.png"),
                "-i", str(tmp / "mask.png"), "-i", str(tmp / "mask.png"),
                "-filter_complex", fc, "-map", "[out]",
                "-t", str(a.secs), "-r", str(FPS),
                "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
                str(seg)], check=True)
            segments.append(seg)
            print(f"  [{i+1}/{len(seeds)}] #{seed}")
        browser.close()

    listf = tmp / "list.txt"
    listf.write_text("".join(f"file '{s}'\n" for s in segments))
    subprocess.run([
        "ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
        "-i", str(listf), "-c:v", "libx264", "-preset", "slow", "-crf", "18",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", a.out], check=True)
    httpd.shutdown()
    kb = Path(a.out).stat().st_size / 1024
    print(f"\nDone → {a.out}  ({kb:.0f} KB, {len(seeds)*a.secs:.0f}s, {CANVAS}x{CANVAS})")


if __name__ == "__main__":
    main()
