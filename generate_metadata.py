#!/usr/bin/env python3
"""
Generate OpenSea-compatible metadata JSON for the Bioms collection.

Usage:
    python3 generate_metadata.py <output_dir> <count> [--start SEED] [--base-uri URI]

Example:
    python3 generate_metadata.py ./metadata 10000 --base-uri ipfs://Qm...

Output: one JSON per token (00000.json, 00001.json, ...) plus collection-level
       metadata.json with summary stats.

The generator REPLICATES the exact same RNG/state logic as preview.html so that
trait_type values match what the HTML actually renders for each seed.
"""

import sys
import os
import json
import argparse
from pathlib import Path


# =========================================================================
# Mulberry32 RNG — must match preview.html exactly
# =========================================================================
def mulberry32(seed):
    """Return a closure that yields 0..1 floats; matches JS mulberry32."""
    state = [seed & 0xFFFFFFFF]

    def imul(a, b):
        """Math.imul equivalent: 32-bit signed multiplication, return low 32 bits."""
        a = a & 0xFFFFFFFF
        b = b & 0xFFFFFFFF
        r = (a * b) & 0xFFFFFFFF
        return r

    def next_val():
        # JS:  t = (t + 0x6D2B79F5) | 0;
        state[0] = (state[0] + 0x6D2B79F5) & 0xFFFFFFFF
        t = state[0]

        # JS:  let r = Math.imul(t ^ (t >>> 15), 1 | t);
        r = imul(t ^ (t >> 15), 1 | t)

        # JS:  r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
        r = ((r + imul(r ^ (r >> 7), 61 | r)) & 0xFFFFFFFF) ^ r

        # JS:  return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
        return ((r ^ (r >> 14)) & 0xFFFFFFFF) / 4294967296.0

    return next_val


# =========================================================================
# Trait generation — exact replication of randomize() in preview.html
# Order of rng() calls is sacred. Modify with care; run parity diff after.
# =========================================================================

# 11 morphologies with weighted distribution. Sum = 100.
MORPHOLOGY_WEIGHTS = [
    ('coccus',           13),
    ('bacillus',         13),
    ('vibrio',           12),
    ('spirillum',        12),
    ('filament',         10),
    ('cluster',          10),
    ('diplo',            10),
    ('streptobacillus',   8),
    ('tetrad',            7),
    ('sarcina',           3),
    ('mycelium',          2),
]


def pick_weighted_morph(rng):
    r = rng() * 100
    acc = 0
    for name, w in MORPHOLOGY_WEIGHTS:
        acc += w
        if r < acc:
            return name
    return MORPHOLOGY_WEIGHTS[-1][0]


# 12 stains with weighted distribution. Sum = 100.
PALETTE_WEIGHTS = [
    ('gramPositive',      13),
    ('gramNegative',      11),
    ('fluorescent',       10),
    ('methylene',          9),
    ('darkfield',          6),
    ('acid_fast',          5),
    ('giemsa',             4),
    ('iridescent_aurora',  5),
    ('ghost',              4),
    ('safranin',           3),
    ('india_ink',          3),
    ('gram_variable',      1),
    ('malachite',          4),
    ('congo_red',          3),
    ('carbol_fuchsin',     4),
    ('bismarck_brown',     4),
    ('nile_blue',          4),
    ('eosin',              2),
    ('toluidine',          3),
    ('ziehl_dual',         1),
    ('spore_dual',         1),
]


def pick_weighted_palette(rng):
    r = rng() * 100
    acc = 0
    for name, w in PALETTE_WEIGHTS:
        acc += w
        if r < acc:
            return name
    return PALETTE_WEIGHTS[-1][0]


# Reserve granule — mutually exclusive cellular cargo type.
RESERVE_WEIGHTS = [
    ('none',          64),
    ('phb',           12),
    ('volutin',       10),
    ('magnetosomes',   7),
    ('sulfur',         4),
    ('crystalline',    3),
]


def pick_weighted_reserve(rng):
    r = rng() * 100
    acc = 0
    for name, w in RESERVE_WEIGHTS:
        acc += w
        if r < acc:
            return name
    return 'none'


