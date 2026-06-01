#!/usr/bin/env python3
"""
RNG parity oracle — Python side.

Dumps a canonical JSON of generated traits for a fixed set of seeds.
The companion script `rng_parity.mjs` does the same via the JS engine.
`rng_parity_check.sh` diffs them — any divergence fails CI.

The seeds are spread across the 0..2999 space and include edge cases
(0, 1, last, mid). If you add new seeds, mirror them in rng_parity.mjs.

CLAUDE.md §4.1 documents why this matters: the JS engine (used in the
browser at render time) and the Python generator (used at mint to
produce on-chain metadata) MUST agree. Drift = broken NFT collection.
"""
import sys
import json
from pathlib import Path

# Make the project root importable so we can pull in generate_metadata.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from generate_metadata import generate_traits  # noqa: E402

# Canary seeds — spread across the full 0..8000 space, plus boundaries.
# (Supply raised 3000->8000 in 2026-06; high seeds guard the expanded range.)
SEEDS = [0, 1, 42, 247, 999, 1000, 1500, 1999, 2000, 2500, 2998, 2999,
         3000, 3001, 4000, 5500, 7000, 7999, 8000]


def canonical(seed):
    t = generate_traits(seed)
    return {
        'seed': seed,
        'morphology': t['morphology'],
        'palette': t['palette'],
        'cellCount': t['cell_count'],
        'accentCount': t['accent_count'],
        'organelles': sorted(t['organelles']),
        'reserveGranule': t['reserve_granule'],
        'lifecycle': t['lifecycle'],
        'phageAttached': bool(t['phage_attached']),
        'endosymbiont': bool(t['endosymbiont']),
        'biofilmHalo': bool(t['biofilm_halo']),
    }


def main():
    out = [canonical(s) for s in SEEDS]
    # Compact JSON, sorted keys for deterministic diff.
    print(json.dumps(out, separators=(',', ':'), sort_keys=True))


if __name__ == '__main__':
    main()
