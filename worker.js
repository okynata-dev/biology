// ============================================================
// Bioms Lab — Cloudflare Worker
//
// Endpoints:
//   GET  /api/health                       — ping
//   GET  /api/owned/:address               — list tokenIds owned by addr (via Alchemy)
//   GET  /api/state/:tokenId               — current mutations + active depletions
//   GET  /api/state-batch?tokens=1,2,3     — same, batched
//   POST /api/conjugate                    — perform a conjugation (signature-gated)
//   GET  /api/log?donor=N&recipient=N&limit=N — recent conjugation log
//
// Storage: Cloudflare D1 (SQLite). Schema in schema.sql.
//
// Auth: each conjugation requires an EIP-712 typed-data signature from
// the caller. Worker verifies signature, then queries the launch contract
// (env.CONTRACT_ADDRESS) via Alchemy to confirm the signer owns BOTH the
// donor and recipient tokens. No signature, no conjugation.
//
// Pre-mint behavior: if CONTRACT_ADDRESS is unset or zero, all ownership
// checks fail with a clear 503 'contract not deployed'. The lab.html
// frontend uses Demo mode in that case.
// ============================================================

import { recoverTypedDataAddress, createPublicClient, http, isAddress, getAddress } from 'viem';
import { mainnet } from 'viem/chains';
import { normalize } from 'viem/ens';
// Headless Chromium for the post-mutation master re-render pipeline.
// Bound via wrangler.toml `browser = { binding = "BROWSER" }`. The
// Worker takes a 3000×3000 screenshot of preview.html with the new
// state encoded as force-* URL params, then uploads to R2 overwriting
// the token's master. See renderTokenMaster() below.
import puppeteer from '@cloudflare/puppeteer';
// Pre-mint elevation map — the ~550 intrinsic Hybrid/Chimera/Phoenix tokens
// (same file the engine overlay + gallery manifest read). Bundled by
// wrangler. Used in buildMetadata so OpenSea attributes (Tier/Rank/Palette/
// Cell count/Organelles/Anomalies) match the self-elevated render.
import PREMINT_DATA from './premint.json';
const PREMINT = (PREMINT_DATA && PREMINT_DATA.tokens) || {};
function _paletteLabelFor(p) {
  if (_PALETTE_LABEL[p]) return _PALETTE_LABEL[p];
  if (typeof p === 'string' && p.indexOf('+') >= 0) {
    return p.split('+').filter(Boolean).length >= 3 ? 'Chimera mix' : 'Hybrid stain';
  }
  if (typeof p === 'string' && p.indexOf('_mix_') === 0) return 'Hybrid stain';
  return p;
}

// ----- CORS / utility -----
// Canonical URLs all live at apex thebioms.com (no www). www-subdomain
// isn't pointed in DNS, so listing it as an allowed origin was a
// non-functional artifact. Trimmed.
const ALLOWED_ORIGINS = [
  'https://thebioms.com',
  'http://localhost:8000',
  'http://localhost:8787',
];
function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://thebioms.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    // x-admin-token is required for the /admin panel's cross-origin fetches
    // (admin.html on thebioms.com → api.thebioms.com). A custom request
    // header triggers a CORS preflight; if it isn't listed here the browser
    // blocks the GET and the panel silently renders blank. content-type stays
    // for the JSON POST endpoints (waitlist/partner submit).
    'Access-Control-Allow-Headers': 'content-type, x-admin-token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
function json(body, init = {}, origin = '') {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...corsHeaders(origin), ...(init.headers || {}) },
  });
}
function error(msg, status = 400, origin = '') {
  return json({ error: msg }, { status }, origin);
}

// ----- Game constants (mirror lab.html) -----
// MAX_TOKEN_ID — single source of truth for the supply bound. If Series II
// ever ships, override via env.MAX_TOKEN_ID (string) instead of code edits.
//
// IMPORTANT: the OpenSea SeaDrop contract mints token IDs 1..8000, NOT
// 0..7999 (ERC721SeaDrop._startTokenId() == 1, confirmed by a test-contract
// mint). The worker maps tokenId -> art seed by identity (token N renders
// engine seed N), so the valid range must include 8000. Bound is therefore
// 8000, not 7999. Token 0 stays valid-but-unused (no token #0 ever mints),
// and art seed 0 is simply not part of the minted collection — the
// collection is engine seeds 1..8000. (Supply raised 3000 -> 8000 in the
// 2026-06 expansion; masters/thumbs/videos/cutouts re-rendered to R2.)
const DEFAULT_MAX_TOKEN_ID = 8000;  // contract mints 1..8000 (SeaDrop is 1-indexed; supply raised 3000->8000 for the 2026-06 expansion)
function maxTokenId(env) {
  const v = parseInt(env && env.MAX_TOKEN_ID, 10);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_MAX_TOKEN_ID;
}

// External-fetch timeout. CF Workers has its own 30s cap, but we want a
// faster fail so callers don't sit through it (and so we don't burn a
// nonce on a slow Alchemy outage). 8s is well above p99 Alchemy latency
// (~200-500ms typical) but short enough to feel responsive on failure.
const EXTERNAL_FETCH_TIMEOUT_MS = 8000;

async function fetchWithTimeout(url, options = {}, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

const TRANSFERABLE_TRAITS = new Set([
  'palette',
  'plasmid', 'pili', 'ribosomes', 'flagellum',
  'endospore', 'inclusion', 'eyespot', 'axial',
  'phageAttached', 'endosymbiont', 'biofilmHalo',
]);
const TRAIT_KIND = {
  palette: 'palette',
  plasmid: 'organelle', pili: 'organelle', ribosomes: 'organelle',
  flagellum: 'organelle', endospore: 'organelle', inclusion: 'organelle',
  eyespot: 'organelle', axial: 'organelle',
  phageAttached: 'anomaly', endosymbiont: 'anomaly', biofilmHalo: 'anomaly',
};

// ----- Trait computation (mirror specimen-engine.js / preview.html) -----
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
// THESE MUST MATCH specimen-engine.js EXACTLY — order matters because
// pickW consumes them in array order via a cumulative-weight pass. Copy
// verbatim; do not "tidy up". RNG parity is the hard invariant.
const PALETTE_WEIGHTS = [
  ['gramPositive', 13], ['gramNegative', 11], ['fluorescent', 10], ['methylene', 9],
  ['darkfield', 6], ['acid_fast', 5], ['giemsa', 4], ['iridescent_aurora', 5],
  ['ghost', 4], ['safranin', 3], ['india_ink', 3], ['gram_variable', 1],
  ['malachite', 4], ['congo_red', 3], ['carbol_fuchsin', 4], ['bismarck_brown', 4],
  ['nile_blue', 4], ['eosin', 2], ['toluidine', 3], ['ziehl_dual', 1], ['spore_dual', 1],
];
const MORPHOLOGY_WEIGHTS = [
  ['coccus', 13], ['bacillus', 13], ['vibrio', 12], ['spirillum', 12],
  ['filament', 10], ['cluster', 10], ['diplo', 10], ['streptobacillus', 8],
  ['tetrad', 7], ['sarcina', 3], ['mycelium', 2],
];
const RESERVE_WEIGHTS = [
  ['none', 64], ['phb', 12], ['volutin', 10], ['magnetosomes', 7],
  ['sulfur', 4], ['crystalline', 3],
];
const LIFECYCLE_WEIGHTS = [
  ['vegetative', 78], ['binary_fission', 10], ['sporulating', 6], ['heterocyst', 6],
];
function pickW(weights, rng) {
  const r = rng() * 100;
  let acc = 0;
  for (const [n, w] of weights) { acc += w; if (r < acc) return n; }
  return weights[weights.length - 1][0];
}
function generateBaseTraits(seed) {
  const rng = mulberry32(seed);
  const state = { seed, organelles: new Set(['capsule']) };
  state.morphology = pickW(MORPHOLOGY_WEIGHTS, rng);
  state.palette = pickW(PALETTE_WEIGHTS, rng);
  state.cellCount = 1 + Math.floor(rng() * 6);
  state.accentCount = Math.floor(rng() * 4);
  if (rng() < 0.85) state.organelles.add('nucleoid');
  if (rng() < 0.45) state.organelles.add('ribosomes');
  if (rng() < 0.55) state.organelles.add('pili');
  if (rng() < 0.30) state.organelles.add('flagellum');
  if (rng() < 0.40) state.organelles.add('plasmid');
  if (rng() < 0.15) state.organelles.add('endospore');
  if (rng() < 0.20) state.organelles.add('inclusion');
  if (rng() < 0.20) state.organelles.add('eyespot');
  if (rng() < 0.15) state.organelles.add('axial');
  state.reserveGranule = pickW(RESERVE_WEIGHTS, rng);
  let lc = pickW(LIFECYCLE_WEIGHTS, rng);
  if (lc === 'heterocyst' && state.morphology !== 'filament' && state.morphology !== 'mycelium') lc = 'vegetative';
  state.lifecycle = lc;
  state.phageAttached = rng() < 0.015;
  state.endosymbiont = rng() < 0.01;
  state.biofilmHalo = rng() < 0.02;
  return state;
}

// Returns whether the token currently has the given trait, applying base +
// received mutations - currently-active depletions.
function tokenHasTrait(base, mutations, depletionsActive, traitId) {
  const kind = TRAIT_KIND[traitId];
  if (!kind) return false;
  if (kind === 'palette') return true; // every token always has a palette
  if (depletionsActive.has(traitId)) return false;
  if (kind === 'organelle') {
    if ((mutations.organelles || []).includes(traitId)) return true;
    return base.organelles.has(traitId);
  }
  if (kind === 'anomaly') {
    if ((mutations.anomalies || []).includes(traitId)) return true;
    return base[traitId] === true;
  }
  return false;
}

// ----- D1 helpers -----
async function loadTokenState(env, tokenId) {
  // Mutations row + absorbed lineage + image_version (cache-bust counter,
  // bumped each time renderTokenMaster() re-uploads the master to R2).
  const m = await env.DB.prepare(
    'SELECT received_palette, received_organelles, received_anomalies, absorbed_seeds, image_version, mass FROM token_state WHERE token_id = ?'
  ).bind(tokenId).first();

  const mutations = {
    palette: m?.received_palette || null,
    organelles: m?.received_organelles ? JSON.parse(m.received_organelles) : [],
    anomalies: m?.received_anomalies ? JSON.parse(m.received_anomalies) : [],
  };
  const imageVersion = m?.image_version || 1;

  let absorbedSeeds = [];
  try { if (m?.absorbed_seeds) absorbedSeeds = JSON.parse(m.absorbed_seeds); } catch (_) {}
  if (!Array.isArray(absorbedSeeds)) absorbedSeeds = [];

  // Active depletions (regenerates_at > now)
  const now = Math.floor(Date.now() / 1000);
  const { results: depRows } = await env.DB.prepare(
    'SELECT trait, to_token, donated_at, regenerates_at FROM depletions WHERE token_id = ? AND regenerates_at > ?'
  ).bind(tokenId, now).all();

  const depletions = (depRows || []).map(r => ({
    trait: r.trait,
    to: r.to_token,
    donatedAt: r.donated_at * 1000,
    regeneratesAt: r.regenerates_at * 1000,
  }));

  // Check whether this token itself has been burned — if yes, callers
  // can decide how to render (e.g. "Burned ✕" overlay).
  const burnSelfRow = await env.DB.prepare(
    'SELECT recipient_token_id, tx_hash, burned_at FROM burns WHERE burned_token_id = ?'
  ).bind(tokenId).first();
  const burnedInfo = burnSelfRow ? {
    burned: true,
    intoTokenId: burnSelfRow.recipient_token_id,
    txHash: burnSelfRow.tx_hash,
    at: burnSelfRow.burned_at,
  } : null;

  // Total base organisms folded in (additive mass) once the token has been
  // merged; NULL until then (callers fall back to the pre-mint floor mass,
  // then 1 for a base Genesis).
  const mass = (m && m.mass != null) ? m.mass : null;

  return { mutations, depletions, absorbedSeeds, burned: burnedInfo, imageVersion, mass };
}

// ----- viem client factory -----
// Shared between ownerOf / listOwned / verifyBurnTx. All three need a
// public client pointing at the same mainnet RPC; sharing keeps the
// timeout/retry behavior consistent.
function getMainnetClient(env) {
  return createPublicClient({
    chain: mainnet,
    transport: http(`https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`, {
      timeout: EXTERNAL_FETCH_TIMEOUT_MS,
      retryCount: 1,
    }),
  });
}

// OpenSea API key — tolerant of both canonical name OPENSEA_API_KEY and
// the shorter OPENSEA_KEY that operators sometimes use when setting the
// secret (the OpenSea dashboard itself calls it "API key"). Whichever
// is set wins; if both are set, OPENSEA_API_KEY takes precedence.
function openseaKey(env) {
  return env.OPENSEA_API_KEY || env.OPENSEA_KEY || '';
}

// Constant-time string compare for admin token. For a 256-bit token
// over HTTPS, the timing-attack window is negligible — but this is
// the canonical pattern and the cost is zero. Returns false on any
// length mismatch (length is not secret, an attacker who can probe
// length cannot derive any byte from the secret).
function _constantTimeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

// Reusable admin gate for sensitive read endpoints (the burn/conjugate
// log, the full waitlist dump). Token via the x-admin-token header ONLY —
// never the query string, which leaks into Cloudflare access logs and
// browser history. Returns an error Response if unauthorized, or null to
// let the caller proceed.
function _adminGate(req, env, origin) {
  if (!env.ADMIN_TOKEN) return error('admin_token_not_set', 503, origin);
  const token = req.headers.get('x-admin-token') || '';
  if (!_constantTimeEquals(token, env.ADMIN_TOKEN)) return error('forbidden', 403, origin);
  return null;
}

// Fail-open per-IP throttle for the burn endpoint. The per-signer limit
// (a count of used_nonces) only sees SUCCESSFUL burns, so it can't stop a
// caller from spamming valid-signature-but-doomed requests that each cost
// an Alchemy round-trip (ownerOf + getTransactionReceipt). This caps
// attempts per IP per minute. CRITICAL: any error in the limiter returns
// true (proceed) — a limiter glitch must never block a legitimate burn on
// drop day. Threshold is generous; it only catches egregious spam.
async function _ipRateOk(env, req) {
  try {
    const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
    const salt = env.WAITLIST_IP_SALT || 'bioms-rl';
    const ipHash = await _sha256Hex(ip + ':burn:' + salt);
    const nowSec = Math.floor(Date.now() / 1000);
    const limit = parseInt(env.BURN_IP_RATE_PER_MIN || '20', 10);
    const row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM rl_hits WHERE ip_hash = ? AND ts > ?'
    ).bind(ipHash, nowSec - 60).first();
    await env.DB.prepare('INSERT INTO rl_hits (ip_hash, ts) VALUES (?, ?)').bind(ipHash, nowSec).run();
    return !(row && row.n >= limit);
  } catch (_) {
    return true; // fail-open
  }
}