# Lifecycle state — mutually exclusive.
LIFECYCLE_WEIGHTS = [
    ('vegetative',    78),
    ('binary_fission', 10),
    ('sporulating',     6),
    ('heterocyst',      6),
]


def pick_weighted_lifecycle(rng):
    r = rng() * 100
    acc = 0
    for name, w in LIFECYCLE_WEIGHTS:
        acc += w
        if r < acc:
            return name
    return 'vegetative'


# Display labels for OpenSea
MORPHOLOGY_LABEL = {
    'coccus': 'Coccus', 'bacillus': 'Bacillus', 'vibrio': 'Vibrio',
    'spirillum': 'Spirillum', 'filament': 'Filament', 'cluster': 'Cluster',
    'diplo': 'Diplo',
    'streptobacillus': 'Streptobacillus', 'tetrad': 'Tetrad',
    'sarcina': 'Sarcina', 'mycelium': 'Mycelium',
}
STAIN_LABEL = {
    'gramPositive': 'Gram+', 'gramNegative': 'Gram−', 'fluorescent': 'Fluorescent',
    'methylene': 'Methylene', 'darkfield': 'Dark-field',
    'iridescent_aurora': 'Aurora', 'ghost': 'Ghost', 'gram_variable': 'Gram-variable',
    'acid_fast': 'Acid-fast', 'giemsa': 'Giemsa',
    'safranin': 'Safranin', 'india_ink': 'India Ink',
    'malachite': 'Malachite', 'congo_red': 'Congo Red', 'carbol_fuchsin': 'Carbol Fuchsin',
    'bismarck_brown': 'Bismarck Brown', 'nile_blue': 'Nile Blue', 'eosin': 'Eosin',
    'toluidine': 'Toluidine', 'ziehl_dual': 'Ziehl–Neelsen', 'spore_dual': 'Schaeffer–Fulton',
}
ORGANELLE_LABEL = {
    'capsule': 'Capsule', 'nucleoid': 'Nucleoid', 'ribosomes': 'Ribosomes',
    'pili': 'Pili', 'flagellum': 'Flagellum', 'plasmid': 'Plasmid',
    'endospore': 'Endospore', 'inclusion': 'Inclusion',
    'eyespot': 'Eye-spot', 'axial': 'Axial Filament',
}
RESERVE_LABEL = {
    'none': 'None', 'phb': 'PHB Granules', 'volutin': 'Volutin',
    'magnetosomes': 'Magnetosomes', 'sulfur': 'Sulfur Globules',
    'crystalline': 'Crystalline Inclusion',
}
LIFECYCLE_LABEL = {
    'vegetative': 'Vegetative', 'binary_fission': 'Binary Fission',
    'sporulating': 'Sporulating', 'heterocyst': 'Heterocyst',
}

# 32 prefixes × 32 suffixes = 1024 combinations.
NAME_PREFIX = [
    'Halo', 'Aure', 'Lumi', 'Spiro', 'Vibrio', 'Coccu', 'Micro', 'Crypto',
    'Polyspora', 'Sympha', 'Glia', 'Plasmo', 'Endo', 'Strepto',
    'Acid', 'Chemo', 'Pheno', 'Pseudo', 'Auro', 'Cyto', 'Phago', 'Lipo',
    'Astro', 'Cryo', 'Thermo', 'Photo', 'Carbo', 'Ferro', 'Magneto', 'Geo', 'Nano', 'Xeno',
]
NAME_SUFFIX = [
    'philia', 'lensis', 'nescens', 'aria', 'caula', 'genia', 'nax',
    'corymba', 'roteus', 'mensis', 'tarchus', 'lina', 'striga', 'thymos',
    'bacter', 'coccus', 'monas', 'philis', 'mira', 'voraxa', 'geri',
    'fila', 'ster', 'dictyon', 'helios', 'gena', 'sphaera', 'tuus', 'vorans', 'capsa', 'mantia', 'oides',
]


def pick_name(seed):
    """Generate procedural latin-ish name from seed."""
    r = mulberry32(seed)
    a = NAME_PREFIX[int(r() * len(NAME_PREFIX))]
    b = NAME_SUFFIX[int(r() * len(NAME_SUFFIX))]
    return (a + b).upper()


