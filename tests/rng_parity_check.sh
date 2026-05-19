#!/usr/bin/env bash
# RNG parity check — runs both oracles and diffs their output.
#
# Pass: identical canonical JSON across all seeds → exit 0.
# Fail: any divergence → exit 1 with a unified diff so the operator
#       sees exactly which trait drifted on which seed.
#
# Wire into CI (.github/workflows/rng-parity.yml) and optionally a
# pre-push git hook so the bomb can never reach main silently.

set -euo pipefail

cd "$(dirname "$0")/.."

py_out=$(mktemp)
js_out=$(mktemp)
trap 'rm -f "$py_out" "$js_out"' EXIT

if ! python3 tests/rng_parity.py > "$py_out"; then
  echo "✗ Python oracle crashed — fix generate_metadata.py before parity check." >&2
  exit 1
fi

if ! node tests/rng_parity.mjs > "$js_out"; then
  echo "✗ JS oracle crashed — fix specimen-engine.js before parity check." >&2
  exit 1
fi

if diff -u "$py_out" "$js_out"; then
  count=$(python3 -c "import json,sys; print(len(json.load(open('$py_out'))))")
  echo "✓ RNG parity verified across $count seeds — JS ↔ Python identical."
  exit 0
fi

cat >&2 <<'MSG'

✗ RNG parity BROKEN.

The JS engine (specimen-engine.js, used in the browser) and the Python
generator (generate_metadata.py, used at mint time) produced DIFFERENT
trait sets for at least one seed above.

This means: if you mint now, on-chain metadata will not match what
holders actually see rendered. The collection breaks.

To fix:
  1. Find which side drifted (usually whichever you just edited).
  2. Revert that side, OR mirror the change on the other side.
  3. Re-run: bash tests/rng_parity_check.sh

See CLAUDE.md §4.1 for the full 18-step rng() call invariant.
MSG
exit 1
