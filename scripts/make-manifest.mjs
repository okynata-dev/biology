#!/usr/bin/env node
// make-manifest.mjs — emit the traits manifest for tokens 1..N.
//
// Pure computation: replicates worker.js _generateState / _pickName /
// label maps VERBATIM so each entry matches what preview.html renders for
// that seed (RNG parity is the hard invariant — do not "tidy" the weight
// tables or the rng() call order). Feeds the gallery's client-side search.
//
// Usage: node scripts/make-manifest.mjs [count] [outfile]
//        node scripts/make-manifest.mjs 8000 gallery-data.json

import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const COUNT = parseInt(process.argv[2] || '8000', 10);
const OUT = process.argv[3] || 'gallery-data.json';
const PREMINT_FILE = process.argv[4] || 'premint.json';

// Optional pre-mint overlay — elevates ~550 tokens to Hybrid/Chimera/Phoenix.
let PREMINT = null;
if (existsSync(PREMINT_FILE)) {
  try { PREMINT = JSON.parse(readFileSync(PREMINT_FILE, 'utf8')).tokens; } catch (_) { PREMINT = null; }
}
// Display labels for the elevated (unlock / mix) palettes.
const ELEVATED_PAL_LABEL = {
  gold: 'Gold', plasma: 'Plasma', aurora_storm: 'Aurora storm',
  radioactive: 'Radioactive', void: 'Void',
};
function elevatedPaletteLabel(stain) {
  if (ELEVATED_PAL_LABEL[stain]) return ELEVATED_PAL_LABEL[stain];
  if (stain && stain.includes('+')) return stain.split('+').length >= 3 ? 'Chimera mix' : 'Hybrid stain';
  return stain;
}

// ---- RNG (verbatim worker.js _mulberry32) ----
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- Weight tables (byte-identical with preview.html / worker.js / engine) ----
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

// ---- Base trait generation (verbatim worker.js _generateState) ----
function generateState(seed) {
  const rng = mulberry32(seed);
  const state = { seed, organelles: ['capsule'] };
  state.morphology = pickW(MORPHOLOGY_WEIGHTS, rng);
  state.palette = pickW(PALETTE_WEIGHTS, rng);
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
  state.reserveGranule = pickW(RESERVE_WEIGHTS, rng);
  let lc = pickW(LIFECYCLE_WEIGHTS, rng);
  if (lc === 'heterocyst' && state.morphology !== 'filament' && state.morphology !== 'mycelium') lc = 'vegetative';
  state.lifecycle = lc;
  state.phageAttached = rng() < 0.015;
  state.endosymbiont = rng() < 0.01;
  state.biofilmHalo = rng() < 0.02;
  return state;
}

// ---- Species name (verbatim worker.js _pickName) ----
const NAME_PREFIX = [
  'Halo','Aure','Lumi','Spiro','Vibrio','Coccu','Micro','Crypto',
  'Polyspora','Sympha','Glia','Plasmo','Endo','Strepto',
  'Acid','Chemo','Pheno','Pseudo','Auro','Cyto','Phago','Lipo',
  'Astro','Cryo','Thermo','Photo','Carbo','Ferro','Magneto','Geo','Nano','Xeno',
];
const NAME_SUFFIX = [
  'philia','lensis','nescens','aria','caula','genia','nax',
  'corymba','roteus','mensis','tarchus','lina','striga','thymos',
  'bacter','coccus','monas','philis','mira','voraxa','geri',
  'fila','ster','dictyon','helios','gena','sphaera','tuus','vorans','capsa','mantia','oides',
];
function pickName(seed) {
  const r = mulberry32(seed);
  return (NAME_PREFIX[Math.floor(r() * 32)] + NAME_SUFFIX[Math.floor(r() * 32)]).toUpperCase();
}

