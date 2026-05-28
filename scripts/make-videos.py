#!/usr/bin/env python3
"""
make-videos.py — record a short looping MP4 of every biom's live render.

Each output is a square H.264 MP4 of the biom's natural breathing animation,
suitable for downloads, embeds, Twitter / Discord posts, and the
"Download MP4" CTA inside preview.html.

Pipeline per seed:
  Playwright launches Chromium with record_video_dir set
    ↓ opens preview.html?seed=N
    ↓ waits for body.engine-ready
    ↓ stays open for VIDEO_DURATION seconds (records every frame)
    ↓ closes page → Playwright finalises the WebM (VP8)
    ↓ ffmpeg converts WebM → MP4 (H.264, +faststart, no audio)
    ↓ writes pngs/video/{seed:05d}.mp4
    ↓ removes the WebM source

Why H.264 / MP4 over native WebM:
  Marketplaces (OpenSea), Twitter, Discord, iOS Mail and a chunk of
  mobile Safari versions render H.264 reliably; VP8 is hit-or-miss on
  those surfaces. The file-size cost is small for a 15s 1080p loop
  (≈ 1 MB), and faststart lets the player begin before the file
  finishes downloading.

Why 15 seconds (and not 60 as originally discussed):
  Breathing-cycle period varies per biom but lives in the 3-5 s band,
  so 15 s gives 3-4 full loops — enough for the eye to read "alive"
  without burning storage or social-platform attention. 60 s files
  are ~4 MB each → 12 GB for the collection, which pushes us past R2
  free tier with no perceptual benefit.

Usage:
    python3 scripts/make-videos.py                  # all 3000
    python3 scripts/make-videos.py --only 44,132    # specific seeds
    python3 scripts/make-videos.py --workers 4      # parallel browsers
    python3 scripts/make-videos.py --duration 20    # longer loops
    python3 scripts/make-videos.py --size 720       # smaller frame

Output:
    pngs/video/00000.mp4
    pngs/video/00001.mp4
    ...

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
    """Auto-detect Chrome / Chromium binary so users get the system render
    they're familiar with. None lets Playwright pick its own."""
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


