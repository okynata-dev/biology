# Bioms — Handoff to Claude Code

You are picking this project up from an earlier Cowork session (Claude Sonnet 4.6, May 2026). Read this file fully **before** doing anything. Then `README.md`. Then start with **Section 1: First Steps**.

---

## TL;DR

**Bioms** is a pre-launch generative NFT collection — 3,000 procedural microbial specimens on Ethereum. The project owner wants you to:

1. Push this repo to a GitHub repository
2. Deploy it to Cloudflare Pages on `thebioms.com` (domain already registered, owner-managed in Cloudflare)
3. Set up Cloudflare Email Routing on `thebioms.com`
4. **Stop and wait for owner instructions** before any further work

Do not deploy any smart contract. Do not run the Python mint pipeline. Do not start Phase 2 work (Lab / backend) unless explicitly asked.

---

## Section 1 — First Steps

When the owner says "go", do this in order:

1. **`git init`** in this folder (`bioms-site/`).
2. Verify `.gitignore` is in place (it should already be — don't overwrite it).
3. Ask the owner for their **GitHub username**. Create a new private repo (or public — ask which).
4. **First commit**: `git add . && git commit -m "Initial Bioms release"`.
5. Push: `git remote add origin git@github.com:USERNAME/REPO.git && git push -u origin main`.
6. Open `https://dash.cloudflare.com` → Pages → Create a project → Connect to Git → select the repo.
7. **Build settings**:
   - Framework preset: **None**
   - Build command: **(empty)**
   - Build output directory: **`/`**
   - Root directory: **(empty)**
8. Custom domain: add `thebioms.com` in Pages → Custom domains. Owner has already pointed nameservers; just add the custom domain in the Cloudflare dashboard.
9. Test deploy. Visit `thebioms.com` — landing should load. Check `/make.html`, `/explore.html`.
10. **Cloudflare Email Routing**: Dashboard → `thebioms.com` → Email → Email Routing → Enable. Add forwarding rule: `hello@thebioms.com` → owner's Gmail (ask which). Owner sets "Send as" in Gmail manually.
11. Report status to owner. Wait for instructions.

---

## Section 2 — Architecture

### Frontend (Cloudflare Pages, static)

| File | Role |
|---|---|
| `index.html` | Landing page. Nav, hero, demo, stain showcase. Embeds `preview.html` and `rare-*.html` via `<iframe>`. |
| `preview.html` | **The token renderer.** This is the file pointed to by NFT `animation_url`. Renders a Biom from `?seed=N`, with breathing animation + mouse parallax. Has URL param overrides (`?fit=1`, `?bg=white`, `?scale=N`, `?forceMorph=`, `?forceStain=`, `?forceLifecycle=`, `?forceReserve=`, `?forceOrganelles=a,b,c`, `?forcePhage=1`, `?forceEndo=1`, `?forceBiofilm=1`, `?static=1`, `?noise=0`, `?nointeract=1`). The engine logic is inlined here (legacy) — has its own copy independent of `specimen-engine.js`. |
| `make.html` | Banner Maker — interactive canvas editor. Drag/scale/rotate/flip/templates. PNG export prefers cloud HQ render (`/api/render`) and falls back to **native 2D Canvas** (NOT html2canvas — see Section 5). Imports `specimen-engine.js`. |
| `render.html` | Headless render page opened by Browser Rendering. Pure render-only — reads `?seed&w&h&tx&ty&scale&rot&fx&fy`, mounts one specimen via `BiomEngine.renderSpecimen`, signals `body[data-ready="1"]` for the worker to screenshot. Same `.panel` CSS as `preview.html`/`make.html` so real backdrop-filter glass renders. |
| `explore.html` | Trait Explorer — 46 trait cards with isolated traits + academic descriptions. Uses iframes to `preview.html` with URL overrides. Lazy-loads via IntersectionObserver. |
| `rare-aurora.html`, `rare-ghost.html`, `rare-variable.html` | Forks of preview.html, each with one hardcoded `state.palette`. Used by landing's stain showcase. Engine inlined. |
| `asset-template.html` | Asset format template (fixed Twitter/OpenSea dimensions). Used only by `batch_screenshots.py` for downloadable asset packs. Not in user nav. |
| `specimen-engine.js` | **Shared rendering engine** — exports `window.BiomEngine`. Contains: palettes, weights, all generators, DOM renderer (`renderSpecimen`), **native 2D canvas renderer (`renderSpecimenToCanvas`)** for offline export fallback. Used by `make.html` and `render.html`. |
| `_headers` | Cloudflare Pages config — cache control + security headers. |

### Backend (Cloudflare Pages Functions)

| File | Role |
|---|---|
| `functions/api/render.js` | POST endpoint. Receives `{seed, w, h, tx, ty, scale, rotation, flipX, flipY}`, builds a same-origin URL to `render.html`, calls the Cloudflare Browser Rendering REST API (`/browser-rendering/screenshot`), returns the PNG. Requires `CF_ACCOUNT_ID` (plain env var) and `CF_API_TOKEN` (secret, with `Browser Rendering: Edit` permission) configured in the Pages project. Requires the Workers Paid plan. Same-origin only (CORS allowlist: `thebioms.com` + `*.pages.dev` previews). Hard cap 4000×4000 / 8 MP per render. |

### Mint pipeline (Python, runs locally — NOT deployed)

| File | Role |
|---|---|
| `generate_metadata.py` | Generates 3,000 ERC-721 metadata JSON files. **MUST stay RNG-parity with JS.** |
| `batch_screenshots.py` | Headless Chromium renders 3,000 preview PNGs. |

## Section 3 — Final state (what works right now)

All work below was completed in the Cowork session and is verified working:

- **17 new traits added** beyond original 1000-supply MVP: 4 morphologies (sarcina, tetrad, streptobacillus, mycelium), 4 stain palettes (acid_fast, giemsa, safranin, india_ink), 5 reserve granules (phb, volutin, magnetosomes, sulfur, crystalline), 3 lifecycle states (binary_fission, sporulating, heterocyst), 3 ultra-rare effects (phage_attached, endosymbiont, biofilm_halo).
- **Supply increased 1000 → 3000.**
- **RNG parity verified 3000/3000** between JS engine (`specimen-engine.js`, `preview.html`) and Python (`generate_metadata.py`). All four implementations of `mulberry32` produce identical sequences for any seed.
- **Banner Maker (`make.html`)** — interactive canvas editor with drag/scale/rotate/flip, 12 layout templates with auto-apply per format, 8 format presets + custom W×H. PNG export via native 2D canvas (no html2canvas/dom-to-image — they failed with backdrop-filter).
- **Trait Explorer (`explore.html`)** — 46 trait cards, academic-style biology descriptions, lazy-loaded iframes via IntersectionObserver.
- **Brand**: `Bioms` (no "The"). Domain `thebioms.com`. X handle `@theBioms`. Each token = `BIOM #N`. Species name (procedural latin-ish, 1024 namespace) surfaced as a filterable OpenSea trait.
- **Fit-mode rendering**: in `?fit=1` URL, the capsule envelope is sized smaller (`bbox×1.15 + 6/8`) so it fits inside the card; biofilm halo also reduced. PFP mode (default, no fit) keeps deliberate oversize for bust crop.
- **Capsule and clipping fixed** for banner/explore use.
- **Engine extracted** to `specimen-engine.js`, used by `make.html`. `preview.html` and `rare-*.html` still have inline engine copies (kept in sync — see Critical Invariants).
- **Canvas renderer (`renderSpecimenToCanvas`)** with proper CSS-matching matrix composition (transforms compose in `T_position × T(-50%) × T(tx,ty) × center-pivot × scale × rotate × back-from-pivot` order). Glass effect simulated with 6 layers per panel: base fill, inner top highlight, inner bottom shadow, diagonal sheen (overlay blend), convex radial highlight (overlay blend), outer border stroke.

---

## Section 4 — Critical invariants (DO NOT BREAK)

### 4.1 — RNG parity

The procedural genome is the foundation of the entire collection. **Four** independent implementations must produce identical traits for any given seed:

1. `preview.html` — inline JS in `<script>`
2. `rare-aurora.html`, `rare-ghost.html`, `rare-variable.html` — inline JS, each mirrored from preview.html
3. `specimen-engine.js` — used by `make.html`
4. `generate_metadata.py` — Python, used at mint time

The `mulberry32(seed)` PRNG is the only randomness source. The sequence of `rng()` calls in `randomize()` / `generateState()` is:

```
1. pickWeightedMorph(rng)         — 1 call (returns 1 of 11 morphologies, weighted)
2. pickWeightedPalette(rng)       — 1 call (returns 1 of 12 stains, weighted)
3. rng() → cellCount              — 1 call: 1 + floor(rng() × 6)
4. rng() → accentCount            — 1 call: floor(rng() × 4)
5. 9 boolean rolls for organelles (in order):
    nucleoid(0.85), ribosomes(0.45), pili(0.55), flagellum(0.30),
    plasmid(0.40), endospore(0.15), inclusion(0.20), eyespot(0.20), axial(0.15)
6. pickWeightedReserve(rng)       — 1 call
7. pickWeightedLifecycle(rng)     — 1 call (with post-condition: heterocyst → vegetative if morph != filament/mycelium; no rng consumed by the check)
8. 3 boolean rolls for ultra-rare (in order):
    phageAttached(0.015), endosymbiont(0.01), biofilmHalo(0.02)
```

**Total: 18 rng() calls per state generation, exact order.** Adding, removing, or reordering ANY of these changes the output for ALL seeds.

If you change anything in trait generation:

```bash
# In repo root:
python3 -c "
import sys; sys.path.insert(0, '.')
from generate_metadata import generate_traits
for s in [0, 247, 999, 1999, 2999]:
    print(s, generate_traits(s))
"
```

Then in browser console on `make.html`:
```js
[0, 247, 999, 1999, 2999].map(s => ({s, ...BiomEngine.generateState(s)}))
```

They MUST match. If they don't — you broke parity. Revert and try again.

### 4.2 — Metadata filename format

Files are written as `{tokenId}.json` (no zero-padding). OpenSea Studio Drop appends `.json` to a URI prefix. Format `00247.json` would NOT match the OpenSea fetch pattern. Don't add padding.

Internal PNG references inside metadata use zero-padding (`00247.png`) — that's what `batch_screenshots.py` saves and `generate_metadata.py` writes into `image:` field. The two scripts agree on this — don't touch.

### 4.3 — IS_FIT_MODE flag

The `?fit=1` URL parameter signals "render specimen fully inside the card" (used by `make.html`, `explore.html`). Without it (PFP / NFT default), capsule is deliberately oversized for bust crop. In `specimen-engine.js` this is the `isFitMode` option; in `preview.html` and `rare-*.html` it's a top-level `IS_FIT_MODE` const. Both modes are needed. Don't remove either path.

### 4.4 — URL params used by other pages

`preview.html` exposes these URL params (used by `make.html`, `explore.html`, possibly future Lab):

- `?seed=N` — token seed
- `?fit=1` — fit mode (smaller capsule, no bust offset)
- `?bg=white` — white background instead of paper texture
- `?noise=0` — disable noise overlay (cleaner banners)
- `?static=1` — freeze animation at phase 0 (no breathing, no drift)
- `?nointeract=1` — skip mouse/touch listeners (lighter for iframes)
- `?scale=N` — set `--card-scale` CSS variable (shrinks `.pfp-card` for whitespace)
- `?forceMorph=X`, `?forceStain=X`, `?forceLifecycle=X`, `?forceReserve=X` — override single traits
- `?forceOrganelles=a,b,c` — replace organelle set entirely
- `?forcePhage=1`, `?forceEndo=1`, `?forceBiofilm=1` — force ultra-rare
- `?forceCells=N` — override cellCount
- `?mut_TRAIT=DONOR_SEED` — conjugation mutation (legacy prototype, basis for Lab Phase 1)
- `?dep_TRAIT=1` — trait depletion (legacy prototype)

If you change names of these params, update consumers in `make.html` and `explore.html`.

---

## Section 5 — Known issues / accepted limitations

### Backdrop-filter in PNG export — SOLVED via Browser Rendering, with fallback

The Glass effect in DOM uses `backdrop-filter: blur(18px)` — each panel blurs what's behind it. **Canvas API has no equivalent**, so `renderSpecimenToCanvas` only ever approximated the glass via 6-layer panel rendering (highlights, shadows, sheen, overlay blends, border) — no real blur.

**Current solution:** the Banner Maker's PNG export defaults to the Cloudflare Pages Function `functions/api/render.js`, which uses the Cloudflare Browser Rendering REST API to screenshot `render.html` in a real headless Chromium. `backdrop-filter` works there → pixel-identical output to the live preview.

**Fallback:** if `/api/render` returns non-2xx (Browser Rendering not configured, account out of minutes, network error, etc.), `make.html` automatically falls back to the local 2D canvas renderer and labels the result in the UI status line as "local fallback (no glass blur)". Existing behavior is preserved.

Setup steps for Browser Rendering are in `README.md` → "HQ banner render (Cloudflare Browser Rendering)".

### Engine duplication

`specimen-engine.js` and `preview.html` (+ 3 rare-*.html) contain duplicated rendering logic. Kept this way deliberately:

- ES module imports break `file://` page loading (Chrome blocks `<script src>` cross-origin for file URLs)
- `preview.html` is the NFT `animation_url` target — must work standalone, no external deps
- The duplication is small (~700 lines of pure-function code) and changes are infrequent

If you ever **must** refactor (e.g. to reduce bundle size for Cloudflare), the path is: have `preview.html` import `specimen-engine.js` only when served over HTTP. Test thoroughly — RNG parity is the constraint.

### Heterocyst rate

By design, heterocyst only applies to `filament` or `mycelium` morphologies (biologically accurate). Effective rate is ~0.5% of all tokens (heterocyst weight 6% × filament+mycelium share 12% = 0.72%, minus statistical wiggle). Some tokens with heterocyst rolled get downgraded to vegetative. Distribution analysis (3000 supply) showed 14/3000 — within expected variance. Don't "fix" this — it's intentional.

---

## Section 6 — Pending tasks by priority

### P0 — Before mint (owner decides timing)

- [ ] **Deploy site** to Cloudflare Pages (Section 1)
- [ ] **DNS + email** on thebioms.com (Section 1)
- [ ] **Buy `bioms.eth`** — owner does this manually at [app.ens.domains](https://app.ens.domains). Connect with hardware wallet.
- [ ] **Buy `livingbioms.com`** — defensive, redirect to thebioms.com
- [ ] **Hardware wallet setup** — owner sets up Ledger/Trezor as project wallet. Do not mix with personal wallet.
- [ ] **Optional**: Gnosis Safe multi-sig for project treasury
- [ ] **Test mint on Sepolia** — deploy contract for 5-10 tokens, verify OpenSea fetches metadata correctly. Owner does this through OpenSea Studio.

### P1 — Mint day

- [ ] Run mint pipeline locally:
  ```bash
  pip3 install playwright && python3 -m playwright install chromium
  mkdir -p pngs/preview && python3 batch_screenshots.py preview.html ./pngs/preview 3000 --workers 6 --size 1500
  mkdir -p metadata && python3 generate_metadata.py ./metadata 3000 --base-image-uri https://thebioms.com/pngs/preview --base-animation-uri https://thebioms.com/preview.html
  ```
- [ ] Commit `pngs/` and `metadata/` directories (or upload to Cloudflare R2 if size becomes issue — ~500MB-1.5GB)
- [ ] Push to GitHub → Cloudflare auto-deploys
- [ ] Owner deploys contract via OpenSea Studio with tokenURI prefix `https://thebioms.com/metadata/`

### P2 — Lab feature (after mint, holder demand)

The owner wants a **trait conjugation feature**: connect wallet → see your Bioms → splice traits between them with biology-accurate mechanics (donor pilus required, ~10-20% rejection, 30-day cooldown on donor trait, donor not burned).

**Phase 1 (Visual mockup, no backend)** — buildable now if requested. Uses existing `?mut_*` URL params in `preview.html`. Mutations live in browser memory only.

**Phase 2 (Persisted, OpenSea-visible)** requires:

#### Cloudflare Workers — `functions/api/`

```
functions/
├── api/
│   ├── metadata/[id].ts        # Dynamic metadata — joins base JSON + D1 mutations
│   ├── conjugate.ts             # POST mutation, verify signed message, roll RNG, write D1
│   ├── bioms/[wallet].ts        # Fetch wallet's Bioms (proxy Reservoir or OpenSea API)
│   ├── lab/state/[id].ts        # Current mutation state of a token
│   └── cooldowns/[id].ts        # Trait regeneration timers
```

#### Cloudflare D1 schema

```sql
CREATE TABLE mutations (
  token_id INTEGER,
  trait_name TEXT,           -- 'body', 'organelle:flagellum', 'lifecycle', etc.
  donor_seed INTEGER,
  applied_at INTEGER,        -- unix timestamp
  status TEXT,               -- 'active' | 'reverted' | 'failed'
  signature TEXT,            -- holder's signed message
  PRIMARY KEY (token_id, trait_name)
);
CREATE TABLE cooldowns (
  token_id INTEGER,
  trait_name TEXT,
  ready_at INTEGER,          -- unix timestamp 30 days after donation
  PRIMARY KEY (token_id, trait_name)
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT,                 -- 'conjugate', 'mutation_applied', 'cooldown_expired'
  payload TEXT,              -- JSON
  created_at INTEGER
);
```

#### Conjugation flow

1. Holder selects donor token + recipient token + trait in Lab UI
2. Frontend constructs signed message: `{action: 'conjugate', donor: 247, recipient: 1244, trait: 'body', nonce, timestamp}`
3. Wallet signs (via `personal_sign` or EIP-712)
4. POST to `/api/conjugate` with signed message
5. Worker verifies signature recovers to holder of both tokens (via on-chain `ownerOf()`)
6. Worker checks cooldowns on donor trait
7. Worker rolls failure RNG (server-side, seeded by block hash + nonce for verifiability)
8. On success: write to `mutations` table, set cooldown row for donor
9. Return new metadata URL
10. Frontend triggers OpenSea metadata refresh

#### OpenSea integration

Contract's `tokenURI(id)` returns `https://thebioms.com/api/metadata/${id}`. Worker reads D1, joins with base metadata, returns updated JSON. Image must also be dynamic — either re-render via Playwright on cache miss, OR use URL params on preview.html (`?seed=X&mut_body=Y`).

### P3 — Maybe-someday

- Mobile-optimized Lab (currently desktop-focused due to drag)
- Composable trait NFTs (ERC-1155) — Series II territory
- Mutation history visualization (lineage tree of a Biom)
- Social sharing — auto-generate OG image for sharing a mutated Biom

---

## Section 7 — Style conventions

- **No build step.** Vanilla HTML/CSS/JS. No npm, no webpack, no TypeScript (except in Cloudflare Workers if you add them — `.ts` works natively there).
- **No frameworks.** No React/Vue/Svelte. The owner explicitly wants this lightweight.
- **`specimen-engine.js`** is one file, exports `window.BiomEngine`. Don't ES-modulify it (breaks `file://`).
- **HTML files** use inline `<style>` and `<script>`. Resist splitting into `.css`/`.js` unless very compelling.
- **Style**: match existing aesthetic — paper backgrounds (`#ece9e0`), `--ink` for text, museum-archival tone, no emoji in product text.
- **Comments**: write them. Especially around invariants (RNG calls, transform math). The engine is dense; comments save the next reader.
- **Don't break working things**. The collection is pre-launch — every change must be backward compatible with the verified state.

---

## Section 8 — Contact / origin

- **Project owner**: `@timso_eth` on Twitter (personal handle, not the project handle)
- **Project handle**: `@theBioms`
- **Project email**: `hello@thebioms.com` (set up via Cloudflare Email Routing after deploy — Section 1)
- **Domain**: `thebioms.com`
- **Original session**: built in Cowork mode (Claude Sonnet 4.6), May 2026, ~10-hour session
- **Estimated total LOC**: ~3,500 (HTML/CSS/JS) + ~280 (Python)

When in doubt about a design choice — ask the owner before changing it. Especially for anything affecting trait probability, naming, or rendering.

Good luck.
