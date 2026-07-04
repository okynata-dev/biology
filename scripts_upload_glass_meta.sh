#!/usr/bin/env bash
# Upload glass metadata + poster images to R2 (bioms-pngs).
#   meta/glass/<id>.json  ->  glass-meta/<id>        (application/json)
#   posters/glass-<NNN>.webp -> glass-img/<NNN>.webp (image/webp)
#
# Keys have no .json extension so a contract baseURI of
#   https://pngs.thebioms.com/glass-meta/
# resolves tokenURI = baseURI + tokenId directly.
#
#   bash scripts_upload_glass_meta.sh            # everything
#   bash scripts_upload_glass_meta.sh 11 25 46   # specific ids
#
# Requires wrangler auth (CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID).
set -euo pipefail
cd "$(dirname "$0")"
BUCKET="bioms-pngs"
CC="public, max-age=300"            # short cache: metadata may be re-pointed

ids=()
if [ "$#" -gt 0 ]; then ids=("$@"); else
  for f in meta/glass/*.json; do ids+=("$(basename "$f" .json)"); done
fi

n=0
for id in "${ids[@]}"; do
  j="meta/glass/${id}.json"
  [ -f "$j" ] || { echo "skip meta (missing): $j"; continue; }
  npx wrangler@4 r2 object put "$BUCKET/glass-meta/${id}" --file="$j" \
    --content-type=application/json --cache-control="$CC" --remote
  p="posters/glass-$(printf '%03d' "$id").webp"
  if [ -f "$p" ]; then
    npx wrangler@4 r2 object put "$BUCKET/glass-img/$(printf '%03d' "$id").webp" --file="$p" \
      --content-type=image/webp --cache-control="public, max-age=31536000, immutable" --remote
  fi
  n=$((n+1))
done
echo "uploaded metadata for $n token(s) -> r2://$BUCKET/glass-meta/ (+ glass-img/)"
