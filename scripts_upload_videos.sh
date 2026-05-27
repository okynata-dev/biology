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
  # --remote: wrangler 4.x defaults `r2 object put` to a LOCAL mock
  # bucket; without --remote the upload silently never reaches R2
  # (you'll see "Upload complete." but the public URL stays 404).
  # `--remote` was reinstated by Cloudflare after a brief absence; if
  # it ever disappears again, `--local false` is the equivalent toggle.
  #
  # 3 retries with exponential backoff: previous CI run died on a
  # single transient `502: Bad Gateway` from the R2 API, which under
  # set -e aborted the rest of the chunk (~280 files unsaved). Cloud
  # APIs hit transient 5xx all the time — that's not a "stop everything"
  # event.
  local attempt
  for attempt in 1 2 3; do
    if wrangler r2 object put "${BUCKET}/video/${base}" \
         --file="$file" --content-type="video/mp4" --remote >&2; then
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

# Capture xargs exit code so `set -e` doesn't kill the chunk on a single
# unrecoverable upload (xargs returns 123 if ANY child upload_one fails
# after its 3 retries). One bad file in 300 shouldn't waste 49 successful
# minutes of render work; the FAILED lines are visible in the log for a
# targeted re-run with --only.
xargs_rc=0
printf '%s\n' "${files[@]}" | xargs -P 1 -I{} bash -c 'upload_one "$@"' _ {} || xargs_rc=$?

if [ "$xargs_rc" -ne 0 ]; then
  echo ""
  echo "WARNING: xargs exited $xargs_rc — at least one upload failed after 3 retries."
  echo "Failed files are tagged 'FAILED after 3 attempts:' in the log above."
fi

echo "Done. Verify with: curl -I https://pngs.thebioms.com/video/00044.mp4"
