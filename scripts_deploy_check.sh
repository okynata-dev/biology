#!/usr/bin/env bash
# Deploy preflight for the Bioms worker.
#
# Catches the things that have actually bitten before:
#   - wrangler.toml shipped with the D1 placeholder UUID
#   - schema.sql or migrations changed without being run against --remote
#   - worker.js syntax error (a stray comma sends conjugate to 500)
#   - missing required secrets in the *running* worker env
#
# Usage:
#   bash scripts_deploy_check.sh           # preflight only
#   bash scripts_deploy_check.sh --deploy  # preflight + wrangler deploy on success
#
# Exits non-zero on any check failure. Safe to wire into a Makefile or
# git pre-push hook.

set -euo pipefail

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

fail=0

# 1. wrangler.toml — D1 placeholder must be replaced.
if grep -q 'PASTE_REAL_UUID_FROM_wrangler_d1_create' wrangler.toml; then
  red "✗ wrangler.toml still contains the D1 placeholder UUID."
  red "  Run: wrangler d1 create bioms-lab"
  red "  Paste the printed database_id into wrangler.toml [[d1_databases]]"
  fail=1
else
  green "✓ wrangler.toml D1 id is set"
fi

# 2. worker.js — must parse as JS (caught a comma-eating typo once).
if node --check worker.js > /dev/null 2>&1; then
  green "✓ worker.js parses"
else
  red "✗ worker.js syntax error:"
  node --check worker.js || true
  fail=1
fi

# 3. Migrations — list any files that exist locally but might not have
#    been run. We can't query D1 from here without a key, but we can at
#    least show what's pending so the operator decides.
if [ -d migrations ]; then
  yellow "ℹ Migrations on disk (run each with: wrangler d1 execute bioms-lab --file=... --remote):"
  ls -1 migrations/*.sql 2>/dev/null | sed 's/^/    /' || echo "    (none)"
fi

# 4. Secrets — wrangler can list the *names* of bound secrets without
#    leaking values. Required for prod; optional ones get a soft note.
#    Use whichever wrangler is available (global or via npx).
wrangler_cmd=""
if command -v wrangler >/dev/null 2>&1; then wrangler_cmd="wrangler"
elif command -v npx >/dev/null 2>&1; then wrangler_cmd="npx wrangler"
fi
if [ -n "$wrangler_cmd" ]; then
  secrets=$($wrangler_cmd secret list 2>/dev/null || echo '[]')
  required_missing=()
  for k in ALCHEMY_KEY; do
    if ! echo "$secrets" | grep -q "\"$k\""; then required_missing+=("$k"); fi
  done
  optional_missing=()
  for k in CONTRACT_ADDRESS OPENSEA_API_KEY WAITLIST_IP_SALT; do
    if ! echo "$secrets" | grep -q "\"$k\""; then optional_missing+=("$k"); fi
  done
  if [ ${#required_missing[@]} -gt 0 ]; then
    red   "✗ Missing required secrets: ${required_missing[*]}"
    red   "  Set each with: echo \"<value>\" | wrangler secret put <NAME>"
    fail=1
  else
    green "✓ Required secrets present (ALCHEMY_KEY)"
  fi
  if [ ${#optional_missing[@]} -gt 0 ]; then
    yellow "ℹ Optional secrets not set (OK pre-mint): ${optional_missing[*]}"
  fi
else
  yellow "ℹ Neither wrangler nor npx on PATH; skipping secret check"
fi

if [ $fail -ne 0 ]; then
  red "Preflight failed — fix the items above before deploying."
  exit 1
fi
green "Preflight OK."

if [ "${1:-}" = "--deploy" ]; then
  # Prefer global wrangler if installed; otherwise fall back to npx
  # (which works without a global install). Most contributors won't
  # have wrangler on PATH globally.
  if command -v wrangler >/dev/null 2>&1; then
    yellow "Running: wrangler deploy"
    wrangler deploy
  else
    yellow "Running: npx wrangler deploy"
    npx wrangler deploy
  fi
fi
