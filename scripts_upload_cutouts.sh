#!/usr/bin/env bash
# Upload pngs/cutout/ → R2 bucket bioms-pngs/cutout/.
#
# Uses wrangler r2 object put. Single-file at a time but parallelised
# via xargs -P. Each wrangler call has ~2-3s startup overhead, so total
# upload time for 3000 files is ~5-10 minutes at -P 12.
#
# Usage:
#   bash scripts_upload_cutouts.sh                # upload all .webp + .png
#   bash scripts_upload_cutouts.sh --webp-only    # webp only (smaller)
#   bash scripts_upload_cutouts.sh --only 44 132  # specific seeds

set -e

BUCKET="${BIOMS_R2_BUCKET:-bioms-pngs}"
DIR="pngs/cutout"

if [ ! -d "$DIR" ]; then
  echo "Error: $DIR doesn't exist. Run scripts/make-cutouts.py first." >&2
  exit 1
fi

WEBP_ONLY=0
ONLY_SEEDS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --webp-only) WEBP_ONLY=1; shift ;;
    --only) shift; while [ "$#" -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]]; do ONLY_SEEDS+=("$1"); shift; done ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

upload_one() {
  local file="$1"
  local base=$(basename "$file")
  local ext="${base##*.}"
  npx wrangler r2 object put "${BUCKET}/cutout/${base}" \
    --file="$file" --content-type="image/${ext}" --remote 2>&1 \
    | grep -E "Creating|Error|✓" | head -1
}
export -f upload_one
export BUCKET

# Build the file list
if [ "${#ONLY_SEEDS[@]}" -gt 0 ]; then
  files=()
  for seed in "${ONLY_SEEDS[@]}"; do
    padded=$(printf "%05d" "$seed")
    [ "$WEBP_ONLY" -eq 0 ] && [ -f "$DIR/${padded}.png"  ] && files+=("$DIR/${padded}.png")
    [ -f "$DIR/${padded}.webp" ] && files+=("$DIR/${padded}.webp")
  done
else
  if [ "$WEBP_ONLY" -eq 1 ]; then
    mapfile -t files < <(ls "$DIR"/*.webp 2>/dev/null)
  else
    mapfile -t files < <(ls "$DIR"/*.{png,webp} 2>/dev/null)
  fi
fi

echo "Uploading ${#files[@]} files to ${BUCKET}/cutout/ (parallel -P 12) …"
printf '%s\n' "${files[@]}" | xargs -P 12 -I{} bash -c 'upload_one "$@"' _ {}

echo "Done. Verify with: curl -I https://pngs.thebioms.com/cutout/00044.webp"