def generate_traits(seed):
    """Replicate the randomize() logic from preview.html.

    rng() call order MUST match JS exactly. Each call advances the shared
    state; reordering breaks parity.
    """
    rng = mulberry32(seed)

    morphology = pick_weighted_morph(rng)
    palette = pick_weighted_palette(rng)
    cell_count = 1 + int(rng() * 6)
    accent_count = int(rng() * 4)

    organelles = {'capsule'}  # always on
    if rng() < 0.85: organelles.add('nucleoid')
    if rng() < 0.45: organelles.add('ribosomes')
    if rng() < 0.55: organelles.add('pili')
    if rng() < 0.30: organelles.add('flagellum')
    if rng() < 0.40: organelles.add('plasmid')
    if rng() < 0.15: organelles.add('endospore')
    if rng() < 0.20: organelles.add('inclusion')
    if rng() < 0.20: organelles.add('eyespot')
    if rng() < 0.15: organelles.add('axial')

    # === NEW TRAITS (Maximalist) ===
    reserve_granule = pick_weighted_reserve(rng)
    lifecycle = pick_weighted_lifecycle(rng)
    # Heterocyst valid only for filamentous forms.
    if lifecycle == 'heterocyst' and morphology not in ('filament', 'mycelium'):
        lifecycle = 'vegetative'
    phage_attached = rng() < 0.015
    endosymbiont = rng() < 0.01
    biofilm_halo = rng() < 0.02

    return {
        'morphology': morphology,
        'palette': palette,
        'cell_count': cell_count,
        'accent_count': accent_count,
        'organelles': sorted(organelles),
        'reserve_granule': reserve_granule,
        'lifecycle': lifecycle,
        'phage_attached': phage_attached,
        'endosymbiont': endosymbiont,
        'biofilm_halo': biofilm_halo,
    }


def build_metadata(seed, base_image_uri, base_animation_uri):
    """Build OpenSea-compatible ERC-721 metadata for a single token."""
    traits = generate_traits(seed)
    name = pick_name(seed)
    token_id_padded = f"{seed:05d}"

    attributes = [
        # Species is the procedural latin-ish name. Surface as a filterable trait
        # so collectors can browse "show me all HALOROTEUS Bioms".
        {"trait_type": "Species", "value": name},
        {"trait_type": "Morphology", "value": MORPHOLOGY_LABEL[traits['morphology']]},
        {"trait_type": "Stain", "value": STAIN_LABEL[traits['palette']]},
        {"trait_type": "Reserve", "value": RESERVE_LABEL[traits['reserve_granule']]},
        {"trait_type": "Lifecycle", "value": LIFECYCLE_LABEL[traits['lifecycle']]},
        {"trait_type": "Cell Count", "value": traits['cell_count'], "display_type": "number"},
        {"trait_type": "Accent Count", "value": traits['accent_count'], "display_type": "number"},
        {"trait_type": "Organelle Count", "value": len(traits['organelles']), "display_type": "number"},
    ]
    # Each organelle as a separate boolean trait (so OpenSea shows them as filters)
    for org_key in sorted(ORGANELLE_LABEL.keys()):
        if org_key in traits['organelles']:
            attributes.append({
                "trait_type": ORGANELLE_LABEL[org_key],
                "value": "Yes",
            })
    # Ultra-rare effects as boolean traits (only present if true → OpenSea rarity boost)
    if traits['phage_attached']:
        attributes.append({"trait_type": "Phage Attached", "value": "Yes"})
    if traits['endosymbiont']:
        attributes.append({"trait_type": "Endosymbiont", "value": "Yes"})
    if traits['biofilm_halo']:
        attributes.append({"trait_type": "Biofilm Halo", "value": "Yes"})

    return {
        "name": f"BIOM #{seed}",
        "description": (
            f"Bioms · Series I. BIOM #{seed} is a {STAIN_LABEL[traits['palette']]} "
            f"{MORPHOLOGY_LABEL[traits['morphology']].lower()} of species {name}, "
            f"rendered as an animated glass composition. Each work breathes in real time, "
            f"its asymmetric contour shifting through procedural waves."
        ),
        "image": f"{base_image_uri}/{token_id_padded}.png",
        "animation_url": f"{base_animation_uri}?seed={seed}",
        "external_url": f"{base_animation_uri}?seed={seed}",
        "attributes": attributes,
        # Custom metadata block (non-standard, for own use)
        "specimen": {
            "seed": seed,
            "morphology": traits['morphology'],
            "stain": traits['palette'],
            "cells": traits['cell_count'],
            "accents": traits['accent_count'],
            "organelles": traits['organelles'],
            "reserve_granule": traits['reserve_granule'],
            "lifecycle": traits['lifecycle'],
            "phage_attached": traits['phage_attached'],
            "endosymbiont": traits['endosymbiont'],
            "biofilm_halo": traits['biofilm_halo'],
        },
    }


