# Bioms

> *3,000 procedural microbial specimens. Glass-morph aesthetic. Series I, 2026.*

A generative NFT collection of microscopic life forms. Each Biom is rendered client-side from a single integer seed using a deterministic procedural genome — 11 morphologies, 12 staining systems, 10 organelle types, reserve granules, lifecycle states, and ultra-rare anomalies.

- **Live site**: [thebioms.com](https://thebioms.com)
- **Twitter / X**: [@theBioms](https://twitter.com/theBioms)
- **Network**: Ethereum
- **Supply**: 3,000 specimens (Series I)

---

## What's in this repo

### Frontend (static HTML/JS — deploys to Cloudflare Pages)

| File | What it does |
|---|---|
| `index.html` | Landing page — hero, stain showcase, demo |
| `preview.html` | Main specimen renderer (animation_url for NFT metadata). Reads `?seed=N` and renders the corresponding Biom with breathing animation and mouse parallax. |
| `make.html` | Banner Maker — pick a Biom, choose format (Twitter Header, OpenSea Banner, 4K Desktop, custom...), drag/scale/rotate, export single PNG or full asset pack. Uses the pre-rendered master PNG (`{PNG_BASE}/preview/NNNNN.png`) and composites it onto the target canvas. Falls back to a local 2D-canvas renderer if the PNG is missing. |
| `explore.html` | Trait Explorer — each trait card is a pre-rendered PNG from `/pngs/explore/{cat}-{id}.png` (populated by `batch_explore.py`). |
| `404.html` | Branded 404 page served by Cloudflare Pages for unknown paths |
| `asset-template.html` | Template used by `batch_screenshots.py` for downloadable assets (Twitter headers, banners, etc.) at fixed dimensions |
| `specimen-engine.js` | **Shared rendering engine.** All trait generation + DOM and Canvas renderers. Used by `make.html`; the engine is mirrored inline in `preview.html` for legacy reasons (kept in sync). |
| `favicon.svg`, `og-image.png` | Brand assets — favicon and social-share card |
| `sitemap.xml`, `robots.txt`, `_headers` | SEO + caching config |

### Mint pipeline (Python — runs locally, not deployed)

| File | What it does |
|---|---|
| `generate_metadata.py` | Generates 3,000 ERC-721-compatible JSON metadata files. **RNG parity-verified against the JS engine — same seed always produces identical traits.** |
| `batch_screenshots.py` | Headless Chromium (via Playwright) renders all 3,000 master preview PNGs from `preview.html`. Output feeds both the NFT `image` field **and** the Banner Maker's HQ source. Render large (≥ 2400 px) so banners look crisp at 4K and beyond. |
| `batch_explore.py` | Renders the 46 trait-isolation PNGs consumed by `explore.html` and the landing stain showcase. Run once, output goes to `pngs/explore/`. Total ~10 MB at 1200 px. |

## Local development

Most files work via `file://` (double-click in Finder), with two caveats:

- `make.html` and `explore.html` load `specimen-engine.js` — Chrome blocks `<script src="…">` for local files. **Either** use `python3 -m http.server 8000` in this folder and visit `http://localhost:8000/`, **or** drag the file into Chrome (some browsers allow this with file URLs).
- `preview.html`, `index.html`, `asset-template.html` work standalone.

---

## Mint pipeline (run before launch)

```bash
# 1. Install Playwright (Mac only; for other OS see Playwright docs)
pip3 install playwright
python3 -m playwright install chromium

# 2. Render all 3,000 master PNGs at high resolution (~2–3 h on M1/M2 at 3000 px).
#    These PNGs are the source-of-truth for the NFT `image` field AND the
#    Banner Maker's HQ export source.
mkdir -p pngs/preview
python3 batch_screenshots.py preview.html ./pngs/preview 3000 --workers 6 --size 3000

# 3. Render the 46 trait-isolation PNGs for explore.html and the landing
#    stain showcase (~5 min). Output is small (~10 MB total).
mkdir -p pngs/explore
python3 batch_explore.py ./pngs/explore --workers 4 --size 1200

# 4. Generate metadata JSON files
mkdir -p metadata
python3 generate_metadata.py ./metadata 3000 \
    --base-image-uri https://pngs.thebioms.com/preview \
    --base-animation-uri https://thebioms.com/preview.html

# 5. Host pngs/ — see "Hosting pre-rendered PNGs" below
# 6. Deploy contract via OpenSea Studio Drop with tokenURI prefix:
#    https://thebioms.com/metadata/  (Studio appends .json)
```

### Hosting pre-rendered PNGs

3,000 master PNGs at 3000×3000 is ~3 GB total — too big to commit to GitHub. Recommended path: **Cloudflare R2** (free up to 10 GB storage, zero egress charges on Workers Paid).

1. Cloudflare dashboard → **R2 → Create bucket**, name it `bioms-pngs`
2. Upload `pngs/preview/*.png` (use the dashboard for small batches, or `wrangler r2 object put` for scripted upload)
3. R2 → bucket → **Settings → Custom Domain → Add**: `pngs.thebioms.com`
4. **R2 → bucket → Settings → CORS Policy**: allow `GET` from `https://thebioms.com` and `https://*.pages.dev`
5. In `make.html` near the top of the `<script>` block, set:
   ```js
   const PNG_BASE = 'https://pngs.thebioms.com';
   ```
   (Leave empty if you'd rather serve PNGs from this Pages project at `/preview/N.png` — works fine but counts against Pages bandwidth, and requires committing the `pngs/preview/` directory contents to the repo at the project root.)

## Deployment

### Cloudflare Pages

1. Push this repo to GitHub.
2. In Cloudflare dashboard: Pages → Create project → Connect to Git → select the repo.
3. Build settings:
   - **Framework preset**: None
   - **Build command**: (leave empty)
   - **Build output directory**: `/`
4. Add custom domain `thebioms.com` (Cloudflare DNS needs to manage the domain).
5. Push to `main` → auto-deploy.

### Email on `thebioms.com` (free)

Cloudflare → your domain → Email → Email Routing → Enable. Add forwarding rules:

- `hello@thebioms.com` → your Gmail
- `collect@thebioms.com` → your Gmail
- (anything you want)

Set up "Send as" in Gmail to reply from `hello@thebioms.com`.

### Web Analytics (optional, free, privacy-friendly)

Cloudflare Web Analytics tracks visitors without cookies, third-party scripts, or any PII. Two ways to enable:

1. **Automatic (zero-code)** — Cloudflare dashboard → your `thebioms.com` zone → **Analytics & Logs → Web Analytics → Enable automatic setup**. Cloudflare injects the beacon at the edge. Recommended.
2. **Manual** — if you want to control which pages are tracked, get a beacon token from the same dashboard and add this to the `<head>` of pages you want tracked:

   ```html
   <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "YOUR_TOKEN"}'></script>
   ```

---

## Roadmap (Phase 2)

When the collection mints and there's holder demand:

### Lab — trait conjugation

Holders connect their wallet → see their Bioms → splice traits between them. Real bacterial conjugation as game mechanic: pilus transfers plasmid, donor's trait moves to recipient, donor regenerates the trait after 30 days, ~10–20% rejection rate.

**Phase 1 (Visual mockup, no backend)** — UI/UX prototype, mutations live in memory only. Can build now.

**Phase 2 (Persisted, OpenSea-visible)** — requires:
- Cloudflare Workers (`/api/metadata/:id`, `/api/conjugate`, etc.)
- Cloudflare D1 (SQLite) for mutations / cooldowns / failure RNG
- Custom `tokenURI` returning a dynamic endpoint instead of static JSON

See chat history for full design.

---

## Tech stack

- **Frontend**: vanilla HTML/CSS/JS — no framework, no build step. Loads in a single network round-trip per page.
- **Rendering**: DOM panels with `backdrop-filter` for the live preview; HQ PNG export composites the pre-rendered master PNG via `canvas.drawImage` (zero server, infinite scale). Native 2D Canvas fallback if a master PNG is missing.
- **RNG**: `mulberry32` deterministic PRNG, identical implementation in JS (`specimen-engine.js`, `preview.html`) and Python (`generate_metadata.py`). 3000/3000 trait parity verified.
- **Metadata standard**: ERC-721 + OpenSea extensions

---

## License

Source code: MIT (do whatever).
Artwork / generated specimens: holders retain their token rights per OpenSea standard.

Built by [@timsouw](https://twitter.com/timsouw) · 2026
