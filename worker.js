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

// ----- CORS / utility -----
const ALLOWED_ORIGINS = [
  'https://thebioms.com',
  'https://www.thebioms.com',
  'http://localhost:8000',
  'http://localhost:8787',
];
function corsHeaders(origin) {
  const ok = ALLOWED_ORIGINS.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? origin : 'https://thebioms.com',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
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
const DEFAULT_MAX_TOKEN_ID = 2999;  // 0..2999 = 3000 tokens
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
  ['gramPositive', 20], ['gramNegative', 16], ['fluorescent', 14], ['methylene', 12],
  ['darkfield', 8], ['acid_fast', 6], ['giemsa', 5], ['iridescent_aurora', 7],
  ['ghost', 5], ['safranin', 3], ['india_ink', 3], ['gram_variable', 1],
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
  // Mutations row
  const m = await env.DB.prepare(
    'SELECT received_palette, received_organelles, received_anomalies FROM token_state WHERE token_id = ?'
  ).bind(tokenId).first();

  const mutations = {
    palette: m?.received_palette || null,
    organelles: m?.received_organelles ? JSON.parse(m.received_organelles) : [],
    anomalies: m?.received_anomalies ? JSON.parse(m.received_anomalies) : [],
  };

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

  return { mutations, depletions };
}