// ERC-721 Transfer event signature — used to detect a burn from a tx
// receipt. The topic hash is keccak256("Transfer(address,address,uint256)").
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BURN_ADDRESSES = new Set([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
]);

// ----- Alchemy ownership -----
// viem's http() transport accepts a `timeout` (ms) — when the underlying
// fetch exceeds it, the call rejects rather than waiting for CF's 30s cap.
async function ownerOf(env, tokenId) {
  if (!env.CONTRACT_ADDRESS || env.CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return null; // pre-mint
  }
  if (!env.ALCHEMY_KEY) {
    console.warn('ownerOf called without ALCHEMY_KEY — returning null');
    return null;
  }
  const client = getMainnetClient(env);
  try {
    const owner = await client.readContract({
      address: env.CONTRACT_ADDRESS,
      abi: [{
        name: 'ownerOf', type: 'function', stateMutability: 'view',
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        outputs: [{ name: '', type: 'address' }],
      }],
      functionName: 'ownerOf',
      args: [BigInt(tokenId)],
    });
    return owner.toLowerCase();
  } catch (e) {
    // Log so a sustained Alchemy outage shows up in `wrangler tail`,
    // instead of silently returning null and surfacing as 502 'ownerOf_failed'.
    console.warn('ownerOf failed:', tokenId, e?.shortMessage || e?.message || String(e));
    return null;
  }
}

// Mask the Alchemy API key inside a URL before exposing the URL anywhere
// user-facing. The key sits in the path segment between /v2/ or /nft/v3/
// and the next slash. Replacement keeps the rest of the URL intact for
// diagnostics, while making the secret unrecoverable from the debug output.
function maskAlchemyKey(url) {
  if (!url) return url;
  return url
    .replace(/\/nft\/v3\/[^/?]+/, '/nft/v3/<KEY>')
    .replace(/\/v2\/[^/?]+/, '/v2/<KEY>');
}

