# Bioms — Claude handoff (2026-05-23)

This is the working context for any new Claude session on this project. Read it before doing anything. Then `README.md` for the long-form product story.

> **Date check.** Updated 2026-05-23, the night before the drop. If today is later than that, treat everything below as the last known state — not necessarily current.

---

## TL;DR

**Bioms** = a generative NFT collection of 3,000 procedural microbial organisms ("Bioms"), Open Edition on **OpenSea Drops**, contract `0x57b83D192d30A1082779C3dCDc9D2fcAd855F457` on Ethereum mainnet.

- **Site**: <https://thebioms.com>
- **WL mint opens**: 2026-05-29 19:00 GMT+7 (the countdown component lives on the homepage and `/reserve`)
- **OpenSea collection**: <https://opensea.io/collection/bioms/overview>
- **Twitter**: [@theBioms](https://twitter.com/theBioms)
- **Owner**: timso.eth (Telegram contact: timsouw)

The collection is fully revealed (`<meta name="bioms-reveal" content="true">` site-wide). The Lab (the burn mechanic) is live and works on-chain via the Worker.

---

## Working preferences (READ THIS BEFORE WRITING ANYTHING)

These come from the project owner; honor them:

- **Reply in Russian.** Concise, no bullet-list-bloat. He reads fast, doesn't want fluff.
- **Don't overhype your own changes.** If a perf optimization saved 5%, say 5%. Don't write "huge win" unless it actually is. He notices and calls it out.
- **Don't ask before acting in Auto Mode.** When his message implies a direction, take it. Use `AskUserQuestion` only when you genuinely need a decision he must make (visual choice, scope question).
- **Brand voice for end-users: restrained, intentional, microbiology-academic.** No emojis, no exclamation marks, no "Get yours now!" tone. Apple-restraint × scientific-paper × ambient awe.
- **The word "specimen" is banned in user-facing copy.** Always call them **Bioms** (or "Biom" singular). CSS class names like `.ritual-specimen` are fine; OG-image alts, body text, meta descriptions are not.
- **He owns dustopia.xyz separately.** That project is unrelated to Bioms. If you see anything dustopia-flavored leaking in (CLAUDE.md context, worktree paths, NFT thumbnails of swirling spheres), it's noise. Stay in `/Users/okynata/Desktop/bioms/` for everything.
- **The mint is real money.** Before any change that touches `/lab`, `/reserve`, `/`, the burn flow, signing logic, or the contract metadata endpoint — pause and double-check. He's already had one "what did you break?" moment caused by a deploy from the wrong directory. Don't repeat that.

---

## Architecture (current, working)

```
                          (browser)
                              │
              visit https://thebioms.com/* (Pages)
                              │
                  static HTML + inline JS
                              │
       chain reads → window.ethereum (viem via inline)
       lab burns   → POST https://api.thebioms.com/api/burn
                              │
                    (Cloudflare Worker: bioms-api)
                              │
            ┌──── D1 (token_state, depletions, log) ───┐
            │                                          │
            │           R2 (bioms-pngs):               │
            │     /thumb/<NNNNN>.webp — cream tiles   │
            │     /cutout/<NNNNN>.webp — transparent  │
            │     /preview/<NNNNN>.png — master       │
            │                                          │
            └─────── Alchemy NFT v3 (ownerOf + state)─┘
```

### Pages (Cloudflare Pages, static, auto-deploys main on push)

| File | Role |
|---|---|
| `index.html` | Landing. Hero biom, "Evolve" section (homepage Lab pitch), drop block with countdown + CTAs that auto-swap to OpenSea at T-0 (`#dropPre` / `#dropLive`). `?lite=1` on hero iframe for perf. |
| `lab.html` | The Lab — **stacked-modal storytelling flow**, 5 acts. See "Lab flow" below. |
| `reserve.html` | Waitlist. Has countdown to WL window, auto-swaps form → "Mint live" CTAs at T-0. Real signups counter from `/api/waitlist/count`. |
| `make.html` | Banner Maker. Single Biom or N×M collage mode. Drag/zoom/rotate/flip. Pixel-identical preview ↔ export via shared rendering path. Uses cached cutout PNGs from R2 with thumb fallback. |
| `explore.html` | Trait Explorer — 46 trait cards with pre-rendered PNGs (not iframes — that melted laptops). |
| `preview.html` | The token renderer — pointed to by NFT `animation_url`. URL params: `?seed=N`, `?lite=1` (cheap), `?lite=2` (cheaper), `?cutout=1` (transparent), `?fit=1`, `?bg=white`, `?static=1`. |
| `manifesto.html` | The long-form project story. Restrained tone, microbiology-academic. |
| `pfp.html` | PFP/explore — save any Biom as PNG. |
| `404.html` | Branded — broken Biom with drift animation. |
| `asset-template.html` | OG/Twitter image template (only used by batch scripts, not in nav). |
| `specimen-engine.js` | Shared rendering engine: `window.BiomEngine`. DOM render + 2D-canvas export path. **Filename has "specimen" in it — that's internal, do not rename.** |
| `nav-wallet.js`, `nav-wallet.css` | EIP-6963 multi-wallet picker (MetaMask, Rabby, Coinbase, etc.). |
| `design.css` | Shared brand tokens. Cream `--bg`, ink `--ink`, ember `--burn`, radii, easings, button primitive. |
| `_worker.js` | **Passthrough shim.** Defensive fix for a CF Pages Functions binding leak. Do not remove. Do not add logic. |
| `_redirects`, `_headers` | Cloudflare Pages config. `_headers` sets per-path Cache-Control + CSP + frame-ancestors. **HTML pages cached for 60s pre-drop** (was 1h — bumped down for rapid iteration). |

### Worker (Cloudflare Workers, deployed separately from Pages)

Worker name: **`bioms-api`** (custom domain `api.thebioms.com`).

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Ping + config (CHAIN_ID, contractDeployed, COOLDOWN_SECONDS, REJECTION_RATE). |
| `GET /api/owned/<addr>` | Bioms token IDs in this address (via Alchemy NFT v3). KV-cached 30 min. |
| `GET /api/state/<id>`, `GET /api/state-batch?tokens=N,N` | D1 → mutations + active depletions for a token. |
| `POST /api/burn` | EIP-712 sig verify → on-chain `ownerOf` check → game RNG → D1 persist → return new state. **This is the real burn**, no rollback. |
| `POST /api/conjugate` | Legacy crossbreed endpoint. **Crossbreed mechanic is removed from the UI**, but the endpoint still exists in case we ever revert. |
| `POST /api/waitlist` | Reserve form submit (email, eth addr, twitter). |
| `GET /api/waitlist/count` | Live signup counter. |
| `GET /api/metadata/<tokenId>` | **OpenSea metadata endpoint**, returns ERC-721 JSON. Used as token URI baseURI. |
| `GET /api/preview/<tokenId>` | Pre-rendered preview image (animated WebP for mutated tokens). |
| `POST /api/webhook/transfer` | Alchemy Notify webhook → wipes per-token cache on transfer. HMAC-gated. |

Worker config (`wrangler.toml`):
- D1: `bioms-lab` (schema in `schema.sql`)
- R2: `bioms-pngs` (custom domain `pngs.thebioms.com`)
- Secrets: `ALCHEMY_KEY`, `CONTRACT_ADDRESS`, `WEBHOOK_SECRET`, `ADMIN_TOKEN`

Deploy worker: `npx wrangler deploy` (NOT covered by Pages auto-deploy).

---

## The Lab — current flow (2026-05-23 ritual rebuild)

The Lab is a **closed loop of five acts**, stacked-modal style. Each is a fullscreen overlay; only one visible at a time.

```
  Act 1 — Intro:     "Are you ready?"
                      [Yes, I'm ready] (ember) / [Try a demo first]
  Act 2 — Pick:      "Choose two."
                      User's Bioms on cream tiles in a dark room.
                      Auto-advances after two are tapped.
  Act 3 — Name:      "Which name survives?"
                      Two large name buttons. Click one — that's the
                      survivor; the other becomes the donor.
  Act 4 — Ritual:    Existing #burnRitual modal — press-and-hold 3s
                      to commit. Donor dissolves into survivor.
  Act 5 — After:     "[Name] carries it now."
                      [Burn again] / [Leave the lab]
```

**Key architectural notes:**

- The flow controller lives at the bottom of `lab.html` body. It talks to the legacy burn machinery via a single adapter object: `window.__bioms_lab` (`setBurnPair`, `loadDemo`, `walletReady`, `ownedSeeds`, `triggerBurn`, `reset`). The controller never reaches into module-scope state directly.
- "Choose name" semantics: clicking BIOM A's button calls `setBurnPair(A, B)` which clears the arena, sets donor=B then recipient=A. The legacy arena state machine sees a normal pair.
- Inline `#burnConfirm` panel is hidden by CSS and auto-clicked Yes by a MutationObserver — the 3-second hold in the ritual is the real confirmation, the inline step was redundant friction.
- Burn-only. The crossbreed mode was removed from the UI on 2026-05-23 (story clearer with one mechanic). Dead crossbreed code paths preserved for rollback safety.
- Demo mode is restored as a flow entry-point: `loadDemo(6)` flips `LabState.mode = 'demo'`, clears state, adds 6 random seeds.
- Underlying legacy scaffolding (`#collectionGrid`, `#conjugateBtn`, the visible hero text) is `visibility: hidden` via `body.flow-ready` — kept as JS-fail fallback.

**Visual:**
- Page background: warm ink `#15110d` (same as burn ritual modal).
- Bioms inside modals: canonical cream tiles (`--paper`). This is non-negotiable — the user explicitly asked for "bacteria on white" everywhere a Biom is shown. **Including inside the ritual modal** (it was dark by default; overridden via `.burn-ritual .ritual-render` CSS).
- Ember accent (`--burn`) reserved for moments of commitment: "Yes, I'm ready" (Act 1) and the press-and-hold ritual button (Act 4).

---

## R2 buckets (`bioms-pngs` at `pngs.thebioms.com`)

```
/preview/<NNNNN>.png    — master render at full resolution (3000-ish px).
                           Used by OpenSea metadata + Banner Maker fallback.
                           Mutated tokens get an animated .webp here.
/thumb/<NNNNN>.webp     — small cream-bg thumbnail (~7-15 KB each).
                           Used in catalogs, picker grids.
/thumb/<NNNNN>.png      — PNG fallback.
/cutout/<NNNNN>.webp    — transparent background, full-res (~50-130 KB).
                           Used in `/make` collage, dark-room lab variants.
                           Note: seeds 0-3 were initially empty (race in
                           the batch script) — regenerated + uploaded
                           2026-05-23; check `curl -sI` if a seed looks
                           wrong.
/explore/<cat>-<id>.png — Trait Explorer card images.
```

Regeneration scripts:
- `scripts/make-cutouts.py` — Playwright batch via `preview.html?cutout=1` + `omit_background=True`. Args: `--only N,N` / `--workers 4`.
- `scripts_upload_cutouts.sh` — uploads `pngs/cutout/` to R2 via `wrangler r2 object put`. Has `--webp-only` and `--only N N` flags.

---

## Common edits

### Change copy / colors on a page
Edit the relevant HTML directly. Each page is self-contained — `<style>` and `<script>` are inline. Push to main → auto-deploys in ~30s.

### Tweak burn / game logic
Edit `worker.js` (server side — RNG, trait availability, D1 persist) AND `lab.html` (client-side preview if relevant). After worker edit: `npx wrangler deploy`. Pages auto-deploy doesn't touch the worker.

### Add a new R2 image variant
1. Add a directory under `pngs/` locally
2. Generate via a script in `scripts/`
3. Upload via wrangler (or `scripts_upload_*.sh`)
4. Set Cache-Control via `_headers` if served through Pages, OR via the R2 bucket's CORS/cache config if served via `pngs.thebioms.com`

### Pre-launch checklist (do before WL mint window)
- [ ] Set OpenSea contract's baseURI to `https://api.thebioms.com/api/metadata/`
- [ ] Verify Alchemy Notify webhook is firing (test with a transfer)
- [ ] Rotate `ADMIN_TOKEN` if it's been in dev hands
- [ ] Pinned tweet drafted
- [ ] Polish OpenSea collection page (banner, royalties, description)
- [ ] Smoke-test all routes: `/`, `/lab`, `/reserve`, `/make`, `/explore`, `/manifesto`, `/pfp`, `/api/health`

### Smoke-test routes (fast)
```bash
for path in / /lab /reserve /make /explore /manifesto /pfp; do
  code=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" "https://thebioms.com$path")
  echo "$path → $code"
done
/usr/bin/curl -s https://api.thebioms.com/api/health | jq .
```

### Syntax-check `lab.html` JS after edit
```bash
cd /Users/okynata/Desktop/bioms && \
  python3 -c "import re; s=open('lab.html').read(); ms=re.findall(r'<script>([\s\S]*?)</script>', s); open('/tmp/lab_check.js','w').write('\n;\n'.join(ms))" && \
  node --check /tmp/lab_check.js && echo SYNTAX_OK
```

---

## Things to NEVER do

- **Deploy from any directory other than `/Users/okynata/Desktop/bioms/`.** This caused a real outage. CF Pages stores Pages Functions at project level; deploying from elsewhere can leak stale bindings across deploys. The `_worker.js` shim is the defensive fix — don't remove it.
- **Never commit secrets.** ALCHEMY_KEY, WEBHOOK_SECRET, ADMIN_TOKEN, private keys live only as Worker secrets via `wrangler secret put`.
- **Never use `--no-verify`, `--no-gpg-sign`, or `--amend` on git operations** unless the user explicitly asks. If a pre-commit hook fails, fix it and make a NEW commit.
- **Never `rm -rf` a project directory yourself.** This is in the agent safety rules — give the user the exact command and let them run it.
- **Never bypass `AskUserQuestion` for visual/scope decisions the user must make.** Auto-deciding wrong wastes more time than asking.
- **Never add emojis** to site copy or commit messages. The brand voice is restrained.
- **Never call Bioms "specimens"** in user-facing copy. CSS classes and internal JS variables (`renderSpecimen`, `.ritual-specimen`) are fine — don't rename those.
- **Never deploy lab.html changes without local smoke-test.** The burn flow has ~5500 lines of intertwined state. Use `preview_start` + the preview MCP tools, walk Act 1 → Act 5 in demo mode, confirm nothing breaks. THEN commit.

---

## Recent design decisions (worth knowing)

| When | What | Why |
|---|---|---|
| 2026-05-23 | **Stacked-modal lab flow** (intro → pick → name → ritual → after) | The lab was a page-with-controls; users had to figure out what to do. New flow IS the experience, no way to get lost. |
| 2026-05-23 | **Crossbreed removed from UI** | One mechanic (burn) tells a clearer story than two. Code preserved for rollback. |
| 2026-05-23 | **Dark room aesthetic + cream Biom tiles** | The Lab is the most weighty action on the site (one biom dies forever). Treat it as a ritual, not a form. Biom thumbnails stay on canonical cream — only the page is dark. |
| 2026-05-23 | **Word "specimen" purged from copy** | Confusion with "Biom" — pick one name. |
| 2026-05-23 | **Cache-Control on HTML dropped 1h → 60s** | Pre-drop iteration. Restore longer TTLs post-launch. |
| 2026-05-22 | **Demo mode removed from lab (then re-added 2026-05-23 as flow entry-point)** | Originally lab was wallet-only after launch; the new flow needs a non-wallet entry for curious visitors. |
| 2026-05-22 | **`_worker.js` shim committed to git** | Defensive fix for a CF Pages Functions binding leak that surfaced after a wrong-directory deploy. |
| 2026-05-21 | **Wallet picker — EIP-6963 modal** (MetaMask, Rabby, Coinbase, etc.) | Single window.ethereum was unreliable; users have multiple wallets installed. |
| 2026-05-20 | **Browser Rendering for mutated tokens** | After a burn, the survivor needs a fresh master PNG — generated server-side via @cloudflare/puppeteer + uploaded to R2 + OpenSea refresh-metadata ping. |
| 2026-05-19 | **OpenSea Drops chosen over self-contracted mint** | Lower friction for buyers; OpenSea handles primary sales UI. Contract `0x57b83D192d30A1082779C3dCDc9D2fcAd855F457` is OpenSea's Open Edition contract. |

---

## If something breaks during the drop

1. **Don't deploy a fix from outside this repo's checkout.** Always `cd /Users/okynata/Desktop/bioms/` first.
2. **Browser-cache surprises** — if a user reports "I don't see your latest fix", check `Cache-Control` header on the route and tell them Cmd+Shift+R. Cache is now 60s so this should be rare.
3. **R2 edge cache holding stale zero-byte file** — happened with seeds 0-3 cutouts. Bust with `?v=$(date +%s)` query string in curl; the actual cache will refresh on next origin pull.
4. **Worker not picking up code change** — Pages auto-deploys frontend only. Worker needs `npx wrangler deploy`.
5. **Cloudflare API outage during deploy** — happened 2026-05-22. Wait it out (status.cloudflare.com), don't force.

---

## Owner's stated future ideas (not started, not committed)

- **Monetization brainstorm** (whales / big-money buyers during drop): 1/1 Phoenix Auction, Founder Bioms (#1-10), Eponymous Trait offer, full-collection buyout at 2-5× primary, etc. Owner asked, was given options, hasn't picked one yet. Don't implement any of these without explicit go-ahead.
- **Per-flock drifting orbit axes** (dustopia thing, not Bioms — ignore if it surfaces).

That's it. Read `README.md` next for the long-form product story. Then ask the owner what to do.