// ----- Alchemy ownership -----
// viem's http() transport accepts a `timeout` (ms) — when the underlying
// fetch exceeds it, the call rejects rather than waiting for CF's 30s cap.
async function ownerOf(env, tokenId) {
  if (!env.CONTRACT_ADDRESS || env.CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return null; // pre-mint
  }
  const client = createPublicClient({
    chain: mainnet,
    transport: http(`https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`, {
      timeout: EXTERNAL_FETCH_TIMEOUT_MS,
      retryCount: 1,
    }),
  });
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

async function listOwned(env, address) {
  if (!env.CONTRACT_ADDRESS || env.CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return { tokens: [], contractDeployed: false };
  }
  const url = `https://eth-mainnet.g.alchemy.com/nft/v3/${env.ALCHEMY_KEY}/getNFTsForOwner` +
    `?owner=${address}&contractAddresses[]=${env.CONTRACT_ADDRESS}&withMetadata=false&pageSize=100`;
  try {
    const r = await fetchWithTimeout(url);
    if (!r.ok) {
      console.warn('listOwned Alchemy non-OK:', address, r.status);
      return { tokens: [], contractDeployed: true, error: 'alchemy_error' };
    }
    const data = await r.json();
    const tokens = (data.ownedNfts || []).map(n => parseInt(n.tokenId, 10)).filter(n => Number.isFinite(n));
    return { tokens, contractDeployed: true };
  } catch (e) {
    const reason = e?.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    console.warn('listOwned exception:', address, reason, e?.message || e);
    return { tokens: [], contractDeployed: true, error: reason };
  }
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
async function handleConjugate(req, env, origin) {
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
  const rejectionRate = parseFloat(env.REJECTION_RATE || '0.15');
  const { roll, hex: rollHex } = await verifiableRoll(signature, nonce, donorId, recipientId);
  const rejected = roll < rejectionRate;
  const ts = Date.now();
  const tsSec = Math.floor(ts / 1000);
  const cooldownSec = parseInt(env.COOLDOWN_SECONDS || '2592000', 10); // 30 days default

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
  if (!env.OPENSEA_API_KEY || !env.CONTRACT_ADDRESS) return;
  const chain = env.CHAIN_ID === '1' ? 'ethereum' : 'sepolia';
  const ts = Date.now();
  const settled = await Promise.allSettled(tokenIds.map(id =>
    fetchWithTimeout(
      `https://api.opensea.io/api/v2/chain/${chain}/contract/${env.CONTRACT_ADDRESS}/nfts/${id}/refresh`,
      { method: 'POST', headers: { 'X-API-KEY': env.OPENSEA_API_KEY } },
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

// ----- Route handlers -----
async function handleOwned(env, address, origin) {
  if (!isAddress(address)) return error('bad_address', 400, origin);
  const result = await listOwned(env, address);
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
  const ids = (tokensParam || '').split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n >= 0 && n <= maxId).slice(0, 100);
  if (ids.length === 0) return json({ states: {} }, {}, origin);
  const entries = await Promise.all(ids.map(async id => [id, await loadTokenState(env, id)]));
  return json({ states: Object.fromEntries(entries) }, {
    headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' },
  }, origin);
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
const RE_ETH_ADDR = /^0x[a-fA-F0-9]{40}$/;
const RE_EMAIL_LOOSE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// ENS names — at least one label, ending in .eth. Allows subdomains
// like vitalik.base.eth, hot.box.eth, etc. ASCII-only for now; unicode
// names exist but are rare and would need stricter normalization to
// guard against homoglyph spoofing.
const RE_ENS_NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/;

// ENS resolver — uses a free public RPC so this works without the
// Alchemy key. Cloudflare's own eth gateway is rate-limited but
// generous enough for waitlist-rate writes (one per signup, ~once
// per minute at peak). Falls back to Alchemy if ALCHEMY_KEY is set
// (faster + no shared rate limit).
async function resolveEnsName(env, name) {
  let normalized;
  try { normalized = normalize(name); }
  catch (_) { return null; }
  const rpcUrl = env.ALCHEMY_KEY
    ? `https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`
    : 'https://cloudflare-eth.com';
  const client = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl, {
      timeout: EXTERNAL_FETCH_TIMEOUT_MS,
      retryCount: 1,
    }),
  });
  try {
    const addr = await client.getEnsAddress({ name: normalized });
    return addr ? addr.toLowerCase() : null;
  } catch (e) {
    console.warn('ENS resolve failed:', name, e?.shortMessage || e?.message || String(e));
    return null;
  }
}

async function _sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleWaitlistAdd(req, env, origin) {
  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }

  const kind = body && body.kind;
  let value = body && body.value;
  if (typeof value !== 'string') return error('bad_value', 400, origin);
  value = value.trim().toLowerCase();
  if (kind === 'address') {
    // Accept either a raw 0x address OR an ENS name. ENS gets
    // resolved server-side and stored as the resolved address —
    // the snapshot script then sees a clean list of 0x values
    // ready for the allowlist Merkle tree.
    if (RE_ETH_ADDR.test(value)) {
      // Already a 0x address — keep as-is.
    } else if (RE_ENS_NAME.test(value)) {
      const resolved = await resolveEnsName(env, value);
      if (!resolved) {
        return error('ens_unresolvable', 400, origin);
      }
      value = resolved;
    } else {
      return error('bad_address', 400, origin);
    }
  } else if (kind === 'email') {
    if (!RE_EMAIL_LOOSE.test(value) || value.length > 254) return error('bad_email', 400, origin);
  } else {
    return error('bad_kind', 400, origin);
  }

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

  // INSERT OR IGNORE so a duplicate value silently succeeds — the user
  // sees "you're on the list" either way. We don't leak whether they
  // were already there.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO waitlist (kind, value, ts, ip_hash) VALUES (?, ?, ?, ?)'
  ).bind(kind, value, nowMs, ipHash).run();

  return json({ ok: true }, {}, origin);
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

// ----- Main dispatcher -----
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === '/api/health') {
        const deployed = !!env.CONTRACT_ADDRESS && env.CONTRACT_ADDRESS !== '0x0000000000000000000000000000000000000000';
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
        }, { status: dbOk ? 200 : 503 }, origin);
      }

      if (path.startsWith('/api/owned/')) {
        const addr = path.slice('/api/owned/'.length);
        return await handleOwned(env, addr, origin);
      }
      if (path.startsWith('/api/state-batch')) {
        return await handleStateBatch(env, url.searchParams.get('tokens'), origin);
      }
      if (path.startsWith('/api/state/')) {
        const id = path.slice('/api/state/'.length);
        return await handleState(env, id, origin);
      }
      if (path === '/api/conjugate' && req.method === 'POST') {
        return await handleConjugate(req, env, origin);
      }
      if (path === '/api/log') {
        return await handleLog(env, url, origin);
      }
      if (path === '/api/waitlist/count') {
        return await handleWaitlistCount(env, origin);
      }
      if (path === '/api/waitlist' && req.method === 'POST') {
        return await handleWaitlistAdd(req, env, origin);
      }

      return error('not_found', 404, origin);
    } catch (e) {
      console.error('Worker exception:', e?.stack || e);
      return error('internal_error', 500, origin);
    }
  },
};
