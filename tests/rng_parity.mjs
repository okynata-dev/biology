// RNG parity oracle — JS side.
//
// Loads specimen-engine.js inside a Node vm context, calls generateState
// for the same seeds as rng_parity.py, prints canonical JSON. The
// companion bash script diffs them.
//
// We use vm rather than dynamic import because specimen-engine.js is
// not an ES module — it self-assigns to window.BiomEngine (the no-build
// constraint, see CLAUDE.md §7). Faking a `window` global is one line.
//
// Keep SEEDS in lockstep with rng_parity.py.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const SEEDS = [0, 1, 42, 247, 999, 1000, 1500, 1999, 2000, 2500, 2998, 2999,
               3000, 3001, 4000, 5500, 7000, 7999, 8000];

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const source = readFileSync(join(repoRoot, 'specimen-engine.js'), 'utf8');

// Minimal browser-shim: the engine only touches `document` inside
// _resolveReveal() (which is REVEAL-flag resolution, irrelevant to RNG)
// and `window` for the BiomEngine attachment. Stub both.
const sandbox = {
  window: {},
  document: { querySelector() { return null; } },
  console,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'specimen-engine.js' });

const engine = sandbox.window.BiomEngine;
if (!engine || typeof engine.generateState !== 'function') {
  console.error('Engine did not attach generateState — refactor broke the API.');
  process.exit(2);
}

function canonical(seed) {
  const s = engine.generateState(seed);
  return {
    seed: s.seed,
    morphology: s.morphology,
    palette: s.palette,
    cellCount: s.cellCount,
    accentCount: s.accentCount,
    organelles: Array.from(s.organelles).sort(),
    reserveGranule: s.reserveGranule,
    lifecycle: s.lifecycle,
    phageAttached: !!s.phageAttached,
    endosymbiont: !!s.endosymbiont,
    biofilmHalo: !!s.biofilmHalo,
  };
}

const out = SEEDS.map(canonical);
// JSON.stringify lacks sort_keys, but the object literals above are
// constructed in the same order as the Python side — equal output.
// To be safe against future field-order edits, we walk the keys.
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const o = {};
    for (const k of keys) o[k] = sortedJson(value[k]);
    return o;
  }
  return value;
}
process.stdout.write(JSON.stringify(sortedJson(out)));
process.stdout.write('\n');
