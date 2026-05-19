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
async function ownerOf(env, tokenId) {
  if (!env.CONTRACT_ADDRESS || env.CONTRACT_ADDRESS === '0x0000000000000000000000000000000000000000') {
    return null; // pre-mint
  }
  const client = createPublicClient({
    chain: mainnet,
    transport: http(`https://eth-mainnet.g.alchemy.com/v2/${env.ALCHEMY_KEY}`),
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
    const r = await fetch(url);
    if (!r.ok) return { tokens: [], contractDeployed: true, error: 'alchemy_error' };
    const data = await r.json();
    const tokens = (data.ownedNfts || []).map(n => parseInt(n.tokenId, 10)).filter(n => Number.isFinite(n));
    return { tokens, contractDeployed: true };
  } catch (e) {
    return { tokens: [], contractDeployed: true, error: 'fetch_failed' };
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

  // 6. Roll for rejection (server-side RNG; sole source of truth)
  const rejectionRate = parseFloat(env.REJECTION_RATE || '0.15');
  const roll = Math.random();
  const rejected = roll < rejectionRate;
  const ts = Date.now();
  const tsSec = Math.floor(ts / 1000);

  // 7. Persist (atomic-ish — D1 doesn't have transactions yet, but the
  //    nonce insert is the gate that prevents double-spend on retry).
  await env.DB.prepare(
    'INSERT INTO used_nonces (signer, nonce, used_at) VALUES (?, ?, ?)'
  ).bind(signerLc, nonce, tsSec).run();

  await env.DB.prepare(
    'INSERT INTO log (ts, donor, recipient, trait, result, signer) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(ts, donorId, recipientId, trait, rejected ? 'rejected' : 'transfer', signerLc).run();

  if (!rejected) {
    // Update recipient's mutations
    const recipientData = await loadTokenState(env, recipientId);
    const recM = recipientData.mutations;
    const kind = TRAIT_KIND[trait];
    if (kind === 'palette') {
      recM.palette = donorPaletteValue;
    } else if (kind === 'organelle') {
      if (!recM.organelles.includes(trait)) recM.organelles.push(trait);
    } else if (kind === 'anomaly') {
      if (!recM.anomalies.includes(trait)) recM.anomalies.push(trait);
    }
    await env.DB.prepare(`
      INSERT INTO token_state (token_id, received_palette, received_organelles, received_anomalies, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        received_palette = excluded.received_palette,
        received_organelles = excluded.received_organelles,
        received_anomalies = excluded.received_anomalies,
        updated_at = excluded.updated_at
    `).bind(
      recipientId,
      recM.palette || null,
      JSON.stringify(recM.organelles),
      JSON.stringify(recM.anomalies),
      tsSec
    ).run();

    // Donor: record depletion cooldown
    const cooldownSec = parseInt(env.COOLDOWN_SECONDS || '2592000', 10); // 30 days default
    await env.DB.prepare(
      'INSERT INTO depletions (token_id, trait, to_token, donated_at, regenerates_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(donorId, trait, recipientId, tsSec, tsSec + cooldownSec).run();

    // Best-effort: ping OpenSea metadata-refresh for both tokens so the
    // marketplace re-caches the new state. Failures are silent — D1 is
    // already updated; OS will catch up on its own polling cadence too.
    refreshOpenSeaMetadata(env, donorId, recipientId).catch(() => {});
  }

  return json({
    ok: !rejected,
    rejected,
    log: { ts, donor: donorId, recipient: recipientId, trait, op: rejected ? 'rejected' : 'transfer' },
  }, {}, origin);
}

async function refreshOpenSeaMetadata(env, ...tokenIds) {
  if (!env.OPENSEA_API_KEY || !env.CONTRACT_ADDRESS) return;
  const chain = env.CHAIN_ID === '1' ? 'ethereum' : 'sepolia';
  await Promise.all(tokenIds.map(id =>
    fetch(`https://api.opensea.io/api/v2/chain/${chain}/contract/${env.CONTRACT_ADDRESS}/nfts/${id}/refresh`, {
      method: 'POST',
      headers: { 'X-API-KEY': env.OPENSEA_API_KEY },
    })
  ));
}

// ----- Route handlers -----
async function handleOwned(env, address, origin) {
  if (!isAddress(address)) return error('bad_address', 400, origin);
  const result = await listOwned(env, address);
  return json(result, {}, origin);
}

async function handleState(env, tokenIdStr, origin) {
  const tokenId = parseInt(tokenIdStr, 10);
  if (!Number.isFinite(tokenId) || tokenId < 0 || tokenId > 2999) return error('bad_token_id', 400, origin);
  const { mutations, depletions } = await loadTokenState(env, tokenId);
  return json({ tokenId, mutations, depletions }, {
    headers: { 'Cache-Control': 'public, max-age=10, s-maxage=10' },
  }, origin);
}

async function handleStateBatch(env, tokensParam, origin) {
  const ids = (tokensParam || '').split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n) && n >= 0 && n <= 2999).slice(0, 100);
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
    if (!RE_ETH_ADDR.test(value)) return error('bad_address', 400, origin);
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
        return json({
          ok: true,
          contractDeployed: deployed,
          contractAddress: deployed ? env.CONTRACT_ADDRESS : null,
          chainId: parseInt(env.CHAIN_ID || '1', 10),
          cooldownSeconds: parseInt(env.COOLDOWN_SECONDS || '2592000', 10),
          rejectionRate: parseFloat(env.REJECTION_RATE || '0.15'),
        }, {}, origin);
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