def main():
    parser = argparse.ArgumentParser(
        formatter_class=argparse.RawDescriptionHelpFormatter,
        description="""Generate ERC-721 metadata JSON for Bioms.

Examples — replace yoursite.com with your real domain:

    # Self-hosted (PNGs + HTML on your site)
    python3 generate_metadata.py ./metadata 1000 \\
        --base-image-uri https://yoursite.com/pngs/preview \\
        --base-animation-uri https://yoursite.com/bacteria-preview.html

    # IPFS-hosted (if you upload to Pinata first)
    python3 generate_metadata.py ./metadata 1000 \\
        --base-image-uri ipfs://CID/pngs \\
        --base-animation-uri ipfs://CID/bacteria-preview.html
""")
    parser.add_argument("output_dir", help="Directory to write metadata JSONs")
    parser.add_argument("count", type=int, help="How many tokens to generate")
    parser.add_argument("--start", type=int, default=0, help="Starting seed/token id")
    parser.add_argument("--base-image-uri", default="https://REPLACE_ME.com/pngs/preview",
                        help="Base URI where image PNGs are hosted (no trailing slash). Example: https://living-cultures.vercel.app/pngs/preview")
    parser.add_argument("--base-animation-uri", default="https://REPLACE_ME.com/bacteria-preview.html",
                        help="Full URL of bacteria-preview.html. Example: https://living-cultures.vercel.app/bacteria-preview.html")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    # Stats tracking
    morph_counts = {}
    stain_counts = {}
    organelle_counts = {}

    for i in range(args.count):
        seed = args.start + i
        meta = build_metadata(seed, args.base_image_uri, args.base_animation_uri)

        # Metadata filename: {tokenId}.json (NO zero-padding).
        # ERC-721 standard tokenURI = "<prefix><tokenId>" — OpenSea Studio Drop
        # appends .json when so configured. With padding (e.g. 00247.json) the
        # request for tokenId=247 would hit "metadata/247" → 404.
        # PNG image (referenced inside metadata) keeps padding — that's an
        # internal URL only this generator/renderer agrees on.
        out_path = output_dir / f"{seed}.json"
        with open(out_path, "w") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)

        # Track stats
        traits = meta['specimen']
        morph_counts[traits['morphology']] = morph_counts.get(traits['morphology'], 0) + 1
        stain_counts[traits['stain']] = stain_counts.get(traits['stain'], 0) + 1
        for org in traits['organelles']:
            organelle_counts[org] = organelle_counts.get(org, 0) + 1

        if (i + 1) % 100 == 0 or i == 0 or i == args.count - 1:
            print(f"  [{i+1}/{args.count}] seed={seed} → {out_path.name}")

    # Sanity check — the file for seed 0 must be named "0.json" so OpenSea
    # tokenURI = "<prefix>0" + ".json" (Studio appends extension) resolves.
    expected = output_dir / f"{args.start}.json"
    assert expected.exists(), f"Expected {expected} not created — naming convention drifted"

    # Write collection-level stats
    stats = {
        "total_tokens": args.count,
        "morphology_distribution": morph_counts,
        "stain_distribution": stain_counts,
        "organelle_rarity": {
            k: {"count": v, "percent": round(v / args.count * 100, 2)}
            for k, v in sorted(organelle_counts.items(), key=lambda x: -x[1])
        },
    }
    with open(output_dir / "_collection_stats.json", "w") as f:
        json.dump(stats, f, indent=2)

    print(f"\nDone. {args.count} metadata files written to {output_dir}/")
    print(f"Collection stats → {output_dir}/_collection_stats.json")


if __name__ == "__main__":
    main()
