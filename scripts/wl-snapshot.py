#!/usr/bin/env python3
"""
wl-snapshot.py — quality-filter the waitlist into a clean allowlist.

Run this the day before mint (June 4). It pulls every address from the
worker's admin endpoint, then for each one checks via Alchemy:
  - wallet age (days since first transaction)
  - total transaction count
  - whether it's a contract (filter out)
  - whether it has any ETH activity at all

Addresses that pass all gates land in `wl-clean.txt` — one address per
line, ready to feed into the Merkle tree generator (snapshot.js / npm
package merkletreejs, etc).

The default gates:
  - age >= 60 days
  - txCount >= 5
  - not a contract
  - balance > 0 ETH OR has at least one outbound tx

Why these? Bots create wallets in batches the day before a target
mint. A 60-day-old wallet with 5+ transactions is either a real
human or a SOPHISTICATED bot that planned 2+ months ahead — which
isn't worth their margin on a $25 mint.

Adjust thresholds via flags. Pass --dry-run first to see the cull
rate without writing anything.

Usage:
    # Default gates, write wl-clean.txt
    python3 scripts/wl-snapshot.py --admin-token "$ADMIN_TOKEN"

    # Stricter (90 days, 10 txs)
    python3 scripts/wl-snapshot.py --admin-token "$ADMIN_TOKEN" \\
        --min-age-days 90 --min-tx-count 10

    # See what would happen without writing
    python3 scripts/wl-snapshot.py --admin-token "$ADMIN_TOKEN" --dry-run

The Alchemy NFT key already in the worker is reused — the script reads
it from --alchemy-key or ALCHEMY_KEY env. NFT v2 / Core API both work
for the asset-transfers + getCode RPC calls used here.

Output files:
    wl-clean.txt          — addresses that passed every filter
    wl-rejected.csv       — full audit log of rejections, with reasons
    wl-summary.txt        — counts + thresholds applied, for the runbook
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone


# ---------------------------------------------------------------------------
# Alchemy RPC helpers
# ---------------------------------------------------------------------------
def alchemy_rpc(api_key: str, method: str, params: list, retries: int = 3):
    """Single JSON-RPC call to Alchemy mainnet. Retries on transient 5xx,
    treats 429 as "back off and try again". Returns the `result` field."""
    url = f"https://eth-mainnet.g.alchemy.com/v2/{api_key}"
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    last_err = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=15) as r:
                resp = json.loads(r.read())
                if "error" in resp:
                    last_err = resp["error"]
                    # Some errors are permanent (bad params); don't retry.
                    code = resp["error"].get("code", 0)
                    if code in (-32602, -32601):
                        return None
                    time.sleep(0.5 * (attempt + 1))
                    continue
                return resp.get("result")
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(2 * (attempt + 1))
                continue
            if 500 <= e.code < 600:
                time.sleep(1 * (attempt + 1))
                continue
            last_err = str(e)
            return None
        except (urllib.error.URLError, TimeoutError) as e:
            last_err = str(e)
            time.sleep(1 * (attempt + 1))
            continue
    return None


def is_contract(api_key: str, address: str) -> bool:
    """eth_getCode returns "0x" for EOAs, contract bytecode for contracts."""
    code = alchemy_rpc(api_key, "eth_getCode", [address, "latest"])
    if code is None:
        # Treat fetch failure as "unknown" — don't auto-reject.
        return False
    return code != "0x"


def get_first_tx_timestamp(api_key: str, address: str) -> int | None:
    """Returns Unix-ts of the address's first outbound tx, or None if no txs
    or fetch failed. Uses alchemy_getAssetTransfers with order=asc, maxCount=1."""
    params = [{
        "fromAddress": address,
        "category": ["external", "internal", "erc20", "erc721", "erc1155"],
        "order": "asc",
        "maxCount": "0x1",
        "withMetadata": True,
    }]
    result = alchemy_rpc(api_key, "alchemy_getAssetTransfers", params)
    if not result or not result.get("transfers"):
        return None
    first = result["transfers"][0]
    ts_iso = first.get("metadata", {}).get("blockTimestamp")
    if not ts_iso:
        return None
    try:
        dt = datetime.fromisoformat(ts_iso.replace("Z", "+00:00"))
        return int(dt.timestamp())
    except ValueError:
        return None


def get_tx_count(api_key: str, address: str) -> int:
    """eth_getTransactionCount returns the nonce — equivalent to the count of
    OUTBOUND txs the address has signed. Doesn't count inbound transfers but
    that's fine: bots that only RECEIVE airdrops aren't real users either."""
    nonce_hex = alchemy_rpc(api_key, "eth_getTransactionCount", [address, "latest"])
    if nonce_hex is None:
        return 0
    try:
        return int(nonce_hex, 16)
    except ValueError:
        return 0


# ---------------------------------------------------------------------------
# Waitlist pull from the worker admin endpoint
# ---------------------------------------------------------------------------
def fetch_waitlist(api_origin: str, admin_token: str) -> list[dict]:
    """Pulls the full waitlist from /api/admin/waitlist?format=json. Returns
    a list of {id, kind, value, ts} dicts. Validates the token-gate."""
    url = f"{api_origin}/api/admin/waitlist?token={admin_token}&limit=100000"
    try:
        with urllib.request.urlopen(url, timeout=30) as r:
            data = json.loads(r.read())
            return data.get("waitlist", [])
    except urllib.error.HTTPError as e:
        if e.code == 403:
            print("ERROR: ADMIN_TOKEN rejected. Check the secret in wrangler.", file=sys.stderr)
        else:
            print(f"ERROR: waitlist fetch failed: HTTP {e.code}", file=sys.stderr)
        sys.exit(1)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--admin-token", default=os.environ.get("ADMIN_TOKEN"),
                    help="Worker admin token. Default from $ADMIN_TOKEN.")
    ap.add_argument("--alchemy-key", default=os.environ.get("ALCHEMY_KEY"),
                    help="Alchemy mainnet API key. Default from $ALCHEMY_KEY.")
    ap.add_argument("--api-origin", default="https://api.thebioms.com",
                    help="Worker base URL.")
    ap.add_argument("--min-age-days", type=int, default=60,
                    help="Reject wallets younger than N days (default 60). "
                         "Computed from first outbound tx timestamp.")
    ap.add_argument("--min-tx-count", type=int, default=5,
                    help="Reject wallets with fewer than N outbound txs (default 5).")
    ap.add_argument("--reject-contracts", action="store_true", default=True,
                    help="Reject addresses that have contract code (default true).")
    ap.add_argument("--dry-run", action="store_true",
                    help="Show counts only, don't write output files.")
    ap.add_argument("--out-clean", default="wl-clean.txt")
    ap.add_argument("--out-rejected", default="wl-rejected.csv")
    ap.add_argument("--out-summary", default="wl-summary.txt")
    args = ap.parse_args()

    if not args.admin_token:
        print("ERROR: pass --admin-token or set ADMIN_TOKEN env.", file=sys.stderr)
        sys.exit(1)
    if not args.alchemy_key:
        print("ERROR: pass --alchemy-key or set ALCHEMY_KEY env.", file=sys.stderr)
        sys.exit(1)

    print(f"Fetching waitlist from {args.api_origin} …")
    rows = fetch_waitlist(args.api_origin, args.admin_token)
    print(f"  → {len(rows)} addresses on the waitlist")

    if not rows:
        print("Empty waitlist — nothing to filter.")
        return

    print(f"Filtering with thresholds: age>={args.min_age_days}d, txs>={args.min_tx_count}, "
          f"reject_contracts={args.reject_contracts}")
    print("(Alchemy lookups, ~0.3s per address — for 10k addresses this is ~50min.)")
    print()

    now_ts = int(time.time())
    min_age_ts = args.min_age_days * 86400

    clean = []
    rejected = []  # (address, reason, detail)
    counts = {"contract": 0, "no_history": 0, "too_young": 0, "too_few_txs": 0, "fetch_fail": 0}

    for i, row in enumerate(rows):
        addr = row.get("value", "").strip().lower()
        if not addr.startswith("0x") or len(addr) != 42:
            rejected.append((addr, "invalid_format", row.get("value")))
            continue

        # Contract check
        if args.reject_contracts and is_contract(args.alchemy_key, addr):
            counts["contract"] += 1
            rejected.append((addr, "contract", "has bytecode"))
            continue

        # Tx count check (cheap RPC, do first)
        tx_count = get_tx_count(args.alchemy_key, addr)
        if tx_count < args.min_tx_count:
            counts["too_few_txs"] += 1
            rejected.append((addr, "too_few_txs", f"nonce={tx_count}"))
            continue

        # Age check (more expensive RPC, do after cheap gates)
        first_ts = get_first_tx_timestamp(args.alchemy_key, addr)
        if first_ts is None:
            counts["no_history"] += 1
            rejected.append((addr, "no_history", "no outbound txs found"))
            continue
        age_seconds = now_ts - first_ts
        if age_seconds < min_age_ts:
            counts["too_young"] += 1
            age_days = age_seconds // 86400
            rejected.append((addr, "too_young", f"age={age_days}d"))
            continue

        clean.append(addr)
        if (i + 1) % 100 == 0:
            print(f"  processed {i+1}/{len(rows)}  clean={len(clean)}  rejected={len(rejected)}")

    print()
    print(f"Done. {len(clean)} passed / {len(rejected)} rejected ({len(rejected)/max(1,len(rows))*100:.1f}% cull rate).")
    print("Rejection breakdown:")
    for reason, n in counts.items():
        print(f"  {reason:15s}: {n}")

    if args.dry_run:
        print("\n(dry-run, not writing output files)")
        return

    # Write outputs
    with open(args.out_clean, "w") as f:
        for addr in clean:
            f.write(addr + "\n")
    print(f"\nWrote {args.out_clean} ({len(clean)} addresses)")

    with open(args.out_rejected, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["address", "reason", "detail"])
        for r in rejected:
            w.writerow(r)
    print(f"Wrote {args.out_rejected} ({len(rejected)} rows)")

    with open(args.out_summary, "w") as f:
        f.write(f"WL snapshot generated at {datetime.now(timezone.utc).isoformat()}\n")
        f.write(f"Source: {args.api_origin}\n")
        f.write(f"Total addresses: {len(rows)}\n")
        f.write(f"Clean (passed all gates): {len(clean)}\n")
        f.write(f"Rejected: {len(rejected)}\n")
        f.write(f"\nThresholds applied:\n")
        f.write(f"  min_age_days: {args.min_age_days}\n")
        f.write(f"  min_tx_count: {args.min_tx_count}\n")
        f.write(f"  reject_contracts: {args.reject_contracts}\n")
        f.write(f"\nRejection breakdown:\n")
        for reason, n in counts.items():
            f.write(f"  {reason:15s}: {n}\n")
    print(f"Wrote {args.out_summary}")


if __name__ == "__main__":
    main()
