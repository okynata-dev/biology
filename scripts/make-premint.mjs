#!/usr/bin/env node
// make-premint.mjs — assign + synthesize the pre-minted elevated tiers.
//
// ~550 of the 8000 tokens ship as if they were already burn-survivors:
//   500 Hybrid (rank 2-3)   — a two-stain mix, a few extra cells
//    45 Chimera (rank 4-7)  — an unlocked prize palette or 3-stain chimera
//     5 Phoenix (rank 8-15) — gold / plasma / aurora_storm, many cells
// Apex (Superorganism/Biome) are NEVER pre-minted — burn-only.
//
// Output premint.json maps tokenId -> the elevated state + the exact
// preview.html force-param query string. Consumed by:
//   - the override render pass (re-renders these masters/thumbs)
//   - worker.js buildMetadata (Tier/Rank/attributes + animation_url)
//   - make-manifest.mjs (overlays elevated tier into gallery-data.json)
//
// Deterministic: fixed PRNG salt → same assignment every run. Reproducible
// across the render batch, the worker, and the manifest.
//
// Usage: node scripts/make-premint.mjs [total] [outfile]

import { writeFileSync } from 'node:fs';

const TOTAL = parseInt(process.argv[2] || '8000', 10);
const OUT = process.argv[3] || 'premint.json';

// Owner-approved distribution (Phoenix fixed at 5 by spec).
const DIST = { Phoenix: 5, Chimera: 45, Hybrid: 500 };
const SALT = 0xB10E5; // fixed → reproducible assignment

