#!/usr/bin/env bash
# Upload the glass loop mp4s to R2 (bioms-pngs) under the glass/ prefix.
# Served publicly at https://pngs.thebioms.com/glass/<NNN>.mp4
#
#   bash scripts_upload_glass.sh              # upload everything in loops/
#   bash scripts_upload_glass.sh 11 25 46     # only these ids
#
# Requires wrangler auth (same account as the bioms-api worker).
set -euo pipefail
cd "$(dirname "$0")"
BUCKET="bioms-pngs"
CC="public, max-age=31536000, immutable"

files=()
if [ "$#" -gt 0 ]; then
  for id in "$@"; do files+=("loops/glass-$(printf '%03d' "$id").mp4"); done
else
  files=(loops/glass-*.mp4)
fi

n=0
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "skip (missing): $f"; continue; }
  key="glass/$(basename "$f" | sed 's/^glass-//')"   # glass-011.mp4 -> glass/011.mp4
  echo "-> $key ($(du -h "$f" | cut -f1))"
  npx wrangler@4 r2 object put "$BUCKET/$key" --file="$f" \
    --content-type=video/mp4 --cache-control="$CC" --remote
  n=$((n+1))
done
echo "uploaded $n file(s) to r2://$BUCKET/glass/"