async function listOwned(env, address, opts = {}) {
  // Strict hex-address validation (same standard as /api/health) so a
  // placeholder secret can't accidentally surface as "contract deployed".
  if (!/^0x[a-fA-F0-9]{40}$/.test(env.CONTRACT_ADDRESS || '') ||
      env.CONTRACT_ADDRESS.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { tokens: [], contractDeployed: false };
  }

  // ----- Primary path: Alchemy NFT API (indexed, fast, scales to 8000 supply) -----
  const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_KEY}/getNFTsForOwner` +
    `?owner=${address}&contractAddresses[]=${env.CONTRACT_ADDRESS}&withMetadata=false&pageSize=100`;
  let primaryError = null;
  let primaryStatus = null;
  let primaryBody = null;
  try {
    const r = await fetchWithTimeout(url);
    primaryStatus = r.status;
    if (r.ok) {
      const data = await r.json();
      const tokens = (data.ownedNfts || []).map(n => parseInt(n.tokenId, 10)).filter(n => Number.isFinite(n));
      const result = { tokens, contractDeployed: true, source: 'alchemy-nft' };
      if (opts.debug) result.debug = { url: maskAlchemyKey(url), status: r.status };
      return result;
    }
    // Non-OK from Alchemy NFT API. Capture the body so the debug
    // endpoint can show the actual error (rate limit / not-indexed /
    // unsupported contract type, etc).
    primaryBody = await r.text().catch(() => '');
    primaryError = 'alchemy_nft_api_status_' + r.status;
    console.warn('listOwned Alchemy NFT-API non-OK:', address, r.status, primaryBody.slice(0, 200));
  } catch (e) {
    primaryError = e?.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    console.warn('listOwned NFT-API exception:', address, primaryError, e?.message || e);
  }

  // ----- Fallback: Transfer-log scan via Alchemy JSON-RPC -----
  // The NFT API runs against Alchemy's indexed catalogue. New contracts
  // (test deploys, hours-old mainnet deploys, contracts using non-standard
  // patterns) often aren't in the index yet and the NFT API returns 4xx.
  // The JSON-RPC path is on-chain truth — eth_getLogs against the Transfer
  // event filtered by recipient gives us a deterministic owned-list.
  //
  // We then subtract any Transfers where the wallet was sender (out-going)
  // to avoid counting tokens they already moved away. Result: the set of
  // currently-held tokenIds.
  if (env.ALCHEMY_KEY) {
    try {
      const padded = '0x' + address.toLowerCase().replace('0x', '').padStart(64, '0');
      const rpcUrl = `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`;
      const baseFilter = {
        fromBlock: '0x0',
        toBlock: 'latest',
        address: env.CONTRACT_ADDRESS,
        topics: [TRANSFER_TOPIC],
      };
      // 1. Incoming transfers — recipient (topic 2) is our wallet
      const incomingReq = fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'eth_getLogs',
          params: [{ ...baseFilter, topics: [TRANSFER_TOPIC, null, padded] }],
        }),
      });
      // 2. Outgoing transfers — sender (topic 1) is our wallet
      const outgoingReq = fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'eth_getLogs',
          params: [{ ...baseFilter, topics: [TRANSFER_TOPIC, padded] }],
        }),
      });
      const [incoming, outgoing] = await Promise.all([incomingReq, outgoingReq]);
      if (incoming.ok && outgoing.ok) {
        const inLogs = (await incoming.json()).result || [];
        const outLogs = (await outgoing.json()).result || [];
        // Build a map tokenId -> latest block at which we received it.
        // If any outgoing log has a higher block for the same tokenId,
        // the token is no longer ours.
        const received = new Map();
        for (const l of inLogs) {
          const idHex = l.topics[3];
          if (!idHex) continue;
          const id = parseInt(idHex, 16);
          const block = parseInt(l.blockNumber, 16);
          if (!received.has(id) || received.get(id) < block) received.set(id, block);
        }
        for (const l of outLogs) {
          const idHex = l.topics[3];
          if (!idHex) continue;
          const id = parseInt(idHex, 16);
          const block = parseInt(l.blockNumber, 16);
          if (received.has(id) && block >= received.get(id)) received.delete(id);
        }
        const tokens = [...received.keys()].sort((a, b) => a - b);
        const result = { tokens, contractDeployed: true, source: 'transfer-logs' };
        if (opts.debug) {
          result.debug = {
            primary: { url: maskAlchemyKey(url), status: primaryStatus, error: primaryError, body: primaryBody?.slice(0, 400) },
            fallback: { incomingLogs: inLogs.length, outgoingLogs: outLogs.length },
          };
        }
        return result;
      }
      console.warn('listOwned fallback non-OK:', address, incoming.status, outgoing.status);
    } catch (e) {
      console.warn('listOwned fallback exception:', address, e?.message || e);
    }
  }

  // Both paths failed — return empty set with the primary error so the
  // UI can decide whether to retry or show a friendly fallback message.
  const result = { tokens: [], contractDeployed: true, error: primaryError || 'unknown_error' };
  if (opts.debug) {
    result.debug = { primary: { url: maskAlchemyKey(url), status: primaryStatus, error: primaryError, body: primaryBody?.slice(0, 400) } };
  }
  return result;
}

// ----- Signature verification -----
function eip712Domain(env) {
  return {
    name: 'Bioms Lab',
    version: '1',
    chainId: parseInt(env.CHAIN_ID || '1', 10),
    verifyingContract: env.CONTRACT_ADDRESS || '0x0000000000000000000000000000000000000000',
  };
}
const CONJUGATE_TYPES = {
  Conjugate: [
    { name: 'donorId', type: 'uint256' },
    { name: 'recipientId', type: 'uint256' },
    { name: 'trait', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// SEPARATE EIP-712 type for burn — intentionally distinct from
// Conjugate so MetaMask shows the user a DIFFERENT type name in the
// signature prompt. If a compromised site tried to disguise a burn
// as a crossbreed (or vice versa), the prompt would visibly mismatch
// the action the user thought they were doing. Defense-in-depth
// against UI-level phishing.
const BURN_TYPES = {
  Burn: [
    { name: 'donorId', type: 'uint256' },
    { name: 'recipientId', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
};

// ----- On-chain burn verification -----
// Fetches the transaction receipt and confirms it includes an ERC-721
// Transfer event from the expected signer to a burn address (0x0 or
// 0x...dEaD) for the expected tokenId, emitted by our contract.
//
// All four checks must pass:
//   1. Tx status === success (not reverted)
//   2. Transfer event present in logs
//   3. From = signer (the user actually burned their own token)
//   4. To = burn address (0x0 or dEaD — not just transferred to a friend)
//   5. tokenId matches donorId in our request
//   6. Contract address matches env.CONTRACT_ADDRESS (can't fake via a
//      different ERC-721 contract you control)
async function verifyBurnTx(env, txHash, expectedTokenId, expectedSigner) {
  if (!env.ALCHEMY_KEY) {
    return { ok: false, reason: 'no_alchemy_key' };
  }
  // Strict address validation — see /api/health for why placeholder
  // strings shouldn't slip through.
  if (!/^0x[a-fA-F0-9]{40}$/.test(env.CONTRACT_ADDRESS || '') ||
      env.CONTRACT_ADDRESS.toLowerCase() === '0x0000000000000000000000000000000000000000') {
    return { ok: false, reason: 'no_contract_address' };
  }
  if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    return { ok: false, reason: 'bad_tx_hash' };
  }
  const client = getMainnetClient(env);
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: txHash });
  } catch (e) {
    return { ok: false, reason: 'receipt_unavailable' };
  }
  if (!receipt) return { ok: false, reason: 'tx_not_mined' };
  if (receipt.status !== 'success') return { ok: false, reason: 'tx_reverted' };

  const contractLc = env.CONTRACT_ADDRESS.toLowerCase();
  const signerLc = expectedSigner.toLowerCase();
  const expectedTokenHex = '0x' + BigInt(expectedTokenId).toString(16).padStart(64, '0');

  // Walk the logs looking for a matching Transfer event. Multiple
  // events may exist (proxy contracts, marketplaces relay) — we just
  // need to find at least one that matches our criteria.
  for (const log of receipt.logs || []) {
    if (!log || !log.address || !log.topics) continue;
    if (log.address.toLowerCase() !== contractLc) continue;
    if (log.topics[0] !== TRANSFER_TOPIC) continue;
    if (log.topics.length < 4) continue;  // erc721 Transfer has 4 topics
    // topics[1] = from (left-padded), topics[2] = to, topics[3] = tokenId
    const fromAddr = '0x' + log.topics[1].slice(-40).toLowerCase();
    const toAddr   = '0x' + log.topics[2].slice(-40).toLowerCase();
    const tokenIdHex = log.topics[3].toLowerCase();
    if (fromAddr !== signerLc) continue;
    if (!BURN_ADDRESSES.has(toAddr)) continue;
    if (tokenIdHex !== expectedTokenHex.toLowerCase()) continue;
    return { ok: true, blockNumber: receipt.blockNumber };
  }
  return { ok: false, reason: 'no_matching_burn_event' };
}

// ----- Verifiable rejection roll -----
// Replaces Math.random() with a deterministic, audit-able derivation from
// the conjugation payload. Any client can recompute this from the signed
// message and verify the server didn't cheat.
//
//   roll = uint32(SHA-256(signature || '|' || nonce || '|' || donor || '|' || recipient)[0..4]) / 2^32
//
// The signature alone is unpredictable (depends on the user's private key)
// AND deterministic (same signature → same bytes). The server cannot bias
// the outcome by choosing inputs — every field is signed by the caller.
// Repeated nonces are blocked by used_nonces, so a player can't "reroll"
// a single message until they like the result.
async function verifiableRoll(signature, nonce, donorId, recipientId) {
  const payload = `${signature}|${nonce}|${donorId}|${recipientId}`;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const bytes = new Uint8Array(buf);
  // Hex for audit trail.
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  // First 4 bytes → uint32 → normalize to [0, 1).
  const u32 = (bytes[0] << 24 | bytes[1] << 16 | bytes[2] << 8 | bytes[3]) >>> 0;
  return { roll: u32 / 4294967296, hex };
}

// ----- Conjugation handler -----
async function handleConjugate(req, env, ctx, origin) {
  if (!env.CONTRACT_ADDRESS || env.CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return error('Mint contract not yet deployed. Lab will activate post-mint.', 503, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }

  const { donorId, recipientId, trait, nonce, deadline, address, signature } = body || {};
  if (typeof donorId !== 'number' || typeof recipientId !== 'number') return error('bad_ids', 400, origin);
  if (donorId === recipientId) return error('same_token', 400, origin);
  const maxId = maxTokenId(env);
  if (donorId < 0 || donorId > maxId || recipientId < 0 || recipientId > maxId) return error('bad_ids', 400, origin);
  if (!TRANSFERABLE_TRAITS.has(trait)) return error('untransferable_trait', 400, origin);
  if (typeof nonce !== 'number' || typeof deadline !== 'number') return error('bad_nonce_or_deadline', 400, origin);
  if (Date.now() > deadline) return error('signature_expired', 400, origin);
  if (!isAddress(address)) return error('bad_address', 400, origin);
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return error('bad_signature', 400, origin);

  // 1. Verify signature recovers to address
  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain: eip712Domain(env),
      types: CONJUGATE_TYPES,
      primaryType: 'Conjugate',
      message: {
        donorId: BigInt(donorId),
        recipientId: BigInt(recipientId),
        trait,
        nonce: BigInt(nonce),
        deadline: BigInt(deadline),
      },
      signature,
    });
  } catch (e) {
    return error('signature_recovery_failed', 400, origin);
  }
  if (getAddress(recovered) !== getAddress(address)) return error('signer_mismatch', 401, origin);

  // Rate limit: max N conjugates per signer per minute. Uses the
  // used_nonces table as the ledger — every accepted conjugate inserts
  // a nonce, so counting recent nonces by this signer == counting
  // recent successful conjugates. A compromised wallet extension can
  // still sign in bulk, but it can't hammer the endpoint to drain the
  // user's depletion-bucket faster than this rate.
  const rateLimit = parseInt(env.CONJUGATE_RATE_PER_MIN || '5', 10);
  const windowSec = 60;
  const nowSec0 = Math.floor(Date.now() / 1000);
  const signerLcEarly = address.toLowerCase();
  const recentRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM used_nonces WHERE signer = ? AND used_at > ?'
  ).bind(signerLcEarly, nowSec0 - windowSec).first();
  if (recentRow && recentRow.n >= rateLimit) {
    return error('rate_limited', 429, origin);
  }

  // 2. Verify nonce hasn't been used (replay protection)
  const nonceRow = await env.DB.prepare(
    'SELECT 1 FROM used_nonces WHERE signer = ? AND nonce = ?'
  ).bind(signerLcEarly, nonce).first();
  if (nonceRow) return error('nonce_used', 401, origin);

  // 3. Verify caller owns BOTH tokens on-chain
  const [donorOwner, recOwner] = await Promise.all([ownerOf(env, donorId), ownerOf(env, recipientId)]);
  if (!donorOwner || !recOwner) return error('ownerOf_failed', 502, origin);
  const signerLc = address.toLowerCase();
  if (donorOwner !== signerLc) return error('not_donor_owner', 403, origin);
  if (recOwner !== signerLc) return error('not_recipient_owner', 403, origin);

  // 4. Verify donor currently has the trait
  const donorBase = generateBaseTraits(donorId);
  const donorData = await loadTokenState(env, donorId);
  const donorDepletedNow = new Set(donorData.depletions.map(d => d.trait));
  if (!tokenHasTrait(donorBase, donorData.mutations, donorDepletedNow, trait)) {
    return error('trait_unavailable', 409, origin);
  }

  // 5. Resolve donor's current palette value (needed if trait === 'palette')
  let donorPaletteValue = null;
  if (trait === 'palette') {
    donorPaletteValue = donorData.mutations.palette || donorBase.palette;
  }

  // 6. Roll for rejection — verifiable RNG derived from the signed payload.
  //    Server has no degree of freedom; player can recompute and audit.
  //    Defensive parse: parseFloat('') is NaN, and `roll < NaN === false`
  //    would silently mean "no rejection ever". Fallback to the documented
  //    default if env is missing or malformed.
  const _rrParsed = parseFloat(env.REJECTION_RATE);
  const rejectionRate = Number.isFinite(_rrParsed) && _rrParsed >= 0 && _rrParsed <= 1
    ? _rrParsed : 0.15;
  const { roll, hex: rollHex } = await verifiableRoll(signature, nonce, donorId, recipientId);
  const rejected = roll < rejectionRate;
  const ts = Date.now();
  const tsSec = Math.floor(ts / 1000);
  // Same defensive parse: parseInt('abc') is NaN, and tsSec + NaN = NaN,
  // which binds as NULL in D1 → `regenerates_at > now` evaluates NULL/false
  // → depletion treated as already-regenerated → cooldown bypassed.
  const _csParsed = parseInt(env.COOLDOWN_SECONDS, 10);
  const cooldownSec = Number.isFinite(_csParsed) && _csParsed > 0
    ? _csParsed : 2592000; // 30 days default

  // 7. Compute recipient's post-mutation state (only used if !rejected)
  const recipientData = await loadTokenState(env, recipientId);
  const recM = recipientData.mutations;
  if (!rejected) {
    const kind = TRAIT_KIND[trait];
    if (kind === 'palette') {
      recM.palette = donorPaletteValue;
    } else if (kind === 'organelle') {
      if (!recM.organelles.includes(trait)) recM.organelles.push(trait);
    } else if (kind === 'anomaly') {
      if (!recM.anomalies.includes(trait)) recM.anomalies.push(trait);
    }
  }

  // 8. Persist as a SINGLE D1 batch — atomic across all tables.
  //    The depletion INSERT uses WHERE NOT EXISTS for a live-cooldown
  //    guard: two parallel conjugations of the same (donor, trait) can
  //    both pass step 4 but only one can land the depletion row. The
  //    post-batch check below detects that case and returns 409.
  const stmts = [
    env.DB.prepare(
      'INSERT INTO used_nonces (signer, nonce, used_at) VALUES (?, ?, ?)'
    ).bind(signerLc, nonce, tsSec),
    env.DB.prepare(
      'INSERT INTO log (ts, donor, recipient, trait, result, signer, roll_hex) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(ts, donorId, recipientId, trait, rejected ? 'rejected' : 'transfer', signerLc, rollHex),
  ];

  if (!rejected) {
    stmts.push(
      // Depletion insert — conditional on no active cooldown for this (donor, trait).
      env.DB.prepare(`
        INSERT INTO depletions (token_id, trait, to_token, donated_at, regenerates_at)
        SELECT ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM depletions WHERE token_id = ? AND trait = ? AND regenerates_at > ?
        )
      `).bind(
        donorId, trait, recipientId, tsSec, tsSec + cooldownSec,
        donorId, trait, tsSec
      ),
      // Recipient state — conditional on the depletion having just landed.
      // If a parallel request raced and won the depletion, this no-ops too,
      // keeping (donor cooldown ↔ recipient mutation) in lockstep.
      env.DB.prepare(`
        INSERT INTO token_state (token_id, received_palette, received_organelles, received_anomalies, updated_at)
        SELECT ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM depletions WHERE token_id = ? AND trait = ? AND donated_at = ? AND to_token = ?
        )
        ON CONFLICT(token_id) DO UPDATE SET
          received_palette = excluded.received_palette,
          received_organelles = excluded.received_organelles,
          received_anomalies = excluded.received_anomalies,
          updated_at = excluded.updated_at
      `).bind(
        recipientId, recM.palette || null, JSON.stringify(recM.organelles), JSON.stringify(recM.anomalies), tsSec,
        donorId, trait, tsSec, recipientId
      )
    );
  }

  let batchResults;
  try {
    batchResults = await env.DB.batch(stmts);
  } catch (e) {
    // Most common cause: used_nonces UNIQUE violation (caller re-sent).
    // We already checked step 2 but the parallel-request window is real.
    if (String(e?.message || '').toLowerCase().includes('unique')) {
      return error('nonce_used', 401, origin);
    }
    console.error('Conjugate batch failed:', e?.stack || e);
    return error('persist_failed', 500, origin);
  }

  // Post-batch race detection: confirm the depletion landed. If it
  // didn't, a parallel conjugation grabbed this trait — the recipient
  // state insert was no-op'd (the EXISTS guard saw nothing), but the
  // nonce is burned and the log row claims 'transfer'. Patch the log
  // and tell the caller.
  if (!rejected) {
    const depConfirm = await env.DB.prepare(
      'SELECT 1 FROM depletions WHERE token_id = ? AND trait = ? AND donated_at = ? AND to_token = ?'
    ).bind(donorId, trait, tsSec, recipientId).first();
    if (!depConfirm) {
      await env.DB.prepare(
        'UPDATE log SET result = ? WHERE ts = ? AND donor = ? AND recipient = ? AND signer = ?'
      ).bind('conjugate_race', ts, donorId, recipientId, signerLc).run();
      return error('trait_already_donated', 409, origin);
    }
    // Best-effort: ping OpenSea metadata-refresh for both tokens so the
    // marketplace re-caches the new state. Failures are visible in the
    // log table (result='os_refresh_failed') rather than silently swallowed.
    refreshOpenSeaMetadata(env, donorId, recipientId).catch(e => {
      console.warn('OS refresh top-level error:', e?.message || e);
    });
    // Background re-render of master PNGs. ctx.waitUntil lets the response
    // return immediately while the screenshots happen for ~2-5s each.
    // Both bioms changed (mutual trait share) so both need regen.
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil((async () => {
        try { await renderTokenMaster(env, donorId); } catch (_) {}
        try { await renderTokenMaster(env, recipientId); } catch (_) {}
      })());
    }
  }

  return json({
    ok: !rejected,
    rejected,
    log: { ts, donor: donorId, recipient: recipientId, trait, op: rejected ? 'rejected' : 'transfer', rollHex },
  }, {}, origin);
}

// Best-effort OpenSea metadata-refresh ping. Failures are recorded in
// the log table so a rotated/expired API key surfaces in operations
// review instead of dying silently.
async function refreshOpenSeaMetadata(env, ...tokenIds) {
  const apiKey = openseaKey(env);
  if (!apiKey || !env.CONTRACT_ADDRESS) return;
  const chain = env.CHAIN_ID === '1' ? 'ethereum' : 'sepolia';
  const ts = Date.now();
  const settled = await Promise.allSettled(tokenIds.map(id =>
    fetchWithTimeout(
      `https://api.opensea.io/api/v2/chain/${chain}/contract/${env.CONTRACT_ADDRESS}/nfts/${id}/refresh`,
      { method: 'POST', headers: { 'X-API-KEY': apiKey } },
    ).then(r => ({ id, ok: r.ok, status: r.status }))
  ));
  const failures = settled
    .map((s, i) => ({ s, id: tokenIds[i] }))
    .filter(({ s }) => s.status === 'rejected' || !s.value?.ok);
  if (failures.length === 0) return;
  // Best-effort log; don't await further fan-out into more failures.
  try {
    const stmts = failures.map(({ s, id }) => {
      const detail = s.status === 'rejected'
        ? (s.reason?.name === 'AbortError' ? 'timeout' : (s.reason?.message || 'rejected'))
        : `http_${s.value.status}`;
      return env.DB.prepare(
        'INSERT INTO log (ts, donor, recipient, trait, result, signer, roll_hex) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(ts, id, 0, `os_refresh:${detail}`, 'os_refresh_failed', '0x', null);
    });
    await env.DB.batch(stmts);
  } catch (e) {
    console.warn('Failed to log OS refresh failure:', e?.message || e);
  }
}

