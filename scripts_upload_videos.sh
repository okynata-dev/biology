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
set -o pipefail   # ← critical: without this, a wrangler failure piped
                  # through grep|head silently returned 0 and CI thought
                  # uploads succeeded when they hadn't.

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
  # No grep|head filtering — that masked real wrangler errors and made
  # the previous CI run report success while uploading zero files.
  #
  # Plain `wrangler` (no `npx`) — relies on the workflow pre-installing
  # it once. With npx, every parallel call did its own npm fetch AND
  # boot of a fresh workerd runtime; the runtimes shared a SQLite cache
  # and tripped each other on SQLITE_BUSY locks.
  #
  # --local false: wrangler 4.x defaults `r2 object put` to a LOCAL
  # mock bucket. The hint message says --remote but that flag doesn't
  # exist; --local false is the real toggle.
  #
  # 3 retries with exponential backoff: previous CI run died on a
  # single transient `502: Bad Gateway` from the R2 API, which under
  # set -e aborted the rest of the chunk (~280 files unsaved). Cloud
  # APIs hit transient 5xx all the time — that's not a "stop everything"
  # event.
  local attempt
  for attempt in 1 2 3; do
    if wrangler r2 object put "${BUCKET}/video/${base}" \
         --file="$file" --content-type="video/mp4" --local false >&2; then
      echo "OK: ${base}"
      return 0
    fi
    if [ "$attempt" -lt 3 ]; then
      local sleep_for=$((attempt * 5))
      echo "RETRY ${attempt}/3: ${base} (sleeping ${sleep_for}s)" >&2
      sleep "$sleep_for"
    fi
  done
  echo "FAILED after 3 attempts: ${base}" >&2
  return 1
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

# Parallelism dropped from -P 8 to -P 1: each `wrangler r2 object put`
# spins up a workerd runtime that holds a SQLite cache, and 8 of them
# stepping on each other deadlock with SQLITE_BUSY. Sequential is
# ~8 min/chunk overhead — acceptable next to the ~50 min render.
echo "Uploading ${#files[@]} files to ${BUCKET}/video/ (sequential, SQLite-safe) …"
printf '%s\n' "${files[@]}" | xargs -P 1 -I{} bash -c 'upload_one "$@"' _ {}

echo "Done. Verify with: curl -I https://pngs.thebioms.com/video/00044.mp4"
