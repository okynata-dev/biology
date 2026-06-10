#!/usr/bin/env python3
"""
make-videos.py — render a SEAMLESSLY LOOPING MP4 of every biom.

Each output is a square H.264 MP4 of the biom's idle motion that loops with
no visible seam (the last frame's motion state is identical to the first),
suitable for the "Download MP4" CTA in preview.html, embeds, and Twitter /
Discord / Telegram posts.

How the seamless loop works:
  The live engine's idle motion is a sum of sines with INCOMMENSURATE
  frequencies — it never exactly repeats, so a naive recording jumps on
  loop. preview.html's ?loop=N mode snaps every motion frequency to a whole
  number of cycles per N seconds, making the motion EXACTLY N-periodic:
  frame at t=N == frame at t=0. We then render frames DETERMINISTICALLY via
  window.__seek(t) (t = frame/fps), so the clip is a perfect, jitter-free
  loop — no real-time capture, no dropped/duplicated frames, no minterpolate.

  The live token (animation_url, no params) is untouched: ?loop is a no-op
  there, so OpenSea keeps the infinite, non-quantized motion.

Pipeline per seed:
  Playwright opens preview.html?seed=N&loop=LOOP&render=1
    ↓ waits for window.__biomReady
    ↓ hides the Download CTAs
    ↓ for i in 0..LOOP*fps-1: __seek(i/fps) → screenshot frame
    ↓ ffmpeg encodes the PNG sequence → H.264 MP4 (+faststart, no audio)
    ↓ writes pngs/video/{seed:05d}.mp4

Seeds map to token IDs by identity (SeaDrop is 1-indexed): tokens are
1..3000, so the default render range is 1..3000. (Old 0-indexed batches
left a stray 00000.mp4; it's unused — no token 0 — and harmless.)

Usage:
    python3 scripts/make-videos.py                  # all tokens 1..3000
    python3 scripts/make-videos.py --only 44,132    # specific seeds
    python3 scripts/make-videos.py --workers 4      # parallel browsers
    python3 scripts/make-videos.py --loop 16        # loop length (s)
    python3 scripts/make-videos.py --fps 30 --size 1080

Mutated tokens (post-burn survivors):
    python3 scripts/make-videos.py --only 161,49 --mutated
  --mutated fetches each seed's Lab mutations from
  https://api.thebioms.com/api/state/<seed> and appends the same force-*
  params the metadata animation_url uses (forceStain, forceOrganelles,
  forcePhage/Endo/Biofilm), so the loop shows the POST-BURN organism.
  Without it the video is the base seed render. After each burn the
  survivor's video goes stale — re-run for the survivor + upload.

After running, upload via:
    bash scripts_upload_videos.sh

Requires:
    - playwright (pip install playwright; python3 -m playwright install chromium)
    - ffmpeg in PATH (brew install ffmpeg)
"""

import argparse
import http.server
import os
import platform
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

from playwright.sync_api import sync_playwright


ROOT = Path(__file__).resolve().parent.parent
DST  = ROOT / "pngs" / "video"


def find_chrome():
    """Auto-detect Chrome / Chromium so output matches the local render.
    None lets Playwright pick its bundled Chromium (CI path)."""
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


def check_ffmpeg():
    if shutil.which("ffmpeg") is None:
        print("ERROR: ffmpeg not found in PATH. Install via `brew install ffmpeg` (mac) "
              "or `apt install ffmpeg` (linux).", file=sys.stderr)
        sys.exit(1)


def start_server(directory, port):
    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=str(directory), **k)
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    th = threading.Thread(target=httpd.serve_forever, daemon=True)
    th.start()
    return httpd


def encode_frames(frame_glob: Path, mp4_path: Path, fps: int, crf: int):
    """Encode a deterministic frame sequence into a looping H.264 MP4.

    No minterpolate (frames are already the exact per-time states), no head
    trim (deterministic render never has a loading flash). -tune animation
    suits the flat-colour / glass / gradient content; +faststart lets players
    begin before the file finishes; -an drops the (absent) audio track.
    The clip is exactly one motion period, so it loops with no seam."""
    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-framerate", str(fps),
        "-i", str(frame_glob),
        "-c:v", "libx264",
        "-preset", "slow",
        "-tune", "animation",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",        # max compatibility (iOS Safari, Twitter)
        "-movflags", "+faststart",
        "-an",
        str(mp4_path),
    ]
    subprocess.run(cmd, check=True)