// ============================================================
// BURN handler — permanent on-chain sacrifice
//
// Two-step UX on the client:
//   1. User signs EIP-712 Burn (intent + replay protection)
//   2. User submits tx: contract.burn(donorId) — wallet shows real
//      "burn this NFT" prompt, gas is paid, token leaves supply
//   3. Client posts { signature, tx_hash } to this endpoint
//
// Worker verifies:
//   - Signature recovers to claimed signer
//   - Nonce hasn't been used
//   - tx_hash actually represents a burn of donorId from signer to
//     a burn address, emitted by our contract (verifyBurnTx)
//   - recipientId is owned by the signer (so traits land in their wallet)
//
// On success:
//   - INSERT into burns table (PK enforces "burned only once" forever)
//   - Update recipient's token_state: absorb all donor's effective
//     traits + append donor seed to absorbed_seeds for rank ladder
//   - Refresh OpenSea metadata for the recipient (donor is gone)
// ============================================================
async function handleBurn(req, env, ctx, origin) {
  if (!env.CONTRACT_ADDRESS || env.CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return error('Mint contract not yet deployed. Burn will activate post-mint.', 503, origin);
  }
  if (!env.ALCHEMY_KEY) {
    return error('Burn verification requires Alchemy. Set ALCHEMY_KEY secret.', 503, origin);
  }

  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }

  const { donorId, recipientId, nonce, deadline, address, signature, txHash } = body || {};
  if (typeof donorId !== 'number' || typeof recipientId !== 'number') return error('bad_ids', 400, origin);
  if (donorId === recipientId) return error('same_token', 400, origin);
  const maxId = maxTokenId(env);
  if (donorId < 0 || donorId > maxId || recipientId < 0 || recipientId > maxId) return error('bad_ids', 400, origin);
  if (typeof nonce !== 'number' || typeof deadline !== 'number') return error('bad_nonce_or_deadline', 400, origin);
  if (Date.now() > deadline) return error('signature_expired', 400, origin);
  if (!isAddress(address)) return error('bad_address', 400, origin);
  if (typeof signature !== 'string' || !signature.startsWith('0x')) return error('bad_signature', 400, origin);
  if (typeof txHash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(txHash)) return error('bad_tx_hash', 400, origin);

  // 1. Verify EIP-712 signature
  let recovered;
  try {
    recovered = await recoverTypedDataAddress({
      domain: eip712Domain(env),
      types: BURN_TYPES,
      primaryType: 'Burn',
      message: {
        donorId: BigInt(donorId),
        recipientId: BigInt(recipientId),
        nonce: BigInt(nonce),
        deadline: BigInt(deadline),
      },
      signature,
    });
  } catch (e) {
    return error('signature_recovery_failed', 400, origin);
  }
  if (getAddress(recovered) !== getAddress(address)) return error('signer_mismatch', 401, origin);

  const signerLc = address.toLowerCase();
  const nowSec = Math.floor(Date.now() / 1000);

  // 2. Rate limit (shared bucket with conjugate via used_nonces table)
  const rateLimit = parseInt(env.CONJUGATE_RATE_PER_MIN || '5', 10);
  const recentRow = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM used_nonces WHERE signer = ? AND used_at > ?'
  ).bind(signerLc, nowSec - 60).first();
  if (recentRow && recentRow.n >= rateLimit) {
    return error('rate_limited', 429, origin);
  }

  // 2b. Per-IP throttle (fail-open) — guards Alchemy quota against
  // valid-signature spam the per-signer counter (successful burns only)
  // can't see. Runs before the ownerOf / verifyBurnTx round-trips below.
  if (req && !(await _ipRateOk(env, req))) return error('rate_limited', 429, origin);

  // 3. Replay protection
  const nonceRow = await env.DB.prepare(
    'SELECT 1 FROM used_nonces WHERE signer = ? AND nonce = ?'
  ).bind(signerLc, nonce).first();
  if (nonceRow) return error('nonce_used', 401, origin);

  // 4. Has this token already been burned? PK on burns.burned_token_id
  //    enforces this at INSERT, but we want a clean 409 with reason
  //    instead of a generic batch failure.
  const burnRow = await env.DB.prepare(
    'SELECT tx_hash, burned_at FROM burns WHERE burned_token_id = ?'
  ).bind(donorId).first();
  if (burnRow) return error('already_burned', 409, origin);

  // 5. Recipient must be owned by the signer (donor's owner check is
  //    moot — it was just burned, ownerOf will revert)
  const recOwner = await ownerOf(env, recipientId);
  if (!recOwner) return error('ownerOf_failed', 502, origin);
  if (recOwner !== signerLc) return error('not_recipient_owner', 403, origin);

  // 6. The big one — verify on-chain that this signer actually
  //    burned donorId via the tx they claim
  const verdict = await verifyBurnTx(env, txHash, donorId, signerLc);
  if (!verdict.ok) return error('burn_tx_verification_failed:' + verdict.reason, 400, origin);

  // 7. Compute absorber's new state. The recipient absorbs ALL of the
  //    donor's effective traits (base + any prior mutations donor had).
  const donorBase = generateBaseTraits(donorId);
  const donorData = await loadTokenState(env, donorId);
  const donorEffectivePalette = donorData.mutations.palette || donorBase.palette;
  const donorEffectiveOrganelles = new Set(donorBase.organelles);
  for (const o of (donorData.mutations.organelles || [])) donorEffectiveOrganelles.add(o);
  const donorEffectiveAnomalies = new Set();
  if (donorBase.phageAttached || (donorData.mutations.anomalies || []).includes('phageAttached')) donorEffectiveAnomalies.add('phageAttached');
  if (donorBase.endosymbiont    || (donorData.mutations.anomalies || []).includes('endosymbiont'))    donorEffectiveAnomalies.add('endosymbiont');
  if (donorBase.biofilmHalo     || (donorData.mutations.anomalies || []).includes('biofilmHalo'))     donorEffectiveAnomalies.add('biofilmHalo');

  // Load recipient's current state and merge
  const recipientData = await loadTokenState(env, recipientId);
  const recM = recipientData.mutations;
  const recAbsorbedRaw = (await env.DB.prepare(
    'SELECT absorbed_seeds FROM token_state WHERE token_id = ?'
  ).bind(recipientId).first()) || {};
  let absorbedSeeds = [];
  try { if (recAbsorbedRaw.absorbed_seeds) absorbedSeeds = JSON.parse(recAbsorbedRaw.absorbed_seeds); } catch (_) {}
  if (!Array.isArray(absorbedSeeds)) absorbedSeeds = [];

  // Recipient's palette becomes donor's (donor's stain "wins" — visual
  // signal that absorption changed the survivor's appearance)
  recM.palette = donorEffectivePalette;
  // Organelles + anomalies: union, dedup
  const recOrgSet = new Set(recM.organelles || []);
  for (const o of donorEffectiveOrganelles) if (o !== 'capsule' && o !== 'nucleoid') recOrgSet.add(o);
  recM.organelles = Array.from(recOrgSet);
  const recAnoSet = new Set(recM.anomalies || []);
  for (const a of donorEffectiveAnomalies) recAnoSet.add(a);
  recM.anomalies = Array.from(recAnoSet);
  // Lineage record = union of both trees + the donor itself.
  absorbedSeeds = Array.from(new Set([
    ...absorbedSeeds,
    ...(Array.isArray(donorData.absorbedSeeds) ? donorData.absorbedSeeds : []),
    donorId,
  ]));

  // === Additive mass (mirrors lab.html): the survivor's MASS = sum of both
  //     organisms' masses; the tier is derived from mass (1+floor(log2),
  //     capped 6). Any two Bioms combine — no equal-rank rule — so nothing is
  //     wasted and no token gets stuck. A token's current mass = its stored
  //     mass, else its pre-mint floor (2^(premintRank-1)), else 1 (base).
  //     This is purely server-side state: a tampered client can't fabricate
  //     mass, since each side is read from D1 / the fixed pre-mint table.
  const recipientMass = (recipientData.mass != null ? recipientData.mass : _premintMass(recipientId));
  const donorMass     = (donorData.mass     != null ? donorData.mass     : _premintMass(donorId));
  const newMass = recipientMass + donorMass;
  const newRank = _rankForMass(newMass);

  const ts = Date.now();
  const tsSec = Math.floor(ts / 1000);

  // 8. Persist as atomic batch
  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO used_nonces (signer, nonce, used_at) VALUES (?, ?, ?)'
      ).bind(signerLc, nonce, tsSec),
      env.DB.prepare(
        'INSERT INTO burns (burned_token_id, recipient_token_id, signer, tx_hash, burned_at) VALUES (?, ?, ?, ?, ?)'
      ).bind(donorId, recipientId, signerLc, txHash, ts),
      env.DB.prepare(
        'INSERT INTO log (ts, donor, recipient, trait, result, signer, roll_hex) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).bind(ts, donorId, recipientId, '*burn*', 'burn', signerLc, null),
      env.DB.prepare(`
        INSERT INTO token_state (token_id, received_palette, received_organelles, received_anomalies, absorbed_seeds, mass, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          received_palette = excluded.received_palette,
          received_organelles = excluded.received_organelles,
          received_anomalies = excluded.received_anomalies,
          absorbed_seeds = excluded.absorbed_seeds,
          mass = excluded.mass,
          updated_at = excluded.updated_at
      `).bind(
        recipientId,
        recM.palette || null,
        JSON.stringify(recM.organelles),
        JSON.stringify(recM.anomalies),
        JSON.stringify(absorbedSeeds),
        newMass,
        tsSec
      ),
    ]);
  } catch (e) {
    if (String(e?.message || '').toLowerCase().includes('unique')) {
      // burns PK or used_nonces PK violation — concurrent burn race
      return error('already_burned_or_nonce_used', 409, origin);
    }
    console.error('Burn batch failed:', e?.stack || e);
    return error('persist_failed', 500, origin);
  }

  // Best-effort: refresh OpenSea metadata for the recipient (donor's
  // metadata becomes irrelevant once it's burned on-chain).
  refreshOpenSeaMetadata(env, recipientId).catch(e => {
    console.warn('OS refresh top-level error:', e?.message || e);
  });
  // Background re-render of recipient's master PNG. Burn-absorb cycles
  // tend to produce the most visually dramatic mutations (palette
  // blends + organelle stacks + cell-count bumps), so a fresh master
  // is especially important here. ctx.waitUntil keeps the user's
  // response fast while the screenshot runs in the background.
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(renderTokenMaster(env, recipientId).catch(() => {}));
  }

  // Survivor's new mass + derived tier level (1-6). Mirrors buildMetadata +
  // lab.html so the Lab's post-burn state matches what OpenSea will show.
  return json({
    ok: true,
    burnedTokenId: donorId,
    recipientTokenId: recipientId,
    txHash,
    blockNumber: verdict.blockNumber ? String(verdict.blockNumber) : null,
    absorbedSeeds,
    mass: newMass,
    rank: newRank,
  }, {}, origin);
}

// ----- Route handlers -----
async function handleOwned(env, address, origin, url) {
  if (!isAddress(address)) return error('bad_address', 400, origin);
  // ?debug=1 surfaces the full Alchemy URL / status / response body — useful
  // for triaging "No Bioms" complaints when an indexer is mis-behaving.
  // Public, no auth: the address is already in the path and the URL +
  // status are not secrets (the API key is masked inside the URL but the
  // payload itself is harmless).
  const debug = url && url.searchParams && url.searchParams.get('debug') === '1';
  const result = await listOwned(env, address, { debug });
  return json(result, {}, origin);
}

async function handleState(env, tokenIdStr, origin) {
  const tokenId = parseInt(tokenIdStr, 10);
  const maxId = maxTokenId(env);
  if (!Number.isFinite(tokenId) || tokenId < 0 || tokenId > maxId) return error('bad_token_id', 400, origin);
  const { mutations, depletions } = await loadTokenState(env, tokenId);
  return json({ tokenId, mutations, depletions }, {
    headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' },
  }, origin);
}

async function handleStateBatch(env, tokensParam, origin) {
  const maxId = maxTokenId(env);
  // Cap the raw input length BEFORE .split() — otherwise a multi-MB
  // "1,1,1,…" query string allocates a giant array (DOS). 100 ids
  // × 5 chars each + 99 commas = 599 max, so 1024 is generous.
  if ((tokensParam || '').length > 1024) return error('tokens_too_long', 400, origin);
  const ids = (tokensParam || '').split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n >= 0 && n <= maxId).slice(0, 100);
  if (ids.length === 0) return json({ states: {} }, {}, origin);
  const entries = await Promise.all(ids.map(async id => [id, await loadTokenState(env, id)]));
  return json({ states: Object.fromEntries(entries) }, {
    headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' },
  }, origin);
}

// ============================================================
// SPECIMEN STATE — server-side port of specimen-engine.js
// ============================================================
// Mirrors the pure state-generation logic from specimen-engine.js so
// the Worker can produce OpenSea-compatible metadata without spinning
// up the full browser engine (which depends on DOM APIs).
//
// CRITICAL: weights/order/RNG semantics MUST match specimen-engine.js
// byte-for-byte. The CI parity check (tests/rng_parity_check.sh)
// catches drift between this port and the original; if you touch any
// constant here, also update specimen-engine.js + tests/rng_parity.py.
// ============================================================