def webm_to_mp4(webm_path: Path, mp4_path: Path, crf: int, trim_start: float,
                fps: int):
    """ffmpeg convert. CRF 23 is the YouTube-ish quality default; 18-20
    is visually lossless but ~2× file size. -an strips any audio track
    (Bioms are silent). +faststart moves the moov atom to the front so
    players can start before the file finishes downloading.

    trim_start: seconds to skip from the head of the recording. Playwright
    starts recording from context creation, so the first ~0.5-1s of every
    capture is a blank/loading frame before engine-ready fires. Default 1s
    trim drops that cleanly. Pass 0 to keep the full clip.

    fps: target output framerate. Playwright's record_video captures at a
    hard-coded 25 fps on Linux runners, which looks choppy on 60/120 Hz
    displays for slow glass animations. Bumping to 60 fps via ffmpeg's
    `minterpolate` filter generates real motion-compensated intermediate
    frames (not just duplicates), so the breathing reads as smooth.
    Cost: ~3-5× the encode time per file. Pass fps == source rate (25)
    to skip interpolation entirely."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error"]
    if trim_start > 0:
        # -ss BEFORE -i is fast (keyframe seek). We re-encode anyway so
        # the slight inaccuracy doesn't matter, and it cuts the seek
        # overhead vs putting -ss after -i.
        cmd += ["-ss", f"{trim_start}"]
    cmd += ["-i", str(webm_path)]
    if fps > 25:
        # minterpolate parameters tuned for the biom case: slow ambient
        # motion, no rapid scene changes, no occlusion. `mci` (motion
        # compensated interpolation) + `aobmc` (adaptive overlapped block)
        # gives noticeably smoother output than naive frame duplication
        # without tearing or ghost artefacts.
        cmd += ["-vf", f"minterpolate=fps={fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1"]
    cmd += [
        "-c:v", "libx264",
        "-preset", "slow",
        # -tune animation: H.264 preset optimised for content with low
        # spatial detail movement + flat colour areas + glass/gradient
        # details. CRF 23 default looked fine on a fast scrubber but
        # produced ~350 kbps at 1080p60 on slow-ambient biom motion,
        # which the user reported as "choppy/smeary". Decoder simply
        # couldn't reconstruct glass/halo detail at that bit budget.
        # -tune animation + lower CRF gets us to ~1.5 Mbps, smooth.
        "-tune", "animation",
        "-crf", str(crf),
        "-pix_fmt", "yuv420p",          # max compatibility (iOS Safari, Twitter)
        "-movflags", "+faststart",
        "-an",                           # no audio track
        str(mp4_path),
    ]
    subprocess.run(cmd, check=True)


def render_one(port: int, seed: int, size: int, duration_s: float,
               settle_ms: int, crf: int, trim_start: float, fps: int,
               chrome_path):
    """Record one biom. Spins up a fresh Playwright context per seed so
    record_video_dir applies cleanly — the context-per-seed cost (~600ms
    of browser boot) is dwarfed by the recording duration itself.

    The trim_start arg is treated as a MINIMUM: we also measure how long
    Playwright takes to reach `body.engine-ready` from context creation
    and trim AT LEAST that much. On CI the page can take 1.5-2s to paint
    before the engine signals ready; a hard-coded 1.0s trim left a white
    flash at the start of every clip."""
    with sync_playwright() as p:
        launch_args = {"headless": True}
        if chrome_path:
            launch_args["executable_path"] = chrome_path
        browser = p.chromium.launch(**launch_args)
        tmpdir = Path(tempfile.mkdtemp(prefix="bioms-video-"))
        try:
            # Mark when recording starts. record_video_dir captures frames
            # from the moment new_context returns, so we measure from here.
            t_record_start = time.time()
            ctx = browser.new_context(
                viewport={"width": size, "height": size},
                record_video_dir=str(tmpdir),
                record_video_size={"width": size, "height": size},
            )
            page = ctx.new_page()
            # Strip the standalone-only Download CTAs from EVERY paint:
            # preview.html shows them when window.self === window.top (true
            # in our headless context). Without this they'd bake into the
            # video — and a post-load JS remove() leaves a 1-2 frame flash
            # at the start of the recording while the page is parsing.
            # init_script runs before any page script on every navigation,
            # so the !important style block is in place from frame 0.
            # The save-as-PNG context menu wiring is untouched — that menu
            # only renders on right-click, not during passive playback.
            page.add_init_script(
                "document.addEventListener('DOMContentLoaded', () => {"
                "  const s = document.createElement('style');"
                "  s.textContent = '.download-cta-row, .download-cta { display: none !important; }';"
                "  document.head.appendChild(s);"
                "});"
            )
            url = f"http://127.0.0.1:{port}/preview.html?seed={seed}"
            page.goto(url, wait_until="load", timeout=15000)
            page.wait_for_selector("body.engine-ready", timeout=8000)
            # Belt-and-suspenders: also drop the nodes outright in case the
            # !important style is ever beaten by an inline override.
            page.evaluate(
                "document.querySelectorAll('.download-cta-row, .download-cta').forEach(n => n.remove())"
            )
            page.wait_for_timeout(settle_ms)
            # Mark when actual animation starts being captured. Anything
            # before this point in the recording is loading/blank content.
            t_engine_ready = time.time() - t_record_start
            page.wait_for_timeout(int(duration_s * 1000))
            # Closing the context finalises the WebM file. Page must be
            # closed first or Playwright leaves the WebM truncated.
            page.close()
            ctx.close()

            # Playwright writes one .webm into tmpdir — find it.
            webms = list(tmpdir.glob("*.webm"))
            if not webms:
                return (seed, False, "no_webm_produced")
            webm = webms[0]
            padded = f"{seed:05d}"
            mp4 = DST / f"{padded}.mp4"
            # Dynamic trim: at least t_engine_ready (the exact moment the
            # biom started painting), or the user's explicit floor —
            # whichever is larger. A tiny safety pad covers the gap between
            # our timestamp and the first painted frame Playwright captured.
            effective_trim = max(trim_start, t_engine_ready + 0.15)
            webm_to_mp4(webm, mp4, crf, effective_trim, fps)
            return (seed, True, None)
        except Exception as e:
            return (seed, False, f"{type(e).__name__}: {e}")
        finally:
            browser.close()
            shutil.rmtree(tmpdir, ignore_errors=True)


def worker_run(worker_idx: int, seeds_chunk, port: int, size: int,
               duration_s: float, settle_ms: int, crf: int, trim_start: float,
               fps: int, chrome_path):
    results = []
    for i, seed in enumerate(seeds_chunk):
        r = render_one(port, seed, size, duration_s, settle_ms, crf, trim_start,
                       fps, chrome_path)
        results.append(r)
        if (i + 1) % 10 == 0:
            ok_so_far = sum(1 for _, ok, _ in results if ok)
            print(f"  [w{worker_idx}] {i+1}/{len(seeds_chunk)}  ok={ok_so_far}", flush=True)
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", help="Comma-separated seed list (default: 0..2999)")
    ap.add_argument("--size", type=int, default=1080,
                    help="Square render size (default 1080 — Instagram-friendly).")
    ap.add_argument("--duration", type=float, default=15.0,
                    help="Recording length in seconds (default 15).")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--settle", type=int, default=600,
                    help="ms to wait after engine-ready before starting capture.")
    ap.add_argument("--crf", type=int, default=14,
                    help="H.264 quality (lower = better, larger). 14=archival-grade, "
                         "18=visually lossless, 23=YouTube default. Default 14 — the "
                         "2026-05 bake at 23 produced visible smearing on glass details. "
                         "Stepped 23→18→14 over user testing; 14 was the floor before "
                         "files got noticeably bigger without visible improvement.")
    ap.add_argument("--trim-start", type=float, default=1.0,
                    help="Seconds to trim from the head of each clip — drops the blank/"
                         "loading frames before engine-ready. Default 1.0. Pass 0 to keep "
                         "everything.")
    ap.add_argument("--fps", type=int, default=60,
                    help="Output framerate. Playwright captures at a fixed 25 fps; values "
                         "above that trigger ffmpeg motion-interpolation (mci/aobmc) to "
                         "synthesize smooth intermediate frames. 60 reads as visibly "
                         "smoother on 60/120 Hz displays; 25 skips interpolation. "
                         "Default 60.")
    ap.add_argument("--workers", type=int, default=2,
                    help="Parallel browsers. Each holds ~250 MB; 4 is comfortable on M1.")
    args = ap.parse_args()

    check_ffmpeg()

    if args.only:
        seeds = [int(s) for s in args.only.split(",")]
    else:
        seeds = list(range(3000))

    DST.mkdir(parents=True, exist_ok=True)
    chrome = find_chrome()

    httpd = start_server(ROOT, args.port)
    print(f"  → static server on :{args.port} (root: {ROOT})")
    print(f"  → recording {len(seeds)} seeds at {args.size}px for {args.duration}s "
          f"through {args.workers} worker(s)")
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
                        args.duration, args.settle, args.crf, args.trim_start,
                        args.fps, chrome)
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