def mutation_params(seed: int) -> str:
    """Fetch the seed's Lab mutations from the live API and translate them
    into the same force-* preview params buildMetadata puts in the token's
    animation_url. Returns '' for unmutated tokens. Fail-loud: a network
    error raises, because silently rendering the BASE look for a mutated
    token is exactly the bug this flag exists to prevent."""
    import json as _json
    import ssl
    import urllib.request
    # python.org macOS builds ship without system CA certs — use certifi
    # (present in this venv via playwright's deps) so HTTPS verifies.
    try:
        import certifi
        ctx = ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        ctx = ssl.create_default_context()
    # Plain urllib UA gets 403'd by Cloudflare bot rules — send a browser-ish
    # one; this is our own API and the endpoint is public.
    req = urllib.request.Request(
        f"https://api.thebioms.com/api/state/{seed}",
        headers={"User-Agent": "Mozilla/5.0 (bioms make-videos script)"},
    )
    with urllib.request.urlopen(req, timeout=15, context=ctx) as r:
        m = _json.load(r).get("mutations") or {}
    parts = []
    if m.get("palette"):
        parts.append(("forceStain", m["palette"]))
    if m.get("organelles"):
        parts.append(("forceOrganelles", ",".join(m["organelles"])))
    anomalies = m.get("anomalies") or []
    if "phageAttached" in anomalies: parts.append(("forcePhage", "1"))
    if "endosymbiont" in anomalies:  parts.append(("forceEndo", "1"))
    if "biofilmHalo" in anomalies:   parts.append(("forceBiofilm", "1"))
    from urllib.parse import urlencode
    return ("&" + urlencode(parts)) if parts else ""


def render_one(port: int, seed: int, size: int, loop_s: float, fps: int,
               crf: int, chrome_path, extra: str = ""):
    """Render one biom's seamless loop. A fresh context per seed keeps state
    clean; deterministic __seek stepping makes the loop exact."""
    frames = int(round(loop_s * fps))
    with sync_playwright() as p:
        launch_args = {"headless": True}
        if chrome_path:
            launch_args["executable_path"] = chrome_path
        browser = p.chromium.launch(**launch_args)
        tmpdir = Path(tempfile.mkdtemp(prefix="bioms-loop-"))
        try:
            ctx = browser.new_context(
                viewport={"width": size, "height": size},
                device_scale_factor=1,
            )
            page = ctx.new_page()
            url = (f"http://127.0.0.1:{port}/preview.html"
                   f"?seed={seed}&loop={loop_s}&render=1{extra}")
            page.goto(url, wait_until="load", timeout=20000)
            page.wait_for_function("window.__biomReady === true", timeout=12000)
            # The seamless-loop math + deterministic stepping live in the page;
            # __seek must exist or we'd silently record a frozen frame.
            if not page.evaluate("() => typeof window.__seek === 'function'"):
                return (seed, False, "no __seek (loop/render mode not active)")
            # Drop the standalone Download CTAs so they don't bake into frames.
            page.evaluate(
                "() => { const r = document.getElementById('downloadCtaRow');"
                " if (r) r.style.display = 'none'; }"
            )
            for i in range(frames):
                page.evaluate("(t) => window.__seek(t)", i / fps)
                # JPEG, not PNG: PNG encoding is ~5× slower (170ms vs 34ms
                # per 800px frame) and dominates wall-time at 480 frames/seed.
                # q95 is visually lossless for this ambient glass content, and
                # ffmpeg re-encodes to H.264 (yuv420p) anyway, so the
                # intermediate codec adds no perceptible degradation.
                page.screenshot(path=str(tmpdir / f"f{i:05d}.jpg"),
                                type="jpeg", quality=95)
            ctx.close()

            padded = f"{seed:05d}"
            mp4 = DST / f"{padded}.mp4"
            encode_frames(tmpdir / "f%05d.jpg", mp4, fps, crf)
            return (seed, True, None)
        except Exception as e:
            return (seed, False, f"{type(e).__name__}: {e}")
        finally:
            browser.close()
            shutil.rmtree(tmpdir, ignore_errors=True)