function _mulberry32(seed) {
  let t = seed;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const _PALETTE_WEIGHTS = [
  ['gramPositive', 13], ['gramNegative', 11], ['fluorescent', 10], ['methylene', 9],
  ['darkfield', 6], ['acid_fast', 5], ['giemsa', 4], ['iridescent_aurora', 5],
  ['ghost', 4], ['safranin', 3], ['india_ink', 3], ['gram_variable', 1],
  ['malachite', 4], ['congo_red', 3], ['carbol_fuchsin', 4], ['bismarck_brown', 4],
  ['nile_blue', 4], ['eosin', 2], ['toluidine', 3], ['ziehl_dual', 1], ['spore_dual', 1],
];
const _MORPHOLOGY_WEIGHTS = [
  ['coccus', 13], ['bacillus', 13], ['vibrio', 12], ['spirillum', 12],
  ['filament', 10], ['cluster', 10], ['diplo', 10], ['streptobacillus', 8],
  ['tetrad', 7], ['sarcina', 3], ['mycelium', 2],
];
const _RESERVE_WEIGHTS = [
  ['none', 64], ['phb', 12], ['volutin', 10], ['magnetosomes', 7],
  ['sulfur', 4], ['crystalline', 3],
];
const _LIFECYCLE_WEIGHTS = [
  ['vegetative', 78], ['binary_fission', 10], ['sporulating', 6], ['heterocyst', 6],
];

function _pickW(weights, rng) {
  const r = rng() * 100;
  let acc = 0;
  for (const [n, w] of weights) { acc += w; if (r < acc) return n; }
  return weights[weights.length - 1][0];
}

const _NAME_PREFIX = [
  'Halo','Aure','Lumi','Spiro','Vibrio','Coccu','Micro','Crypto',
  'Polyspora','Sympha','Glia','Plasmo','Endo','Strepto',
  'Acid','Chemo','Pheno','Pseudo','Auro','Cyto','Phago','Lipo',
  'Astro','Cryo','Thermo','Photo','Carbo','Ferro','Magneto','Geo','Nano','Xeno',
];
const _NAME_SUFFIX = [
  'philia','lensis','nescens','aria','caula','genia','nax',
  'corymba','roteus','mensis','tarchus','lina','striga','thymos',
  'bacter','coccus','monas','philis','mira','voraxa','geri',
  'fila','ster','dictyon','helios','gena','sphaera','tuus','vorans','capsa','mantia','oides',
];
function _pickName(seed) {
  const r = _mulberry32(seed);
  return (_NAME_PREFIX[Math.floor(r() * 32)] + _NAME_SUFFIX[Math.floor(r() * 32)]).toUpperCase();
}

// EXACT mirror of specimen-engine.js → generateState(seed).
// Output keys + order of rng() calls must stay identical or the
// rendered visual will not match the metadata.
function _generateState(seed) {
  const rng = _mulberry32(seed);
  const state = { seed, organelles: ['capsule'] };  // use Array instead of Set so JSON.stringify works
  state.morphology = _pickW(_MORPHOLOGY_WEIGHTS, rng);
  state.palette = _pickW(_PALETTE_WEIGHTS, rng);
  state.cellCount = 1 + Math.floor(rng() * 6);
  state.accentCount = Math.floor(rng() * 4);
  if (rng() < 0.85) state.organelles.push('nucleoid');
  if (rng() < 0.45) state.organelles.push('ribosomes');
  if (rng() < 0.55) state.organelles.push('pili');
  if (rng() < 0.30) state.organelles.push('flagellum');
  if (rng() < 0.40) state.organelles.push('plasmid');
  if (rng() < 0.15) state.organelles.push('endospore');
  if (rng() < 0.20) state.organelles.push('inclusion');
  if (rng() < 0.20) state.organelles.push('eyespot');
  if (rng() < 0.15) state.organelles.push('axial');
  state.reserveGranule = _pickW(_RESERVE_WEIGHTS, rng);
  let lc = _pickW(_LIFECYCLE_WEIGHTS, rng);
  if (lc === 'heterocyst' && state.morphology !== 'filament' && state.morphology !== 'mycelium') lc = 'vegetative';
  state.lifecycle = lc;
  state.phageAttached = rng() < 0.015;
  state.endosymbiont = rng() < 0.01;
  state.biofilmHalo  = rng() < 0.02;
  return state;
}

// Human-readable trait labels (used in OpenSea attributes panel).
// Kept terse — OpenSea trait values render on small chips.
const _PALETTE_LABEL = {
  gramPositive: 'Gram-positive purple',
  gramNegative: 'Gram-negative pink',
  fluorescent: 'Fluorescent green',
  methylene: 'Methylene blue',
  darkfield: 'Darkfield silver',
  acid_fast: 'Acid-fast carmine',
  giemsa: 'Giemsa indigo',
  iridescent_aurora: 'Iridescent aurora',
  ghost: 'Ghost',
  safranin: 'Safranin orange',
  india_ink: 'India ink negative',
  gram_variable: 'Gram-variable',
  malachite: 'Malachite green',
  congo_red: 'Congo red',
  carbol_fuchsin: 'Carbol fuchsin',
  bismarck_brown: 'Bismarck brown',
  nile_blue: 'Nile blue',
  eosin: 'Eosin coral',
  toluidine: 'Toluidine violet',
  ziehl_dual: 'Ziehl-Neelsen dual',
  spore_dual: 'Schaeffer-Fulton dual',
  // Burn-unlock / apex prize palettes (pre-minted Chimera/Phoenix carry these).
  radioactive: 'Radioactive', void: 'Void', plasma: 'Plasma',
  aurora_storm: 'Aurora storm', gold: 'Gold',
};
const _MORPH_LABEL = {
  coccus: 'Coccus', bacillus: 'Bacillus', vibrio: 'Vibrio',
  spirillum: 'Spirillum', filament: 'Filament', cluster: 'Cluster',
  diplo: 'Diplo', streptobacillus: 'Streptobacillus',
  tetrad: 'Tetrad', sarcina: 'Sarcina', mycelium: 'Mycelium',
};
const _LIFECYCLE_LABEL = {
  vegetative: 'Vegetative', binary_fission: 'Binary fission',
  sporulating: 'Sporulating', heterocyst: 'Heterocyst',
};
const _RESERVE_LABEL = {
  none: 'None', phb: 'PHB granules', volutin: 'Volutin',
  magnetosomes: 'Magnetosomes', sulfur: 'Sulfur granules',
  crystalline: 'Crystalline inclusions',
};
const _ORG_LABEL = {
  capsule: 'Capsule', nucleoid: 'Nucleoid', ribosomes: 'Ribosomes',
  pili: 'Pili', flagellum: 'Flagellum', plasmid: 'Plasmid',
  endospore: 'Endospore', inclusion: 'Inclusion', eyespot: 'Eyespot',
  axial: 'Axial filament',
};

// Binary tier ladder — rank IS the tier level (1-6). Two equal-rank Bioms
// merge into one of rank+1, so a rank-r Biom is the survivor of a balanced
// tree of 2^(r-1) base organisms. Genesis 1 · Hybrid 2 · Chimera 4 · Phoenix
// 8 · Superorganism 16 · Biome 32 (organisms). The top two are burn-only.
// Mirrors lab.html tierForRank exactly. New tiers later = extend this ladder.
function _tierForRank(rank) {
  if (rank <= 1)  return 'Genesis';
  if (rank === 2) return 'Hybrid';
  if (rank === 3) return 'Chimera';
  if (rank === 4) return 'Phoenix';
  if (rank === 5) return 'Superorganism';
  return 'Biome';                          // 6+ — apex, burn-only
}

// Additive-mass model (mirrors lab.html massToRank exactly): a token's rank is
// derived from its MASS = total base organisms folded into it (Genesis = 1).
// Merging adds masses; the tier climbs at each doubling. 1+floor(log2(mass)),
// capped at 6. mass 1→Genesis · 2→Hybrid · 4→Chimera · 8→Phoenix · 16→
// Superorganism · 32→Biome. So 32 organisms → one Biome; max 250 in 8,000.
function _rankForMass(mass) {
  // Mirror lab.html massToRank EXACTLY (threshold table, not a log2 formula) so
  // the server result is byte-identical to the client's live preview.
  const m = Math.max(1, Math.floor(mass || 1));
  if (m <= 1)  return 1;
  if (m <= 3)  return 2;
  if (m <= 7)  return 3;
  if (m <= 15) return 4;
  if (m <= 31) return 5;
  return 6;
}
// Pre-mint elevated tokens start with a head-start mass = 2^(rank-1):
// Hybrid(2)→2, Chimera(3)→4, Phoenix(4)→8. Base tokens are mass 1.
function _premintMass(id) {
  const pm = PREMINT[id] || PREMINT[String(id)];
  return pm ? Math.pow(2, pm.rank - 1) : 1;
}

// === OpenSea metadata builder ===
// Returns the JSON object that lives at /api/metadata/<tokenId>.
// Applies persistent mutations from D1 (from past crossbreed/burn
// operations) so the rendered image stays in sync with what the
// chain records show.
async function buildMetadata(env, tokenId) {
  const state = _generateState(tokenId);
  const padded = String(tokenId).padStart(5, '0');
  const name = _pickName(tokenId);

  // Layer persistent mutations from the Lab (post-conjugate state).
  // If the token has been burned in the Lab, the absorbed traits
  // become part of its metadata. Defensive — if D1 is unreachable
  // we serve the base specimen rather than 500'ing.
  let mutations = {};
  let imageVersion = 1;
  let absorbedSeeds = [];
  let storedMass = null;
  try {
    const loaded = await loadTokenState(env, tokenId);
    mutations = loaded.mutations || {};
    imageVersion = loaded.imageVersion || 1;
    absorbedSeeds = loaded.absorbedSeeds || [];
    storedMass = (loaded.mass != null) ? loaded.mass : null;
  } catch (_) { /* ignore */ }

  // Effective state after mutations.
  // loadTokenState returns mutations as {palette, organelles, anomalies}
  // (matching D1 column names without the "received_" prefix). Schema
  // only persists those three — morphology/cellCount/lifecycle/reserve
  // shares aren't in token_state, so they always come from the seed.
  const eff = { ...state, organelles: state.organelles.slice() };
  // Pre-mint elevation — intrinsic elevated traits for the ~550 designated
  // tokens, matching the self-elevated render. D1 burn mutations layer on top.
  const pm = PREMINT[tokenId] || PREMINT[String(tokenId)];
  if (pm) {
    if (pm.stain) eff.palette = pm.stain;
    if (typeof pm.cells === 'number') eff.cellCount = pm.cells;
    if (Array.isArray(pm.organelles)) eff.organelles = pm.organelles.slice();
    if (pm.phage) eff.phageAttached = true;
    if (pm.biofilm) eff.biofilmHalo = true;
    if (pm.endo) eff.endosymbiont = true;
  }
  if (mutations.palette) eff.palette = mutations.palette;
  if (Array.isArray(mutations.organelles)) {
    for (const o of mutations.organelles) if (!eff.organelles.includes(o)) eff.organelles.push(o);
  }
  if (Array.isArray(mutations.anomalies)) {
    for (const a of mutations.anomalies) eff[a] = true;
  }
  // Mass = total base organisms folded in: the stored mass once the token has
  // been merged in the Lab, else the pre-mint floor (2^(premintRank-1)), else 1
  // (base Genesis). Tier (rank) is derived from mass — mirrors lab.html exactly.
  // 32 organisms = one Biome.
  const mass = (storedMass != null ? storedMass : _premintMass(tokenId));
  const rank = _rankForMass(mass);
  const tier = _tierForRank(rank);
  const totalAbsorbed = mass - 1;  // organisms folded in (excludes the survivor)

  // Attributes — order matters for OpenSea grouping
  const attributes = [
    // Species first — the per-token "nickname" derived from the seed
    // (PHAGOPHILIA / STREPTONAX / GLIAARIA …). 1/8000 unique per token
    // so it acts as the human-readable identity inside the BIOM #N
    // wrapper.
    { trait_type: 'Species',      value: name },
    { trait_type: 'Tier',         value: tier },
    { trait_type: 'Rank',         value: rank, display_type: 'number' },
    { trait_type: 'Morphology',   value: _MORPH_LABEL[eff.morphology]    || eff.morphology },
    { trait_type: 'Palette',      value: _paletteLabelFor(eff.palette) },
    { trait_type: 'Cell count',   value: eff.cellCount, display_type: 'number' },
    { trait_type: 'Lifecycle',    value: _LIFECYCLE_LABEL[eff.lifecycle] || eff.lifecycle },
    { trait_type: 'Reserve',      value: _RESERVE_LABEL[eff.reserveGranule] || eff.reserveGranule },
  ];
  // Each organelle as its own boolean-ish trait so collectors can
  // filter "all bioms with flagellum" on OpenSea.
  for (const o of eff.organelles) {
    if (o === 'capsule') continue;  // every biom has one; not interesting
    attributes.push({ trait_type: 'Organelle', value: _ORG_LABEL[o] || o });
  }
  // Anomalies — rare, important to surface
  if (eff.phageAttached) attributes.push({ trait_type: 'Anomaly', value: 'Phage attached' });
  if (eff.endosymbiont)  attributes.push({ trait_type: 'Anomaly', value: 'Endosymbiont' });
  if (eff.biofilmHalo)   attributes.push({ trait_type: 'Anomaly', value: 'Biofilm halo' });
  if (totalAbsorbed > 0) {
    attributes.push({ trait_type: 'Burns absorbed', value: totalAbsorbed, display_type: 'number' });
  }

  // === Encode mutations in the animation_url ===
  // preview.html accepts force* URL params to override seed-defaults
  // (forceStain, forceOrganelles, forcePhage, etc.). For a mutated
  // token, we encode the current state into the URL so OpenSea's live
  // preview iframe shows the post-burn / post-conjugate biom, not the
  // original seed render.
  const animParams = new URLSearchParams({ seed: String(tokenId) });
  if (mutations.palette) animParams.set('forceStain', mutations.palette);
  if (Array.isArray(mutations.organelles) && mutations.organelles.length) {
    animParams.set('forceOrganelles', mutations.organelles.join(','));
  }
  const anomList = Array.isArray(mutations.anomalies) ? mutations.anomalies : [];
  if (anomList.includes('phageAttached')) animParams.set('forcePhage',   '1');
  if (anomList.includes('endosymbiont'))  animParams.set('forceEndo',    '1');
  if (anomList.includes('biofilmHalo'))   animParams.set('forceBiofilm', '1');

  // Image URL with cache-bust version. After renderTokenMaster()
  // overwrites the R2 master, imageVersion is bumped → URL changes →
  // CDN treats as fresh asset → users see new master.
  const imageUrl = `https://pngs.thebioms.com/preview/${padded}.webp?v=${imageVersion}`;

  return {
    // "Biom #N" — no padding, max ID is 8000 so digit count tops out at
    // 4 chars and reads cleaner than "Biom #00001". Genus name (the old
    // "PHAGOPHILIA" style identifier) is preserved as a Species trait so
    // the character isn't lost — it just doesn't crowd the title.
    // The capitalised form is canonical brand voice: "Biom" / "Bioms",
    // never all-caps. The all-caps version leaked into pre-launch
    // metadata; once OpenSea has indexed a token name it stays cached
    // for the life of the listing, so this name has to be right before
    // first mint.
    name: `Biom #${tokenId}`,
    description: 'A living microbe from the Bioms collection — procedural microbial organisms on Ethereum. They share traits, burn each other, and evolve. The survivors carry everything forward. thebioms.com',
    // Static image — for mutated tokens this URL gets re-uploaded by
    // renderTokenMaster() after each burn/conjugate (Browser Rendering
    // pipeline). The ?v=N query bumps each regen → CDN cache busts →
    // OpenSea grid thumbnails refresh.
    image: imageUrl,
    image_url: imageUrl,  // OpenSea legacy field
    animation_url: `https://thebioms.com/preview.html?${animParams.toString()}`,
    external_url: `https://thebioms.com/lab?seed=${tokenId}`,
    attributes,
    // OpenSea-specific: this lets the collection page show creator + royalty info
    background_color: 'ECE9E0',  // matches site cream paper
  };
}

async function handleMetadata(env, tokenIdStr, origin) {
  const tokenId = parseInt(tokenIdStr, 10);
  const maxId = maxTokenId(env);
  if (!Number.isFinite(tokenId) || tokenId < 0 || tokenId > maxId) {
    return error('bad_token_id', 400, origin);
  }
  const meta = await buildMetadata(env, tokenId);
  return json(meta, {
    headers: {
      // Marketplaces poll metadata. Short cache so post-mutation
      // changes propagate quickly without hammering the Worker.
      'Cache-Control': 'public, max-age=300, s-maxage=300',
      'Access-Control-Allow-Origin': '*',  // marketplaces fetch server-side
    },
  }, origin);
}

// === Direct PNG download endpoint ===
// GET /api/download/<tokenId> → proxies the R2 master PNG with
// Content-Disposition: attachment so browsers ALWAYS save the file
// instead of opening it in a tab. Filename embeds the tokenId for
// clean defaults. Cache aggressively at the edge — masters never
// change for a given token.
// ============================================================
// BROWSER RENDERING PIPELINE — regen master PNG on mutation
// ============================================================
// After a successful burn/conjugate, the token's R2 master PNG is now
// out of date (it shows the base/pre-mutation render). We use
// Cloudflare Browser Rendering API to spawn a headless Chromium,
// navigate to preview.html with the new state encoded as force-*
// URL params, take a 3000×3000 screenshot, and overwrite the R2 key.
//
// Versioning: imageVersion in D1 is bumped on each successful regen.
// Metadata `image` field includes `?v=N` query → CDN cache treats
// each version as a fresh asset → OpenSea grid refreshes.
//
// Fire-and-forget: called from handleConjugate/handleBurn via
// ctx.waitUntil() so the response to the user returns immediately;
// the screenshot happens in the background (~2-5s). Worst case the
// user sees the old master for a few seconds before OpenSea
// re-polls metadata.
// ============================================================

// Build the preview.html URL for a given mutation state. Mirrors the
// animation_url construction in buildMetadata so the screenshot
// matches what marketplaces show as the live preview.
function _previewUrlForTokenState(tokenId, mutations) {
  const params = new URLSearchParams({ seed: String(tokenId), static: '1' });
  if (mutations.palette) params.set('forceStain', mutations.palette);
  if (Array.isArray(mutations.organelles) && mutations.organelles.length) {
    params.set('forceOrganelles', mutations.organelles.join(','));
  }
  const anomList = Array.isArray(mutations.anomalies) ? mutations.anomalies : [];
  if (anomList.includes('phageAttached')) params.set('forcePhage',   '1');
  if (anomList.includes('endosymbiont'))  params.set('forceEndo',    '1');
  if (anomList.includes('biofilmHalo'))   params.set('forceBiofilm', '1');
  return `https://thebioms.com/preview.html?${params.toString()}`;
}

// Re-render a token's master PNG and upload to R2.
// Returns { ok, version } on success, { ok: false, reason } on failure.
// Safe to call concurrently for different tokenIds (different R2 keys).
async function renderTokenMaster(env, tokenId) {
  if (!env.BROWSER) {
    return { ok: false, reason: 'no_browser_binding' };
  }
  if (!env.PNGS) {
    return { ok: false, reason: 'no_r2_binding' };
  }
  const padded = String(tokenId).padStart(5, '0');
  let browser = null;
  try {
    const { mutations } = await loadTokenState(env, tokenId);
    const url = _previewUrlForTokenState(tokenId, mutations);
    browser = await puppeteer.launch(env.BROWSER);
    const page = await browser.newPage();
    await page.setViewport({ width: 3000, height: 3000, deviceScaleFactor: 1 });
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
    // preview.html sets window.__biomReady = true after first paint
    // (see preview.html). Wait up to 10s; engine usually ready in <1s.
    await page.waitForFunction(() => window.__biomReady === true, { timeout: 10000 });
    const buffer = await page.screenshot({ type: 'webp', quality: 90, omitBackground: false });

    // Upload to R2 — overwrites existing master. cache headers on the
    // R2 object itself are inherited from bucket config; we rely on
    // the ?v=N query in metadata for cache-busting at the CDN edge.
    await env.PNGS.put(`preview/${padded}.webp`, buffer, {
      httpMetadata: { contentType: 'image/webp' },
    });

    // Bump image_version so the metadata URL changes on next fetch
    // (token_state row is upserted to ensure the column exists).
    await env.DB.prepare(
      `INSERT INTO token_state (token_id, image_version, updated_at) VALUES (?, 2, ?)
       ON CONFLICT(token_id) DO UPDATE SET
         image_version = COALESCE(image_version, 1) + 1,
         updated_at = excluded.updated_at`
    ).bind(tokenId, Math.floor(Date.now() / 1000)).run();

    // Get the new version for the return value
    const row = await env.DB.prepare(
      'SELECT image_version FROM token_state WHERE token_id = ?'
    ).bind(tokenId).first();
    const newVersion = row?.image_version || 2;

    console.log(`[render] token ${tokenId} master regenerated, version=${newVersion}, ${buffer.byteLength} bytes`);
    return { ok: true, version: newVersion };
  } catch (e) {
    console.warn(`[render] token ${tokenId} failed:`, e?.message || String(e));
    return { ok: false, reason: 'render_failed', error: e?.message };
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

async function handleAdminRegen(req, env, tokenIdStr, origin) {
  // Token-gated. Same ADMIN_TOKEN as the other /api/admin/* routes.
  if (!env.ADMIN_TOKEN) return error('admin_token_not_set', 503, origin);
  const token = req.headers.get('x-admin-token') || '';
  if (!_constantTimeEquals(token, env.ADMIN_TOKEN)) return error('unauthorized', 401, origin);
  const tokenId = parseInt(tokenIdStr, 10);
  const maxId = maxTokenId(env);
  if (!Number.isFinite(tokenId) || tokenId < 0 || tokenId > maxId) {
    return error('bad_token_id', 400, origin);
  }
  const result = await renderTokenMaster(env, tokenId);
  if (!result.ok) {
    return error(result.reason || 'render_failed', 502, origin);
  }
  // Best-effort OpenSea refresh — the new image URL has bumped ?v=N
  if (env.CONTRACT_ADDRESS && openseaKey(env)) {
    try { await refreshOpenSeaMetadata(env, tokenId); } catch (_) {}
  }
  return json({ ok: true, tokenId, version: result.version }, {}, origin);
}

async function handleDownload(env, tokenIdStr, origin) {
  const tokenId = parseInt(tokenIdStr, 10);
  const maxId = maxTokenId(env);
  if (!Number.isFinite(tokenId) || tokenId < 0 || tokenId > maxId) {
    return error('bad_token_id', 400, origin);
  }
  const padded = String(tokenId).padStart(5, '0');
  const r2Url = `https://pngs.thebioms.com/preview/${padded}.webp`;
  try {
    const r = await fetch(r2Url, { cf: { cacheTtl: 31536000, cacheEverything: true } });
    if (!r.ok) return error('not_found', r.status, origin);
    const headers = new Headers();
    headers.set('Content-Type', 'image/webp');
    headers.set('Content-Disposition', `attachment; filename="BIOM-${tokenId}.webp"`);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    const cl = r.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);
    return new Response(r.body, { status: 200, headers });
  } catch (e) {
    return error('fetch_failed', 502, origin);
  }
}

// GET /api/video/<tokenId> → proxies the R2 master MP4 with
// Content-Disposition: attachment so the browser triggers a save
// dialog (same trick as handleDownload, just for video). Source MP4s
// are batch-rendered by scripts/make-videos.py and uploaded via
// scripts_upload_videos.sh — 15s 1080p H.264, ~1 MB each.
//
// TODO (post-launch): mutated tokens — once a burn happens the cached
// MP4 here is stale. Plan: add renderTokenVideo() next to
// renderTokenMaster() in this file, call it from the same
// ctx.waitUntil() chain after each burn. The Cloudflare Browser
// Rendering binding (env.BROWSER) already does Puppeteer; recording
// uses page.evaluate to drive a 15-second capture (or MediaRecorder
// inside the page itself, captured via page.video). Encoded via WASM
// ffmpeg or piped to Cloudflare Stream. Estimated cost: ~$0.04 per
// burn, well inside the burn margin. NOT implemented pre-launch —
// no bioms are mutated yet, the base-state cache covers 100% of
// cases on day one.
async function handleVideo(env, tokenIdStr, origin) {
  const tokenId = parseInt(tokenIdStr, 10);
  const maxId = maxTokenId(env);
  if (!Number.isFinite(tokenId) || tokenId < 0 || tokenId > maxId) {
    return error('bad_token_id', 400, origin);
  }
  const padded = String(tokenId).padStart(5, '0');
  const r2Url = `https://pngs.thebioms.com/video/${padded}.mp4`;
  try {
    const r = await fetch(r2Url, { cf: { cacheTtl: 31536000, cacheEverything: true } });
    if (!r.ok) return error('not_found', r.status, origin);
    const headers = new Headers();
    headers.set('Content-Type', 'video/mp4');
    headers.set('Content-Disposition', `attachment; filename="BIOM-${tokenId}.mp4"`);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', '*');
    const cl = r.headers.get('content-length');
    if (cl) headers.set('Content-Length', cl);
    return new Response(r.body, { status: 200, headers });
  } catch (e) {
    return error('fetch_failed', 502, origin);
  }
}

async function handleLog(env, url, origin) {
  const params = url.searchParams;
  const donor = params.get('donor');
  const recipient = params.get('recipient');
  const limit = Math.min(100, parseInt(params.get('limit') || '20', 10));
  let query = 'SELECT ts, donor, recipient, trait, result FROM log';
  const conditions = [];
  const binds = [];
  if (donor !== null) { conditions.push('donor = ?'); binds.push(parseInt(donor, 10)); }
  if (recipient !== null) { conditions.push('recipient = ?'); binds.push(parseInt(recipient, 10)); }
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY ts DESC LIMIT ?';
  binds.push(limit);
  const { results } = await env.DB.prepare(query).bind(...binds).all();
  return json({ log: results || [] }, {}, origin);
}

// ============================================================
// WAITLIST — pre-mint signup
// Two endpoints:
//   POST /api/waitlist        — add a row {kind, value}
//   GET  /api/waitlist/count  — return total signup count
//
// Goal isn't to filter, just to count interest. Same address or
// email submitted twice is idempotent (unique constraint on value).
// Soft rate limit via ip_hash so a single client can't spam-add
// thousands of fake addresses.
// ============================================================
// Frontend lowercases before sending, but stay defensive — accept
// either case for the address (typed by hand) and case-insensitive
// for ENS names. Worker still stores the lowercased canonical form.
const RE_ETH_ADDR = /^0x[a-fA-F0-9]{40}$/;
// ENS names — at least one label, ending in .eth. Allows subdomains
// like vitalik.base.eth, hot.box.eth, etc. ASCII-only for now; unicode
// names exist but are rare and would need stricter normalization to
// guard against homoglyph spoofing.
const RE_ENS_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/;

// ENS resolver — two-path:
//
//   1. If ALCHEMY_KEY is set, resolve via viem + Alchemy mainnet
//      (private quota, fast, supports CCIP-read for wildcard
//      resolvers like .base.eth / .uni.eth).
//   2. Otherwise, fall back to ENSIdeas' public HTTP API. Simple
//      GET with JSON response, no on-chain Universal-Resolver
//      contract calls needed (the public Cloudflare RPC doesn't
//      support CCIP-read so plain viem on it fails for many real
//      names — including basenames and some primary records).
//
// Either way the return is a lowercased 0x address or null. We
// normalize the input first so the lookup is canonical.
async function resolveEnsName(env, name) {
  let normalized;
  try { normalized = normalize(name); }
  catch (_) { return null; }

  if (env.ALCHEMY_KEY) {
    try {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(`https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`, {
          timeout: EXTERNAL_FETCH_TIMEOUT_MS,
          retryCount: 1,
        }),
      });
      const addr = await client.getEnsAddress({ name: normalized });
      if (addr) return addr.toLowerCase();
    } catch (e) {
      console.warn('ENS resolve via Alchemy failed, falling back:', name, e?.shortMessage || e?.message);
    }
  }

  try {
    const r = await fetchWithTimeout(
      `https://api.ensideas.com/ens/resolve/${encodeURIComponent(normalized)}`
    );
    if (!r.ok) return null;
    const data = await r.json().catch(() => null);
    if (data && typeof data.address === 'string' && data.address.startsWith('0x')) {
      return data.address.toLowerCase();
    }
    return null;
  } catch (e) {
    console.warn('ENS resolve via ENSIdeas failed:', name, e?.message || e);
    return null;
  }
}

