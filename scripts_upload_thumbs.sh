#!/usr/bin/env bash
# Upload generated thumbnails to R2 bucket.
#
# Prereq: scripts_make_thumbs.py has been run and pngs/thumb/ is full.
# Uses wrangler. Each upload is one CLI call so this is slow — for
# 3000 seeds × 2 formats = 6000 files, this takes ~30-60 minutes.
#
# Faster alternatives if you have many to upload:
#   - rclone with R2 S3 endpoint (parallel uploads)
#   - aws cli with R2 S3 endpoint (parallel uploads)
#   - Cloudflare R2 dashboard bulk upload
#
# Usage:
#   bash scripts_upload_thumbs.sh                # upload all
#   bash scripts_upload_thumbs.sh 44 132 247    # only specific seeds
#
# Note: bucket name is the R2 bucket name in your Cloudflare dashboard,
# NOT the custom domain. Custom domain (pngs.thebioms.com) just maps
# to the bucket; uploads go to the bucket name directly.

set -e

BUCKET="${BIOMS_R2_BUCKET:-bioms-pngs}"  # actual R2 bucket name (custom domain: pngs.thebioms.com)
THUMB_DIR="pngs/thumb"

if [ ! -d "$THUMB_DIR" ]; then
  echo "Error: $THUMB_DIR doesn't exist. Run scripts_make_thumbs.py first." >&2
  exit 1
fi

upload_one() {
  local seed="$1"
  local padded
  printf -v padded "%05d" "$seed"
  for ext in webp png; do
    local f="$THUMB_DIR/${padded}.${ext}"
    if [ -f "$f" ]; then
      echo "  → thumb/${padded}.${ext}"
      npx wrangler r2 object put "${BUCKET}/thumb/${padded}.${ext}" \
        --file="$f" --content-type="image/${ext}" --remote
    fi
  done
}

if [ "$#" -gt 0 ]; then
  # Upload specific seeds.
  for seed in "$@"; do upload_one "$seed"; done
else
  # Upload all 3000.
  for seed in $(seq 0 2999); do upload_one "$seed"; done
fi

echo "Done. Verify with: curl -I https://pngs.thebioms.com/thumb/00044.webp"
