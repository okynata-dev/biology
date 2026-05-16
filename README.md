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
| `make.html` | Banner Maker — pick a Biom, choose format (Twitter Header, OpenSea Banner, 4K Desktop, custom...), drag/scale/rotate, export PNG |
| `explore.html` | Trait Explorer — every trait isolated in its own card with academic-style biology description |
| `rare-aurora.html`, `rare-ghost.html`, `rare-variable.html` | Standalone renderers for rare palettes (used by stain showcase on landing) |
| `asset-template.html` | Template used by `batch_screenshots.py` for downloadable assets (Twitter headers, banners, etc.) at fixed dimensions |
| `specimen-engine.js` | **Shared rendering engine.** All trait generation + DOM and Canvas renderers. Used by `make.html`; the engine is mirrored inline in `preview.html` and the rare files for legacy reasons (kept in sync). |

### Mint pipeline (Python — runs locally, not deployed)

| File | What it does |
|---|---|
| `generate_metadata.py` | Generates 3,000 ERC-721-compatible JSON metadata files. **RNG parity-verified against the JS engine — same seed always produces identical traits.** |
| `batch_screenshots.py` | Headless Chromium (via Playwright) renders all 3,000 preview PNGs from `preview.html` |

## Local development

Most files work via `file://` (double-click in Finder), with two caveats:

- `make.html` and `explore.html` load `specimen-engine.js` — Chrome blocks `<script src="…">` for local files. **Either** use `python3 -m http.server 8000` in this folder and visit `http://localhost:8000/`, **or** drag the file into Chrome (some browsers allow this with file URLs).
- `preview.html`, `rare-*.html`, `index.html`, `asset-template.html` work standalone.

---

## Mint pipeline (run before launch)

```bash
# 1. Install Playwright (Mac only; for other OS see Playwright docs)
pip3 install playwright
python3 -m playwright install chromium

# 2. Render all 3,000 PNGs (~45 min on M1/M2)
mkdir -p pngs/preview
python3 batch_screenshots.py preview.html ./pngs/preview 3000 --workers 6 --size 1500

# 3. Generate metadata JSON files
mkdir -p metadata
python3 generate_metadata.py ./metadata 3000 \
    --base-image-uri https://thebioms.com/pngs/preview \
    --base-animation-uri https://thebioms.com/preview.html

# 4. Commit pngs/ and metadata/ to the repo (or upload to Cloudflare R2)
# 5. Deploy contract via OpenSea Studio Drop with tokenURI prefix:
#    https://thebioms.com/metadata/  (Studio appends .json)
```

## Deployment

### Cloudflare Pages (recommended)

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
- **Rendering engine**: DOM panels with `backdrop-filter` for glass effect + native 2D Canvas for PNG export
- **RNG**: `mulberry32` deterministic PRNG, identical implementation in JS (`specimen-engine.js`, `preview.html`) and Python (`generate_metadata.py`). 3000/3000 trait parity verified.
- **Metadata standard**: ERC-721 + OpenSea extensions

---

## License

Source code: MIT (do whatever).
Artwork / generated specimens: holders retain their token rights per OpenSea standard.

Built by [@timso_eth](https://twitter.com/timso_eth) · 2026