async function _sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Waitlist hard close: 2 hours before the WL mint (mint = 2026-06-08 19:00
// GMT+7). After this, NEW sign-ups are rejected so the snapshot can be frozen,
// processed, and the OpenSea allowlist set up in time. Existing rows are
// untouched; reads (count / list / check) keep working so the owner can pull
// the snapshot after close.
const WAITLIST_CLOSE_MS = new Date('2026-06-08T17:00:00+07:00').getTime();

async function handleWaitlistAdd(req, env, origin) {
  // Stricter Origin check on this endpoint than the global one in fetch().
  // The global guard allows missing Origin to support server-to-server
  // calls and webhooks. The waitlist is a public form that has no real
  // server-to-server caller — every legit POST comes from a browser
  // submitting reserve.html. Requiring Origin closes a curl-from-botnet
  // attack vector that would otherwise hit D1 + Alchemy quotas freely.
  // The global guard already 403s on a present-but-wrong Origin, so this
  // only catches the present-but-empty case (curl with no Origin set).
  const reqOrigin = req.headers.get('Origin') || '';
  if (!reqOrigin) return error('origin_required', 403, origin);

  // Submissions close 2h before mint (see WAITLIST_CLOSE_MS). This blocks only
  // NEW entries so the snapshot can be frozen on time — existing rows stay.
  if (Date.now() >= WAITLIST_CLOSE_MS) return error('waitlist_closed', 403, origin);

  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }

  // Address-only intake. Email collection was dropped — the snapshot
  // pipeline only needs wallets. `kind` is still accepted as 'address'
  // for backwards-compat with the previous frontend, but anything else
  // bounces.
  let value = body && body.value;
  if (typeof value !== 'string') return error('bad_value', 400, origin);
  // Hard length cap BEFORE regex / ENS resolution. A multi-MB string
  // would otherwise feed into the ENS regex (which is fast but linear)
  // and then to ENS resolution. 256 chars is plenty for any real
  // wallet address or ENS name.
  if (value.length > 256) return error('value_too_long', 400, origin);
  value = value.trim().toLowerCase();
  if (body && body.kind && body.kind !== 'address') {
    return error('bad_kind', 400, origin);
  }
  if (RE_ETH_ADDR.test(value)) {
    // Already a 0x address — keep as-is.
  } else if (RE_ENS_NAME.test(value)) {
    // ENS gets resolved server-side and stored as the resolved 0x —
    // the snapshot script then sees a uniform list ready for the
    // allowlist Merkle tree.
    const resolved = await resolveEnsName(env, value);
    if (!resolved) {
      return error('ens_unresolvable', 400, origin);
    }
    value = resolved;
  } else {
    return error('bad_address', 400, origin);
  }
  const kind = 'address';

  // Soft rate-limit: at most 30 signups per IP per hour. Cheap counter
  // against the existing rows by ip_hash. Reasonable for a sign-up form.
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
  const salt = env.WAITLIST_IP_SALT || 'bioms-waitlist-v1';
  const ipHash = await _sha256Hex(ip + ':' + salt);
  const nowMs = Date.now();
  const hourAgo = nowMs - 3_600_000;
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM waitlist WHERE ip_hash = ? AND ts > ?'
  ).bind(ipHash, hourAgo).first();
  if (recent && recent.n >= 30) {
    return error('rate_limited', 429, origin);
  }

  // Look up first — if the value is already in, we report it back so
  // the UI can show "you were already on the list (since X)". This
  // is OK to disclose because the caller already knows their own
  // address; they just hit submit and got a friendlier confirmation.
  const existing = await env.DB.prepare(
    'SELECT ts FROM waitlist WHERE value = ?'
  ).bind(value).first();

  if (existing) {
    return json({ ok: true, already_in_list: true, signed_up_ms: existing.ts }, {}, origin);
  }

  await env.DB.prepare(
    'INSERT OR IGNORE INTO waitlist (kind, value, ts, ip_hash) VALUES (?, ?, ?, ?)'
  ).bind(kind, value, nowMs, ipHash).run();

  return json({ ok: true, already_in_list: false, signed_up_ms: nowMs }, {}, origin);
}

