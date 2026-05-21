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
  // Mutations row + absorbed lineage
  const m = await env.DB.prepare(
    'SELECT received_palette, received_organelles, received_anomalies, absorbed_seeds FROM token_state WHERE token_id = ?'
  ).bind(tokenId).first();

  const mutations = {
    palette: m?.received_palette || null,
    organelles: m?.received_organelles ? JSON.parse(m.received_organelles) : [],
    anomalies: m?.received_anomalies ? JSON.parse(m.received_anomalies) : [],
  };

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

  return { mutations, depletions, absorbedSeeds, burned: burnedInfo };
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

async function listOwned(env, address) {
  // Strict hex-address validation (same standard as /api/health) so a
  // placeholder secret can't accidentally surface as "contract deployed".
  if (!/^0x[a-fA-F0-9]{40}$/.test(env.CONTRACT_ADDRESS || '') ||
      env.CONTRACT_ADDRESS.toLowerCase() === '0x0000000000000000000000000000000000000000') {
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
async function handleBurn(req, env, origin) {
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
  // Append donor seed to lineage — first absorbed seed = rank-2, etc.
  absorbedSeeds.push(donorId);

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
        INSERT INTO token_state (token_id, received_palette, received_organelles, received_anomalies, absorbed_seeds, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(token_id) DO UPDATE SET
          received_palette = excluded.received_palette,
          received_organelles = excluded.received_organelles,
          received_anomalies = excluded.received_anomalies,
          absorbed_seeds = excluded.absorbed_seeds,
          updated_at = excluded.updated_at
      `).bind(
        recipientId,
        recM.palette || null,
        JSON.stringify(recM.organelles),
        JSON.stringify(recM.anomalies),
        JSON.stringify(absorbedSeeds),
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

  return json({
    ok: true,
    burnedTokenId: donorId,
    recipientTokenId: recipientId,
    txHash,
    blockNumber: verdict.blockNumber ? String(verdict.blockNumber) : null,
    absorbedSeeds,
    rank: absorbedSeeds.length + 1,
  }, {}, origin);
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
  ['gramPositive', 20], ['gramNegative', 16], ['fluorescent', 14], ['methylene', 12],
  ['darkfield', 8], ['acid_fast', 6], ['giemsa', 5], ['iridescent_aurora', 7],
  ['ghost', 5], ['safranin', 3], ['india_ink', 3], ['gram_variable', 1],
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

function _tierForRank(rank) {
  if (rank <= 1) return 'Genesis';
  if (rank <= 3) return 'Hybrid';
  if (rank <= 7) return 'Chimera';
  return 'Phoenix';
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
  try {
    const { mutations: m } = await loadTokenState(env, tokenId);
    mutations = m || {};
  } catch (_) { /* ignore */ }

  // Effective state after mutations
  const eff = { ...state, organelles: state.organelles.slice() };
  if (mutations.receivedPalette) eff.palette = mutations.receivedPalette;
  if (Array.isArray(mutations.receivedOrganelles)) {
    for (const o of mutations.receivedOrganelles) if (!eff.organelles.includes(o)) eff.organelles.push(o);
  }
  if (Array.isArray(mutations.receivedAnomalies)) {
    for (const a of mutations.receivedAnomalies) eff[a] = true;
  }
  if (mutations.receivedMorphology) eff.morphology = mutations.receivedMorphology;
  if (mutations.receivedCellCount) eff.cellCount = mutations.receivedCellCount;
  if (mutations.receivedLifecycle) eff.lifecycle = mutations.receivedLifecycle;
  if (mutations.receivedReserve)   eff.reserveGranule = mutations.receivedReserve;
  const rank = mutations.rank || 1;
  const absorbed = mutations.burnsAbsorbed || 0;
  const tier = _tierForRank(rank);

  // Attributes — order matters for OpenSea grouping
  const attributes = [
    // Species first — the per-token "nickname" derived from the seed
    // (PHAGOPHILIA / STREPTONAX / GLIAARIA …). 1/3000 unique per token
    // so it acts as the human-readable identity inside the BIOM #N
    // wrapper.
    { trait_type: 'Species',      value: name },
    { trait_type: 'Tier',         value: tier },
    { trait_type: 'Rank',         value: rank, display_type: 'number' },
    { trait_type: 'Morphology',   value: _MORPH_LABEL[eff.morphology]    || eff.morphology },
    { trait_type: 'Palette',      value: _PALETTE_LABEL[eff.palette]     || eff.palette },
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
  if (absorbed > 0) {
    attributes.push({ trait_type: 'Burns absorbed', value: absorbed, display_type: 'number' });
  }

  return {
    // "BIOM #N" — no padding, max ID is 2999 so digit count tops out at
    // 4 chars and reads cleaner than "BIOM #00001". Genus name (the old
    // "PHAGOPHILIA" style identifier) is preserved as a Species trait so
    // the character isn't lost — it just doesn't crowd the title.
    name: `BIOM #${tokenId}`,
    description: 'A living microbe from the Bioms collection — 3000 generative specimens that share traits, burn each other, and evolve. The survivors carry everything forward. thebioms.com',
    image: `https://pngs.thebioms.com/preview/${padded}.png`,
    image_url: `https://pngs.thebioms.com/preview/${padded}.png`,  // OpenSea legacy field
    animation_url: `https://thebioms.com/preview.html?seed=${tokenId}`,
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

async function handleWaitlistAdd(req, env, origin) {
  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }

  // Address-only intake. Email collection was dropped — the snapshot
  // pipeline only needs wallets. `kind` is still accepted as 'address'
  // for backwards-compat with the previous frontend, but anything else
  // bounces.
  let value = body && body.value;
  if (typeof value !== 'string') return error('bad_value', 400, origin);
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
  let body;
  try { body = await req.json(); }
  catch { return error('invalid_json', 400, origin); }
  const { token, value } = body || {};
  if (!token || token !== env.ADMIN_TOKEN) return error('forbidden', 403, origin);
  if (typeof value !== 'string' || !value.trim()) return error('bad_value', 400, origin);
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
  const url = new URL(req.url);
  const token = url.searchParams.get('token') || '';
  if (token !== env.ADMIN_TOKEN) return error('forbidden', 403, origin);
  const format = (url.searchParams.get('format') || 'json').toLowerCase();
  const limit = Math.min(10000, parseInt(url.searchParams.get('limit') || '5000', 10));

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
  const limit = 10000;
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

// ----- Main dispatcher -----
export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders(origin) });

    const url = new URL(req.url);
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
      if (path.startsWith('/api/metadata/')) {
        // OpenSea-compatible JSON for each tokenId.
        // Contract baseURI should be: https://api.thebioms.com/api/metadata/
        const id = path.slice('/api/metadata/'.length);
        return await handleMetadata(env, id, origin);
      }
      if (path === '/api/conjugate' && req.method === 'POST') {
        return await handleConjugate(req, env, origin);
      }
      if (path === '/api/burn' && req.method === 'POST') {
        return await handleBurn(req, env, origin);
      }
      if (path === '/api/log') {
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

      return error('not_found', 404, origin);
    } catch (e) {
      console.error('Worker exception:', e?.stack || e);
      return error('internal_error', 500, origin);
    }
  },
};