function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
const rngFor = id => mulberry32((id ^ SALT) >>> 0);
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const ri = (rng, lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive

// Deterministic Fisher-Yates shuffle of 1..TOTAL with the salted PRNG.
const order = Array.from({ length: TOTAL }, (_, i) => i + 1);
const shuf = mulberry32(SALT);
for (let i = order.length - 1; i > 0; i--) {
  const j = Math.floor(shuf() * (i + 1));
  [order[i], order[j]] = [order[j], order[i]];
}
const phoenixIds = order.slice(0, DIST.Phoenix);
const chimeraIds = order.slice(DIST.Phoenix, DIST.Phoenix + DIST.Chimera);
const hybridIds  = order.slice(DIST.Phoenix + DIST.Chimera, DIST.Phoenix + DIST.Chimera + DIST.Hybrid);

// Palette pools.
const MIX_STAINS = [
  'gramPositive', 'gramNegative', 'fluorescent', 'methylene', 'darkfield',
  'acid_fast', 'giemsa', 'malachite', 'congo_red', 'carbol_fuchsin',
  'nile_blue', 'toluidine', 'eosin', 'bismarck_brown',
];
const PHOENIX_PRIZE = ['gold', 'plasma', 'aurora_storm'];
const CHIMERA_UNLOCK = ['radioactive', 'void'];
const ALL_ORG = ['capsule', 'nucleoid', 'ribosomes', 'pili', 'flagellum',
                 'plasmid', 'inclusion', 'eyespot', 'axial'];

function twoDistinct(rng, pool) {
  const a = pick(rng, pool);
  let b = pick(rng, pool);
  let guard = 0;
  while (b === a && guard++ < 8) b = pick(rng, pool);
  return [a, b];
}
function nDistinct(rng, pool, n) {
  const set = new Set();
  let guard = 0;
  while (set.size < n && guard++ < 40) set.add(pick(rng, pool));
  return [...set];
}
// Synthetic ancestry — `count` distinct seeds in 1..TOTAL, excluding self.
function lineage(rng, selfId, count) {
  const set = new Set();
  let guard = 0;
  while (set.size < count && guard++ < count * 6) {
    const s = ri(rng, 1, TOTAL);
    if (s !== selfId) set.add(s);
  }
  return [...set];
}

function buildState(id, tier) {
  const rng = rngFor(id);
  let rank, stain, cells, organelles, phage = false, biofilm = false, endo = false;

  if (tier === 'Hybrid') {
    ri(rng, 2, 3);          // consume the legacy rank roll to keep the PRNG
    rank = 2;               // stream identical → stains/cells/organelles (and
                            // the rendered masters) unchanged. Binary economy:
                            // Hybrid = merge level 2 (2 base Bioms).
    const [a, b] = twoDistinct(rng, MIX_STAINS);
    stain = `${a}+${b}`;
    cells = ri(rng, 3, 4);
    organelles = [...new Set(['capsule', 'nucleoid', 'ribosomes', 'pili', 'plasmid',
      ...(rng() < 0.5 ? ['inclusion'] : [])])];
  } else if (tier === 'Chimera') {
    ri(rng, 4, 7);          // consume legacy roll (stream parity)
    rank = 3;               // Chimera = merge level 3 (4 base Bioms)
    if (rng() < 0.5) {
      stain = pick(rng, CHIMERA_UNLOCK);
    } else {
      stain = nDistinct(rng, MIX_STAINS, 3).join('+');
    }
    cells = ri(rng, 5, 7);
    organelles = [...new Set(['capsule', 'nucleoid', 'ribosomes', 'pili', 'flagellum',
      'plasmid', 'inclusion', 'eyespot', ...(rng() < 0.5 ? ['axial'] : [])])];
    biofilm = rng() < 0.3;
  } else { // Phoenix
    ri(rng, 8, 15);         // consume legacy roll (stream parity)
    rank = 4;               // Phoenix = merge level 4 (8 base Bioms)
    stain = pick(rng, PHOENIX_PRIZE);
    cells = ri(rng, 7, 8);
    organelles = ALL_ORG.slice();
    if (rng() < 0.5) phage = true; else biofilm = true;
  }

  // Binary economy: a level-N token represents 2^(N-1) base Bioms, so its
  // synthetic ancestry is 2^(N-1)-1 absorbed seeds (Hybrid 1, Chimera 3,
  // Phoenix 7). This is the LAST rng consumer in buildState, so changing the
  // count leaves stains/cells/organelles (the rendered masters) untouched.
  const absorbed = lineage(rng, id, (2 ** (rank - 1)) - 1);

  // Exact preview.html force-param query (no leading '?').
  const p = new URLSearchParams();
  p.set('seed', String(id));
  p.set('forceStain', stain);
  p.set('forceCells', String(cells));
  p.set('forceOrganelles', organelles.join(','));
  if (phage) p.set('forcePhage', '1');
  if (biofilm) p.set('forceBiofilm', '1');
  if (endo) p.set('forceEndo', '1');

  return { tier, rank, stain, cells, organelles, phage, biofilm, endo,
           absorbed, force: p.toString() };
}

const tokens = {};
for (const id of phoenixIds) tokens[id] = buildState(id, 'Phoenix');
for (const id of chimeraIds) tokens[id] = buildState(id, 'Chimera');
for (const id of hybridIds)  tokens[id] = buildState(id, 'Hybrid');

writeFileSync(OUT, JSON.stringify({
  total: TOTAL,
  salt: SALT,
  dist: DIST,
  generatedTiers: { Phoenix: phoenixIds.length, Chimera: chimeraIds.length, Hybrid: hybridIds.length },
  tokens,
}, null, 0));

// Browser overlay — a synchronous <script> the engine (preview.html /
// specimen-engine.js) loads so seed->state self-elevates with NO force
// params: the elevated tiers are just intrinsic traits of those seeds,
// rendered the same everywhere (live preview, master, gallery, OpenSea,
// lab). Compact keys: s=stain c=cells o=organelles ph/bf/en=anomalies
// r=rank t=tier.
const overlay = {};
for (const [id, t] of Object.entries(tokens)) {
  overlay[id] = { s: t.stain, c: t.cells, o: t.organelles,
                  ph: t.phage ? 1 : 0, bf: t.biofilm ? 1 : 0, en: t.endo ? 1 : 0,
                  r: t.rank, t: t.tier };
}
writeFileSync('premint-overlay.js', 'window.__BIOM_PREMINT=' + JSON.stringify(overlay) + ';\n');

console.error(`wrote ${OUT} + premint-overlay.js`);
console.error(`Phoenix(${phoenixIds.length}): ${phoenixIds.sort((a,b)=>a-b).join(', ')}`);
console.error(`Chimera(${chimeraIds.length}): ${chimeraIds.sort((a,b)=>a-b).slice(0,12).join(', ')} …`);
console.error(`Hybrid: ${hybridIds.length} ids`);
console.error('\nsamples:');
for (const id of [...phoenixIds.slice(0,2), chimeraIds[0], hybridIds[0]]) {
  const t = tokens[id];
  console.error(`  #${id} ${t.tier} r${t.rank} stain=${t.stain} cells=${t.cells} absorbed=${t.absorbed.length}`);
}
