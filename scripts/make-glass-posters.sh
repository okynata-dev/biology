#!/usr/bin/env bash
# Poster stills for OpenSea `image` — a mid-loop frame of each glass mp4,
# 1080px webp. Run after the loops are rendered.
#
#   bash scripts/make-glass-posters.sh            # all in loops/
#   bash scripts/make-glass-posters.sh 11 25 46   # specific ids
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p posters

files=()
if [ "$#" -gt 0 ]; then
  for id in "$@"; do files+=("loops/glass-$(printf '%03d' "$id").mp4"); done
else
  files=(loops/glass-[0-9][0-9][0-9].mp4)
fi

n=0
for f in "${files[@]}"; do
  [ -f "$f" ] || { echo "skip (missing): $f"; continue; }
  nnn=$(basename "$f" .mp4 | sed 's/^glass-//')
  ffmpeg -y -ss 1 -i "$f" -frames:v 1 -vf "scale=1080:1080:flags=lanczos" \
    -c:v libwebp -quality 90 "posters/glass-$nnn.webp" \
    >/dev/null 2>&1
  n=$((n+1))
done
echo "wrote $n poster(s) -> posters/"