// GET /api/waitlist/check?address=0x... | name.eth
// Returns whether an address (or ENS-resolved address) is in the list.
// Validates and resolves ENS the same way the POST does. Useful for the
// "check another address" sub-form on /reserve — anyone can verify
// whether a specific address is on the waitlist without re-signing them up.
async function handleWaitlistCheck(req, env, origin) {
  const url = new URL(req.url);
  let q = (url.searchParams.get('address') || '').trim().toLowerCase();
  if (!q) return error('bad_value', 400, origin);
  // Same length cap as the POST endpoint — prevents huge ENS regex
  // probes from a single-IP DOS attempt.
  if (q.length > 256) return error('value_too_long', 400, origin);

  let resolved = null;
  if (RE_ETH_ADDR.test(q)) {
    resolved = q;
  } else if (RE_ENS_NAME.test(q)) {
    resolved = await resolveEnsName(env, q);
    if (!resolved) {
      return json({ ok: true, in_list: false, resolved_address: null, ens_unresolvable: true }, {}, origin);
    }
  } else {
    return error('bad_address', 400, origin);
  }

  const row = await env.DB.prepare(
    'SELECT ts FROM waitlist WHERE value = ?'
  ).bind(resolved).first();

  return json({
    ok: true,
    in_list: !!row,
    signed_up_ms: row ? row.ts : null,
    resolved_address: resolved,
  }, {}, origin);
}

// POST /api/admin/waitlist/delete  body: { token, value }
//
// Owner-only delete of a single waitlist entry. Same token-gate as
// the dump endpoint. value must match exactly (already-lowercased
// 0x form in our DB, so input is normalized).
async function handleAdminDelete(req, env, origin) {
  if (!env.ADMIN_TOKEN) return error('admin_token_not_set', 503, origin);
  // Token from the x-admin-token HEADER (not the body) — consistent with
  // every other admin route, keeps it out of any body-logging path.
  const token = req.headers.get('x-admin-token') || '';
  if (!_constantTimeEquals(token, env.ADMIN_TOKEN)) return error('forbidden', 403, origin);
  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }
  const { value } = body || {};
  if (typeof value !== 'string' || !value.trim()) return error('bad_value', 400, origin);
  if (value.length > 256) return error('value_too_long', 400, origin);
  const v = value.trim().toLowerCase();
  const result = await env.DB.prepare(
    'DELETE FROM waitlist WHERE value = ?'
  ).bind(v).run();
  return json({
    ok: true,
    deleted: result.meta?.changes ?? 0,
    value: v,
  }, { headers: { 'cache-control': 'no-store' } }, origin);
}

// GET /api/admin/waitlist?token=<secret>&format=json|csv
//
// Owner-only dump of the waitlist. Secret-token gate (compared with
// constant-time crypto.subtle.timingSafeEqual would be cleaner, but
// for Workers + a single secret the string === check is adequate
// when combined with HTTPS — the token never appears in URL logs
// because we only ever bookmark this in the browser, not share it).
//
// Set the secret with:
//   echo "$(openssl rand -hex 32)" | npx wrangler secret put ADMIN_TOKEN
//
// Then bookmark:
//   https://api.thebioms.com/api/admin/waitlist?token=<that-value>
//
// Add &format=csv to download as spreadsheet-friendly CSV.
async function handleAdminWaitlist(req, env, origin) {
  if (!env.ADMIN_TOKEN) return error('admin_token_not_set', 503, origin);
  if (req.method !== 'GET') return error('method_not_allowed', 405, origin);
  // Token must come via x-admin-token header — NOT query string.
  // URL query params land in Cloudflare access logs AND browser history;
  // pulling a download was effectively leaking the token to both. Header
  // form is the canonical pattern used by /api/admin/regen too.
  const token = req.headers.get('x-admin-token') || '';
  if (!_constantTimeEquals(token, env.ADMIN_TOKEN)) return error('forbidden', 403, origin);
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const rawLimit = parseInt(url.searchParams.get('limit') || '1000000', 10);
  // parseInt('abc') is NaN — Math.min(MAX, NaN) === NaN, ".bind(NaN)"
  // would land as NULL in D1 and LIMIT NULL means "no limit". Clamp.
  // Default + ceiling raised 100k -> 1M: the bot flood blew past 100k and a
  // truncated export silently drops the OLDEST signups (ORDER BY ts DESC).
  // The waitlist closes server-side at ~200k, so the in-memory CSV build
  // below stays well within Worker memory; if the list ever approaches the
  // 1M ceiling, switch the CSV path to a streamed Response.
  const MAX_EXPORT = 1000000;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(MAX_EXPORT, rawLimit) : MAX_EXPORT;

  const { results } = await env.DB.prepare(
    'SELECT id, kind, value, ts FROM waitlist ORDER BY ts DESC LIMIT ?'
  ).bind(limit).all();
  const rows = results || [];

  if (format === 'csv') {
    const header = 'id,kind,value,signed_up_ms,signed_up_iso\n';
    const body = rows.map(r => {
      const iso = new Date(r.ts).toISOString();
      const value = String(r.value || '').replace(/"/g, '""');
      return `${r.id},"${r.kind}","${value}",${r.ts},${iso}`;
    }).join('\n');
    return new Response(header + body, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="bioms-waitlist-${Date.now()}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  return json({
    ok: true,
    total: rows.length,
    waitlist: rows.map(r => ({
      id: r.id,
      kind: r.kind,
      value: r.value,
      signedUpMs: r.ts,
      signedUpIso: new Date(r.ts).toISOString(),
    })),
  }, { headers: { 'cache-control': 'no-store' } }, origin);
}

// Public list of all signups — wallet addresses + timestamps.
// Open by design: addresses are on-chain anyway, transparency
// matches the project identity, and a visible list creates social
// proof (potential collectors see who else is in).
//
// Returns ONLY value + signedUpMs — no ip_hash, no kind enum,
// no internal ids. Cached at edge for 60s so a viral spike doesn't
// hit D1 on every refresh.
async function handleWaitlistList(env, origin) {
  // High cap so the public /list page + its CSV reflect the FULL waitlist,
  // not a truncated 10k. Edge-cached 60s, so the larger payload is built at
  // most once per minute. Bump again if signups ever approach this.
  const limit = 100000;
  const { results } = await env.DB.prepare(
    'SELECT value, ts FROM waitlist ORDER BY ts DESC LIMIT ?'
  ).bind(limit).all();
  const rows = results || [];
  return json({
    ok: true,
    total: rows.length,
    list: rows.map(r => ({
      value: r.value,
      signedUpMs: r.ts,
    })),
  }, {
    headers: { 'cache-control': 'public, max-age=60, s-maxage=60' },
  }, origin);
}

async function handleWaitlistCount(env, origin) {
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM waitlist').first();
  const count = row ? row.n : 0;
  return json({ count }, {
    headers: {
      'Cache-Control': 'public, max-age=60, s-maxage=60',
    },
  }, origin);
}

// ============================================================
// PARTNERS — community whitelist-allocation applications
//
// Fully isolated from the individual waitlist: writes to the
// `partners` table, NEVER `waitlist`. Member wallet lists are stored
// as raw text and validated on-chain later during manual triage, so
// this endpoint makes zero Alchemy calls and can't be abused to drain
// quota. Owner reads submissions via the admin dump below.
//   POST /api/partner          — submit an application
//   GET  /api/admin/partners   — owner-only dump (x-admin-token header)
// ============================================================
async function handlePartnerAdd(req, env, origin) {
  // Same Origin requirement as the waitlist: every legit POST comes from
  // a browser submitting partners.html, so requiring Origin closes the
  // curl-from-botnet vector that would otherwise hit D1 freely.
  const reqOrigin = req.headers.get('Origin') || '';
  if (!reqOrigin) return error('origin_required', 403, origin);

  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }
  if (!body || typeof body !== 'object') return error('invalid_json', 400, origin);

  // Trim + length-cap each field. Returns null when over the cap so we
  // can bounce it before touching D1.
  const str = (v, max) => {
    if (typeof v !== 'string') return '';
    const t = v.trim();
    return t.length > max ? null : t;
  };
  const community = str(body.community, 120);
  const about     = str(body.about, 2000);
  const twitter   = str(body.twitter, 200);
  const audience  = str(body.audience, 120);
  const discord   = str(body.discord, 200);
  const links     = str(body.links, 400);
  const contact   = str(body.contact, 200);
  const members   = str(body.members, 12000);
  for (const v of [community, about, twitter, audience, discord, links, contact, members]) {
    if (v === null) return error('value_too_long', 400, origin);
  }
  // Minimal intake: only the community X handle and a contact are required.
  // Everything else (wallets/contract, notes, size) is optional.
  if (!twitter || !contact) {
    return error('missing_fields', 400, origin);
  }
  // Requested spots — digits only, clamped.
  let spots = parseInt(String(body.spots == null ? '' : body.spots).replace(/[^0-9]/g, ''), 10);
  if (!Number.isFinite(spots)) spots = 0;
  spots = Math.max(0, Math.min(1000000, spots));

  // Soft rate-limit: at most 8 applications per IP per hour.
  const ip = req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown';
  const salt = env.WAITLIST_IP_SALT || 'bioms-waitlist-v1';
  const ipHash = await _sha256Hex(ip + ':partner:' + salt);
  const nowMs = Date.now();
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM partners WHERE ip_hash = ? AND ts > ?'
  ).bind(ipHash, nowMs - 3_600_000).first();
  if (recent && recent.n >= 8) return error('rate_limited', 429, origin);

  await env.DB.prepare(
    `INSERT INTO partners
       (community, about, twitter, audience_size, discord, links, requested_spots, member_addrs, contact, status, ts, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).bind(community || twitter, about, twitter, audience, discord || null, links || null,
         spots, members || null, contact, nowMs, ipHash).run();

  return json({ ok: true }, { headers: { 'cache-control': 'no-store' } }, origin);
}

// GET /api/admin/partners?token via x-admin-token header, ?format=json|csv
//
// Owner-only dump of community applications. Same token gate as
// /api/admin/waitlist. Bookmark with the header set (e.g. via the admin
// panel) — never put the token in the query string.
async function handleAdminPartners(req, env, origin) {
  if (!env.ADMIN_TOKEN) return error('admin_token_not_set', 503, origin);
  if (req.method !== 'GET') return error('method_not_allowed', 405, origin);
  const token = req.headers.get('x-admin-token') || '';
  if (!_constantTimeEquals(token, env.ADMIN_TOKEN)) return error('forbidden', 403, origin);
  const url = new URL(req.url);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const rawLimit = parseInt(url.searchParams.get('limit') || '2000', 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(10000, rawLimit) : 2000;

  const { results } = await env.DB.prepare(
    `SELECT id, community, about, twitter, audience_size, discord, links,
            requested_spots, member_addrs, contact, status, ts
       FROM partners ORDER BY ts DESC LIMIT ?`
  ).bind(limit).all();
  const rows = results || [];

  if (format === 'csv') {
    const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const header = 'id,community,twitter,audience_size,discord,links,requested_spots,contact,status,submitted_iso,about,member_addrs\n';
    const lines = rows.map(r => [
      r.id, q(r.community), q(r.twitter), q(r.audience_size), q(r.discord), q(r.links),
      r.requested_spots, q(r.contact), q(r.status), q(new Date(r.ts).toISOString()),
      q(r.about), q(r.member_addrs),
    ].join(','));
    return new Response(header + lines.join('\n'), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="bioms-partners-${Date.now()}.csv"`,
        'cache-control': 'no-store',
      },
    });
  }

  return json({
    ok: true,
    total: rows.length,
    partners: rows.map(r => ({
      id: r.id, community: r.community, about: r.about, twitter: r.twitter,
      audienceSize: r.audience_size, discord: r.discord, links: r.links,
      requestedSpots: r.requested_spots, memberAddrs: r.member_addrs,
      contact: r.contact, status: r.status,
      submittedMs: r.ts, submittedIso: new Date(r.ts).toISOString(),
    })),
  }, { headers: { 'cache-control': 'no-store' } }, origin);
}

