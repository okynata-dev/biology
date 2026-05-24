#!/usr/bin/env bash
# Upload pngs/video/ → R2 bucket bioms-pngs/video/.
#
# Uses wrangler r2 object put with Content-Type: video/mp4. Each MP4 is
# ~1 MB at 15s/1080p so the upload itself runs faster than the wrangler
# startup overhead — parallelism (-P 8) is mostly hiding that overhead.
# Total upload time for 3000 files is ~10-15 min on a typical home
# connection.
#
# Usage:
#   bash scripts_upload_videos.sh               # upload everything in pngs/video/
#   bash scripts_upload_videos.sh --only 44 132 # specific seeds

set -e

BUCKET="${BIOMS_R2_BUCKET:-bioms-pngs}"
DIR="pngs/video"

if [ ! -d "$DIR" ]; then
  echo "Error: $DIR doesn't exist. Run scripts/make-videos.py first." >&2
  exit 1
fi

ONLY_SEEDS=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --only) shift; while [ "$#" -gt 0 ] && [[ "$1" =~ ^[0-9]+$ ]]; do ONLY_SEEDS+=("$1"); shift; done ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

upload_one() {
  local file="$1"
  local base=$(basename "$file")
  npx wrangler r2 object put "${BUCKET}/video/${base}" \
    --file="$file" --content-type="video/mp4" 2>&1 \
    | grep -E "Creating|Error|Upload" | head -1
}
export -f upload_one
export BUCKET

if [ "${#ONLY_SEEDS[@]}" -gt 0 ]; then
  files=()
  for seed in "${ONLY_SEEDS[@]}"; do
    padded=$(printf "%05d" "$seed")
    [ -f "$DIR/${padded}.mp4" ] && files+=("$DIR/${padded}.mp4")
  done
else
  files=()
  while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$DIR" -maxdepth 1 -name '*.mp4' -print0)
fi

echo "Uploading ${#files[@]} files to ${BUCKET}/video/ (parallel -P 8) …"
printf '%s\n' "${files[@]}" | xargs -P 8 -I{} bash -c 'upload_one "$@"' _ {}

echo "Done. Verify with: curl -I https://pngs.thebioms.com/video/00044.mp4"
