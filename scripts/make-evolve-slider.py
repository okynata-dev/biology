#!/usr/bin/env python3
"""
make-evolve-slider.py — Apple-style before/after SLIDER reel, square, no text.

One token fills the square canvas (OpenSea cream look, breathing). A thin
vertical divider sweeps across it; everything the divider has passed shows
the EVOLVED form — same organism, same framing, only pigment / organelles /
biofilm-halo change — so the token transforms in place as the line moves,
rather than a second token sliding over it. Eases in, holds on the evolved
result, then cuts to the next example. No captions.

Usage:
    python3 scripts/make-evolve-slider.py
    python3 scripts/make-evolve-slider.py --seeds 2,65 --secs 2.6

Requires playwright (+chromium), ffmpeg, Pillow, certifi.
"""
import argparse, http.server, socketserver, subprocess, tempfile, threading, platform
import json as _json, ssl, urllib.request
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
DESKTOP = Path.home() / "Desktop"
DEFAULT_SEEDS = [2, 5, 11, 23, 38, 49, 65, 91, 130, 161]

CANVAS = 1080
FPS = 30
SWEEP_FRAC = 0.70      # fraction of each clip spent sweeping; rest holds evolved


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
        headers={"User-Agent": "Mozilla/5.0 (bioms slider)"})
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


def render_frames(page, port, seed, secs, extra, tmp, tag):
    """Full-canvas frame sequence of the token's OpenSea render (cream, no
    cutout), one seamless `secs` loop. Returns list of PIL images (CANVAS²)."""
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
    frames = []
    for i in range(n):
        page.evaluate("(t) => window.__seek(t)", i / FPS)
        fp = fdir / f"f{i:04d}.png"
        page.screenshot(path=str(fp))
        im = Image.open(fp).convert("RGB").resize((CANVAS, CANVAS), Image.LANCZOS)
        frames.append(im)
    return frames


def smoothstep(x):
    x = max(0.0, min(1.0, x))
    return x * x * (3 - 2 * x)


def draw_handle(img, x):
    """Frosted divider line + round handle with two chevrons at center."""
    d = ImageDraw.Draw(img, "RGBA")
    H = img.height
    # soft shadow then crisp line
    d.line([(x, 0), (x, H)], fill=(0, 0, 0, 40), width=6)
    d.line([(x, 0), (x, H)], fill=(255, 255, 255, 230), width=3)
    r = 34
    cy = H // 2
    d.ellipse([x - r, cy - r, x + r, cy + r], fill=(255, 255, 255, 235),
              outline=(0, 0, 0, 25), width=1)
    ink = (60, 48, 38, 255)
    # left chevron
    d.line([(x - 9, cy), (x - 2, cy - 8)], fill=ink, width=3)
    d.line([(x - 9, cy), (x - 2, cy + 8)], fill=ink, width=3)
    # right chevron
    d.line([(x + 9, cy), (x + 2, cy - 8)], fill=ink, width=3)
    d.line([(x + 9, cy), (x + 2, cy + 8)], fill=ink, width=3)
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seeds", default=",".join(map(str, DEFAULT_SEEDS)))
    ap.add_argument("--secs", type=float, default=2.6)
    ap.add_argument("--port", type=int, default=8795)
    ap.add_argument("--out", default=str(DESKTOP / "bioms-evolution.mp4"))
    a = ap.parse_args()
    seeds = [int(s) for s in a.seeds.split(",") if s.strip()]
    subprocess.run(["ffmpeg", "-version"], check=True, capture_output=True)

    tmp = Path(tempfile.mkdtemp(prefix="bioms-slider-"))
    httpd = serve(ROOT, a.port)
    chrome = find_chrome()
    print(f"  server :{a.port} · {len(seeds)} examples · {a.secs}s · slider {CANVAS}")

    segments = []
    with sync_playwright() as p:
        launch = {"headless": True}
        if chrome:
            launch["executable_path"] = chrome
        browser = p.chromium.launch(**launch)
        page = browser.new_context(viewport={"width": 540, "height": 540},
                                   device_scale_factor=2).new_page()
        for idx, seed in enumerate(seeds):
            base = render_frames(page, a.port, seed, a.secs, "", tmp, "base")
            evo = render_frames(page, a.port, seed, a.secs, mutation_params(seed), tmp, "evo")
            n = min(len(base), len(evo))
            outdir = tmp / f"out_{seed}"
            outdir.mkdir(exist_ok=True)
            for i in range(n):
                prog = smoothstep((i / n) / SWEEP_FRAC)   # 0→1 over sweep window
                x = int(round(CANVAS * prog))
                frame = base[i].copy()                    # right of line = original
                if x > 0:                                 # left of line = evolved
                    frame.paste(evo[i].crop((0, 0, x, CANVAS)), (0, 0))
                if 0 < x < CANVAS:
                    draw_handle(frame, x)
                frame.save(outdir / f"o{i:04d}.jpg", "JPEG", quality=92)
            seg = tmp / f"seg_{idx:02d}.mp4"
            subprocess.run([
                "ffmpeg", "-y", "-loglevel", "error", "-framerate", str(FPS),
                "-i", str(outdir / "o%04d.jpg"), "-c:v", "libx264", "-preset", "slow",
                "-crf", "18", "-pix_fmt", "yuv420p", str(seg)], check=True)
            segments.append(seg)
            print(f"  [{idx+1}/{len(seeds)}] #{seed}")
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