// ----- Main dispatcher -----
//
// CRITICAL: the third parameter is `ctx`. handleConjugate + handleBurn use
// `ctx.waitUntil(...)` to fire the Browser Rendering regen job in the
// background after returning the response to the user. Forgetting the
// parameter doesn't break those handlers (they guard with
// `if (ctx && typeof ctx.waitUntil === 'function')`) BUT the dispatcher
// below passes `ctx` as an argument to both — referencing an undeclared
// `ctx` throws ReferenceError, the outer catch converts to 500
// `internal_error`, and every real wallet-mode burn or conjugate fails.
// Caught by a pre-drop audit before any real signer hit the path.
export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    const url = new URL(req.url);

    // ----- Body size + CSRF guard on state-changing POSTs -----
    // CF Workers buffer up to ~100MB before req.json() rejects, plenty
    // of room for a CPU-exhaustion attack via a huge JSON.parse. 32KB
    // is generous (signatures + tokenId + nonce ≈ 1KB).
    // Cross-site POSTs that ship the right Content-Type bypass CORS
    // preflight; reject early if Origin is set and isn't allowed.
    if (req.method === 'POST') {
      const cl = parseInt(req.headers.get('Content-Length') || '0', 10);
      if (Number.isFinite(cl) && cl > 32 * 1024) {
        return error('body_too_large', 413, origin);
      }
      const reqOrigin = req.headers.get('Origin') || '';
      // Allow missing Origin (curl, server-to-server, webhooks). Reject
      // mismatched Origin to block cross-site POSTs from arbitrary
      // websites — CORS response-header allowlist doesn't help here
      // because the side effect happens before the browser checks it.
      if (reqOrigin && !ALLOWED_ORIGINS.includes(reqOrigin)) {
        return error('forbidden_origin', 403, origin);
      }
    }
    const path = url.pathname;

    try {
      if (path === '/api/health') {
        // Strict address validation — placeholder strings like
        // "0xYourContractAddress" used to pass the old truthy+zero check
        // and flip features.walletBurn=true in the frontend even though
        // no real contract existed yet. Now we require a 40-hex string
        // AND reject the zero address.
        const isHex40 = /^0x[a-fA-F0-9]{40}$/.test(env.CONTRACT_ADDRESS || '');
        const deployed = isHex40 && env.CONTRACT_ADDRESS.toLowerCase() !== '0x0000000000000000000000000000000000000000';
        // Probe D1 with a cheap SELECT — surfaces a missing or wrong
        // database_id at health-check time (used by uptime monitors)
        // instead of waiting for the first user conjugation to 500.
        let dbOk = false;
        let dbError = null;
        try {
          const row = await env.DB.prepare('SELECT 1 AS ok').first();
          dbOk = row && row.ok === 1;
        } catch (e) {
          dbError = e?.message || String(e);
        }
        // Features tell the client what's wired up. burnEnabled is the
        // wallet-mode hard-burn gate: needs both contract + Alchemy.
        // Frontend uses this to flip burn UI between "Demo only" and
        // "wallet burn is live."
        const burnEnabled = deployed && !!env.ALCHEMY_KEY;
        // Optional ?probe=1 — ping Alchemy + OpenSea with trivial GETs
        // so an operator can verify both keys are alive end-to-end
        // without triggering a real burn or paying the OpenSea refresh
        // cost. Each probe times out fast and returns the upstream
        // status code, never the key itself.
        let probe = undefined;
        if (url.searchParams.get('probe') === '1') {
          probe = { alchemy: null, opensea: null };
          // Alchemy probe — JSON-RPC eth_chainId is the cheapest call,
          // no NFT-API quota usage.
          if (env.ALCHEMY_KEY) {
            try {
              const r = await fetchWithTimeout(
                `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`,
                { method: 'POST', headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId' }) }
              );
              probe.alchemy = { ok: r.ok, status: r.status };
            } catch (e) {
              probe.alchemy = { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_failed') };
            }
          } else {
            probe.alchemy = { ok: false, error: 'no_key' };
          }
          // OpenSea probe — GET the collection-by-contract endpoint
          // (read-only, no side-effects). 401/403 means key is wrong.
          const osKey = openseaKey(env);
          if (osKey && deployed) {
            const chain = env.CHAIN_ID === '1' ? 'ethereum' : 'sepolia';
            try {
              const r = await fetchWithTimeout(
                `https://api.opensea.io/api/v2/chain/${chain}/contract/${env.CONTRACT_ADDRESS}`,
                { headers: { 'X-API-KEY': osKey, 'accept': 'application/json' } }
              );
              probe.opensea = { ok: r.ok, status: r.status };
            } catch (e) {
              probe.opensea = { ok: false, error: e?.name === 'AbortError' ? 'timeout' : (e?.message || 'fetch_failed') };
            }
          } else if (!osKey) {
            probe.opensea = { ok: false, error: 'no_key' };
          } else {
            probe.opensea = { ok: false, error: 'no_contract' };
          }
        }
        return json({
          ok: dbOk,
          db: { ok: dbOk, error: dbError },
          contractDeployed: deployed,
          contractAddress: deployed ? env.CONTRACT_ADDRESS : null,
          chainId: parseInt(env.CHAIN_ID || '1', 10),
          maxTokenId: maxTokenId(env),
          cooldownSeconds: parseInt(env.COOLDOWN_SECONDS || '2592000', 10),
          rejectionRate: parseFloat(env.REJECTION_RATE || '0.15'),
          conjugateRatePerMin: parseInt(env.CONJUGATE_RATE_PER_MIN || '5', 10),
          features: {
            walletBurn: burnEnabled,
            walletCrossbreed: deployed,
          },
          ...(probe ? { probe } : {}),
        }, { status: dbOk ? 200 : 503 }, origin);
      }

      if (path.startsWith('/api/owned/')) {
        const addr = path.slice('/api/owned/'.length);
        return await handleOwned(env, addr, origin, url);
      }
      if (path.startsWith('/api/state-batch')) {
        return await handleStateBatch(env, url.searchParams.get('tokens'), origin);
      }
      if (path.startsWith('/api/state/')) {
        const id = path.slice('/api/state/'.length);
        return await handleState(env, id, origin);
      }
      if (path.startsWith('/api/metadata/')) {
        // OpenSea-compatible JSON for each tokenId.
        // Contract baseURI should be: https://api.thebioms.com/api/metadata/
        const id = path.slice('/api/metadata/'.length);
        return await handleMetadata(env, id, origin);
      }
      if (path.startsWith('/api/download/')) {
        // Direct PNG download with Content-Disposition: attachment.
        // Marketplaces / OpenSea can't reliably trigger a save on
        // images they proxy through their CDN — this gives users an
        // unambiguous download URL that always saves the file.
        const id = path.slice('/api/download/'.length);
        return await handleDownload(env, id, origin);
      }
      if (path.startsWith('/api/video/')) {
        // Same shape as /api/download/, but serves the pre-rendered
        // 15s MP4 loop of the biom's live breathing animation. See
        // handleVideo() for the post-launch mutated-token TODO.
        const id = path.slice('/api/video/'.length);
        return await handleVideo(env, id, origin);
      }
      if (path === '/api/conjugate' && req.method === 'POST') {
        // Crossbreed/conjugate was removed from the product (the Lab is
        // burn-only). The handler is preserved for rollback, but the route
        // is disabled so it can't mutate token metadata without an on-chain
        // burn — that would bypass the burn economy (free, gas-less
        // mutation). Re-enable by restoring the call below.
        return error('gone', 410, origin);
        // return await handleConjugate(req, env, ctx, origin);
      }
      if (path === '/api/burn' && req.method === 'POST') {
        return await handleBurn(req, env, ctx, origin);
      }
      if (path.startsWith('/api/admin/regen/') && req.method === 'POST') {
        // POST /api/admin/regen/<tokenId>   x-admin-token: <secret>
        // Manually trigger renderTokenMaster for a single token.
        // Useful during testing AND as a recovery path if a ctx.waitUntil
        // render fails silently.
        const id = path.slice('/api/admin/regen/'.length);
        return await handleAdminRegen(req, env, id, origin);
      }
      if (path === '/api/log') {
        // The log exposes the full burn history (donor/recipient/trait/
        // signer). Not used by the frontend; gate behind the admin token.
        const gate = _adminGate(req, env, origin);
        if (gate) return gate;
        return await handleLog(env, url, origin);
      }
      if (path === '/api/waitlist/list') {
        return await handleWaitlistList(env, origin);
      }
      if (path === '/api/waitlist/count') {
        return await handleWaitlistCount(env, origin);
      }
      if (path === '/api/waitlist/check') {
        return await handleWaitlistCheck(req, env, origin);
      }
      if (path === '/api/admin/waitlist') {
        return await handleAdminWaitlist(req, env, origin);
      }
      if (path === '/api/admin/waitlist/delete' && req.method === 'POST') {
        return await handleAdminDelete(req, env, origin);
      }
      if (path === '/api/waitlist' && req.method === 'POST') {
        return await handleWaitlistAdd(req, env, origin);
      }
      if (path === '/api/partner' && req.method === 'POST') {
        return await handlePartnerAdd(req, env, origin);
      }
      if (path === '/api/admin/partners') {
        return await handleAdminPartners(req, env, origin);
      }

      return error('not_found', 404, origin);
    } catch (e) {
      console.error('Worker exception:', e?.stack || e);
      return error('internal_error', 500, origin);
    }
  },
};