// ---- Label maps (verbatim worker.js) ----
const PALETTE_LABEL = {
  gramPositive: 'Gram-positive purple', gramNegative: 'Gram-negative pink',
  fluorescent: 'Fluorescent green', methylene: 'Methylene blue',
  darkfield: 'Darkfield silver', acid_fast: 'Acid-fast carmine',
  giemsa: 'Giemsa indigo', iridescent_aurora: 'Iridescent aurora',
  ghost: 'Ghost', safranin: 'Safranin orange', india_ink: 'India ink negative',
  gram_variable: 'Gram-variable', malachite: 'Malachite green',
  congo_red: 'Congo red', carbol_fuchsin: 'Carbol fuchsin',
  bismarck_brown: 'Bismarck brown', nile_blue: 'Nile blue',
  eosin: 'Eosin coral', toluidine: 'Toluidine violet',
  ziehl_dual: 'Ziehl-Neelsen dual', spore_dual: 'Schaeffer-Fulton dual',
};
const MORPH_LABEL = {
  coccus: 'Coccus', bacillus: 'Bacillus', vibrio: 'Vibrio', spirillum: 'Spirillum',
  filament: 'Filament', cluster: 'Cluster', diplo: 'Diplo',
  streptobacillus: 'Streptobacillus', tetrad: 'Tetrad', sarcina: 'Sarcina', mycelium: 'Mycelium',
};
const LIFECYCLE_LABEL = {
  vegetative: 'Vegetative', binary_fission: 'Binary fission',
  sporulating: 'Sporulating', heterocyst: 'Heterocyst',
};
const RESERVE_LABEL = {
  none: 'None', phb: 'PHB granules', volutin: 'Volutin',
  magnetosomes: 'Magnetosomes', sulfur: 'Sulfur granules', crystalline: 'Crystalline inclusions',
};
const ORG_LABEL = {
  capsule: 'Capsule', nucleoid: 'Nucleoid', ribosomes: 'Ribosomes', pili: 'Pili',
  flagellum: 'Flagellum', plasmid: 'Plasmid', endospore: 'Endospore',
  inclusion: 'Inclusion', eyespot: 'Eyespot', axial: 'Axial filament',
};

// ---- Build manifest ----
const tokens = [];
for (let id = 1; id <= COUNT; id++) {
  const s = generateState(id);
  const org = s.organelles.filter(o => o !== 'capsule').map(o => ORG_LABEL[o] || o);
  const anom = [];
  if (s.phageAttached) anom.push('Phage attached');
  if (s.endosymbiont) anom.push('Endosymbiont');
  if (s.biofilmHalo) anom.push('Biofilm halo');
  const tok = {
    i: id,
    n: pickName(id),
    p: PALETTE_LABEL[s.palette] || s.palette,
    m: MORPH_LABEL[s.morphology] || s.morphology,
    c: s.cellCount,
    l: LIFECYCLE_LABEL[s.lifecycle] || s.lifecycle,
    r: RESERVE_LABEL[s.reserveGranule] || s.reserveGranule,
    o: org,
    a: anom,
    t: 'Genesis', // base tier; pre-mint elevation overlaid below
  };
  // Pre-mint overlay — elevated tokens carry their synthesized state so
  // gallery search finds "Phoenix", "Gold", etc. and the trait chips match
  // the re-rendered master.
  const pm = PREMINT && PREMINT[id];
  if (pm) {
    tok.t = pm.tier;
    tok.p = elevatedPaletteLabel(pm.stain);
    tok.c = pm.cells;
    tok.o = (pm.organelles || []).filter(o => o !== 'capsule').map(o => ORG_LABEL[o] || o);
    const a2 = [];
    if (pm.phage) a2.push('Phage attached');
    if (pm.endo) a2.push('Endosymbiont');
    if (pm.biofilm) a2.push('Biofilm halo');
    tok.a = a2;
  }
  tokens.push(tok);
}

// Distribution summary (sanity)
const palCount = {};
for (const t of tokens) palCount[t.p] = (palCount[t.p] || 0) + 1;

writeFileSync(OUT, JSON.stringify({ count: tokens.length, tokens }));
console.error(`wrote ${OUT} — ${tokens.length} tokens`);
console.error('palette distribution:');
for (const [k, v] of Object.entries(palCount).sort((a, b) => b[1] - a[1])) {
  console.error('  ' + k.padEnd(24) + String(v).padStart(5) + '  ' + (100 * v / tokens.length).toFixed(1) + '%');
}
