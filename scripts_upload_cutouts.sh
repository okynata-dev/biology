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
set -o pipefail   # ← without this, a wrangler failure piped through
                  # grep|head silently returned 0 and the previous run
                  # uploaded zero files while reporting success.

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
  # IMPORTANT: --remote forces the write to the REAL R2 bucket. Without it,
  # wrangler writes to a throwaway LOCAL persistence store and the upload
  # silently never reaches R2 (this bit us: files showed "Creating object…"
  # but R2 kept serving the old objects). Plain `wrangler` (no `npx`) —
  # relies on the workflow pre-installing wrangler@4 globally before this
  # script runs; with npx, every parallel call did its own npm fetch and
  # the workerd runtimes tripped each other on SQLite locks.
  #
  # 3-attempt retry with exponential backoff: previous runs died on a
  # single transient 5xx from the R2 API. No more `| grep | head` —
  # pipefail can't save us if the entire pipe rewrites the exit code,
  # so just log wrangler's stderr/stdout straight and let return codes
  # propagate.
  local attempt
  for attempt in 1 2 3; do
    if wrangler r2 object put "${BUCKET}/cutout/${base}" \
         --remote --file="$file" --content-type="image/${ext}" >&2; then
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

# Build the file list
if [ "${#ONLY_SEEDS[@]}" -gt 0 ]; then
  files=()
  for seed in "${ONLY_SEEDS[@]}"; do
    padded=$(printf "%05d" "$seed")
    [ "$WEBP_ONLY" -eq 0 ] && [ -f "$DIR/${padded}.png"  ] && files+=("$DIR/${padded}.png")
    [ -f "$DIR/${padded}.webp" ] && files+=("$DIR/${padded}.webp")
  done
else
  # macOS ships bash 3.2 which lacks mapfile/readarray — use a portable
  # while-read into the array instead. Null-delimited so filenames with
  # spaces or special chars don't break the split.
  files=()
  if [ "$WEBP_ONLY" -eq 1 ]; then
    while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$DIR" -maxdepth 1 -name '*.webp' -print0)
  else
    while IFS= read -r -d '' f; do files+=("$f"); done < <(find "$DIR" -maxdepth 1 \( -name '*.png' -o -name '*.webp' \) -print0)
  fi
fi

# Parallelism dropped from -P 12 to -P 1: each `wrangler r2 object put`
# spins up a workerd runtime that holds a SQLite cache, and parallel
# instances deadlock on SQLITE_BUSY. Sequential adds ~5min overhead but
# eliminates silent upload failures — better than re-running the workflow
# four times to brute-force past the flake rate.
echo "Uploading ${#files[@]} files to ${BUCKET}/cutout/ (sequential, SQLite-safe) …"

# Capture xargs exit code instead of letting `set -e` kill the script on
# the first hard failure (xargs returns 123 if ANY child upload_one fails
# after its 3 retries). Reality: even with 99% success, one bad seed in
# 3000 trips this — and the previous build of this script killed the
# whole chunk after xargs, masking the fact that 1999 of 2000 files
# uploaded fine. Now we log the failure count and exit 0 unless the
# whole chunk imploded.
xargs_rc=0
printf '%s\n' "${files[@]}" | xargs -P 1 -I{} bash -c 'upload_one "$@"' _ {} || xargs_rc=$?

if [ "$xargs_rc" -ne 0 ]; then
  echo ""
  echo "WARNING: xargs exited $xargs_rc — at least one upload failed after 3 retries."
  echo "Failed files are tagged 'FAILED after 3 attempts:' in the log above."
  echo "Re-run with --only <seeds> to retry only those. The successful uploads landed."
fi

echo "Done. Verify with: curl -I https://pngs.thebioms.com/cutout/00044.webp"