def worker_run(worker_idx: int, seeds_chunk, port: int, size: int,
               loop_s: float, fps: int, crf: int, chrome_path, extras=None):
    results = []
    for i, seed in enumerate(seeds_chunk):
        extra = (extras or {}).get(seed, "")
        r = render_one(port, seed, size, loop_s, fps, crf, chrome_path, extra)
        results.append(r)
        if (i + 1) % 10 == 0:
            ok_so_far = sum(1 for _, ok, _ in results if ok)
            print(f"  [w{worker_idx}] {i+1}/{len(seeds_chunk)}  ok={ok_so_far}", flush=True)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="Comma-separated seed list (default: tokens 1..3000)")
    ap.add_argument("--size", type=int, default=1080,
                    help="Square render size (default 1080 — social-friendly).")
    ap.add_argument("--loop", type=float, default=16.0,
                    help="Loop length in seconds (default 16). The motion is "
                         "quantized to be exactly periodic over this window.")
    ap.add_argument("--fps", type=int, default=30,
                    help="Output framerate (default 30). Frames are rendered "
                         "deterministically at t=frame/fps — no interpolation.")
    ap.add_argument("--crf", type=int, default=18,
                    help="H.264 quality (lower = better, larger). 14=archival, "
                         "18=visually lossless (default), 23=YouTube.")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--workers", type=int, default=2,
                    help="Parallel browsers. Each holds ~250 MB; 4 is comfortable on M1.")
    ap.add_argument("--mutated", action="store_true",
                    help="Fetch each seed's Lab mutations from the live API and "
                         "bake them into the render (post-burn survivors).")
    args = ap.parse_args()

    check_ffmpeg()

    if args.only:
        seeds = [int(s) for s in args.only.split(",")]
    else:
        # Tokens are 1..3000 (SeaDrop 1-indexed); seed == tokenId by identity.
        seeds = list(range(1, 3001))

    extras = {}
    if args.mutated:
        for s in seeds:
            extras[s] = mutation_params(s)
            label = extras[s] or "(no mutations — base render)"
            print(f"  → state {s}: {label}")

    DST.mkdir(parents=True, exist_ok=True)
    chrome = find_chrome()

    httpd = start_server(ROOT, args.port)
    frames = int(round(args.loop * args.fps))
    print(f"  → static server on :{args.port} (root: {ROOT})")
    print(f"  → {len(seeds)} seeds · {args.size}px · {args.loop}s loop · {args.fps}fps "
          f"({frames} frames/seed) · {args.workers} worker(s)")
    if chrome:
        print(f"  → using Chrome: {chrome}")
    t0 = time.time()

    chunks = [[] for _ in range(args.workers)]
    for i, s in enumerate(seeds):
        chunks[i % args.workers].append(s)

    all_results = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(worker_run, i, chunk, args.port, args.size,
                        args.loop, args.fps, args.crf, chrome, extras)
            for i, chunk in enumerate(chunks) if chunk
        ]
        for f in as_completed(futures):
            all_results.extend(f.result())

    ok = sum(1 for _, k, _ in all_results if k)
    fail = [(s, e) for s, k, e in all_results if not k]
    dt = time.time() - t0
    per = dt / max(1, len(seeds))
    print(f"\nDone: {ok}/{len(seeds)} in {dt:.0f}s ({per:.1f}s/seed)")
    if fail:
        print(f"Failed: {len(fail)}")
        for s, e in fail[:10]:
            print(f"  {s:05d}  {e}")
    if ok > 0:
        sample = sorted([s for s, k, _ in all_results if k])[0]
        mp4 = DST / f"{sample:05d}.mp4"
        if mp4.exists():
            print(f"Sample size: {mp4.stat().st_size/1024:.1f} KB ({mp4})")

    httpd.shutdown()


if __name__ == "__main__":
    main()
