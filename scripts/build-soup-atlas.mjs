#!/usr/bin/env node
/**
 * scripts/build-soup-atlas.mjs
 *
 * Build the texture atlas consumed by /soup. Downloads all 3000 biom
 * thumbnails from R2, composites them into a single grid image, encodes
 * to WebP, writes to ./atlas-out/.
 *
 * Layout: 64 cols × 48 rows = 3072 slots, each 64×64 px → final atlas
 * 4096×3072 px. WebP at quality 85 ends up ~3-6 MB — one HTTP request
 * worth on prod.
 *
 * Usage:
 *   npm install sharp
 *   node scripts/build-soup-atlas.mjs
 *
 *   # then upload to R2:
 *   npx wrangler r2 object put bioms-pngs/atlas/v1.webp \
 *     --file=atlas-out/v1.webp \
 *     --content-type=image/webp \
 *     --cache-control="public, max-age=31536000, immutable"
 *
 * Re-runs are idempotent — outputs always overwrite. Versioning is
 * baked into the R2 key (v1, v2…) so the soup shader can cache-bust
 * by bumping ATLAS_VERSION on the frontend.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// sharp is the only runtime dep — installs natively, no compile step needed
let sharp;
try {
  sharp = (await import('sharp')).default;
} catch (e) {
  console.error('Missing dep: install with `npm install sharp` (one-time).');
  process.exit(1);
}

// === Tunables ===
const TOTAL_BIOMS = 3000;
const COLS = 64;
const ROWS = 48;             // 64 × 48 = 3072 slots, leaves 72 spare
const TILE = 64;             // px per slot in the atlas
const ATLAS_W = COLS * TILE; // 4096
const ATLAS_H = ROWS * TILE; // 3072
const SRC_URL_BASE = 'https://pngs.thebioms.com/thumb';
const SRC_EXT = 'webp';      // R2 has both .webp and .png — webp is smaller, atlas re-encodes anyway
const CONCURRENCY = 24;      // parallel downloads (R2 handles this fine)
const QUALITY = 85;          // WebP encode quality — 85 is sweet spot for thumbs
const ATLAS_VERSION = 'v1';
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'atlas-out');

await fs.mkdir(OUT_DIR, { recursive: true });

console.log(`Building atlas: ${COLS}×${ROWS} grid × ${TILE}px = ${ATLAS_W}×${ATLAS_H}`);
console.log(`Source: ${SRC_URL_BASE}/{00000..${String(TOTAL_BIOMS - 1).padStart(5, '0')}}.${SRC_EXT}`);
console.log('');

// === Download all thumbs (with bounded concurrency) ===
const buffers = new Array(TOTAL_BIOMS).fill(null);
const failed = [];

async function downloadOne(tokenId) {
  const padded = String(tokenId).padStart(5, '0');
  const url = `${SRC_URL_BASE}/${padded}.${SRC_EXT}`;
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    buffers[tokenId] = buf;
  } catch (e) {
    failed.push({ tokenId, reason: e.message });
  }
}

async function runWithConcurrency(items, fn, concurrency) {
  let idx = 0;
  let completed = 0;
  const lastLogged = { v: 0 };
  async function worker() {
    while (idx < items.length) {
      const myIdx = idx++;
      await fn(items[myIdx]);
      completed++;
      if (completed - lastLogged.v >= 100 || completed === items.length) {
        lastLogged.v = completed;
        process.stdout.write(`\rDownloaded ${completed}/${items.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  process.stdout.write('\n');
}

console.log(`Downloading ${TOTAL_BIOMS} thumbs (concurrency: ${CONCURRENCY})…`);
const t0 = Date.now();
await runWithConcurrency(
  Array.from({ length: TOTAL_BIOMS }, (_, i) => i),
  downloadOne,
  CONCURRENCY
);
console.log(`Downloads done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
if (failed.length) {
  console.warn(`⚠️  ${failed.length} downloads failed:`);
  failed.slice(0, 10).forEach(f => console.warn(`   #${f.tokenId}: ${f.reason}`));
  if (failed.length > 10) console.warn(`   ... and ${failed.length - 10} more`);
}

// === Resize each tile to exactly TILE×TILE ===
console.log(`\nResizing ${TOTAL_BIOMS} tiles to ${TILE}×${TILE}…`);
const t1 = Date.now();
const resized = new Array(TOTAL_BIOMS).fill(null);
await runWithConcurrency(
  Array.from({ length: TOTAL_BIOMS }, (_, i) => i),
  async (tokenId) => {
    if (!buffers[tokenId]) return;
    try {
      // ensureAlpha() — some source thumbs are RGB, others RGBA.
      // Composite needs ALL inputs to be 4-channel RGBA or it bails
      // with "VipsImage: memory area too small". Force 4 channels.
      resized[tokenId] = await sharp(buffers[tokenId])
        .resize(TILE, TILE, { fit: 'cover', kernel: 'lanczos3' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    } catch (e) {
      console.warn(`Resize failed for #${tokenId}: ${e.message}`);
    }
  },
  CONCURRENCY
);
console.log(`Resize done in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

// === Composite into a single atlas ===
// sharp.composite takes pre-rasterized RGBA buffers and pastes them at
// pixel offsets. We build a blank canvas of the full atlas size and
// composite each tile at its grid position.
console.log(`\nCompositing ${TOTAL_BIOMS} tiles into ${ATLAS_W}×${ATLAS_H} atlas…`);
const t2 = Date.now();

// Start with a transparent canvas. Areas with no biom (the last 72 slots
// since 3000 < 3072) stay transparent — fragment shader can ignore them.
const blank = await sharp({
  create: {
    width: ATLAS_W,
    height: ATLAS_H,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .png()
  .toBuffer();

const compositeOps = [];
for (let i = 0; i < TOTAL_BIOMS; i++) {
  if (!resized[i]) continue;
  const col = i % COLS;
  const row = Math.floor(i / COLS);
  compositeOps.push({
    input: resized[i].data,
    raw: {
      width: resized[i].info.width,
      height: resized[i].info.height,
      channels: 4,
    },
    left: col * TILE,
    top:  row * TILE,
  });
}

const atlasBuffer = await sharp(blank)
  .composite(compositeOps)
  .webp({ quality: QUALITY, effort: 6 })
  .toBuffer();

console.log(`Composite done in ${((Date.now() - t2) / 1000).toFixed(1)}s`);

const outPath = path.join(OUT_DIR, `${ATLAS_VERSION}.webp`);
await fs.writeFile(outPath, atlasBuffer);
console.log(`\n✅ Wrote ${outPath}`);
console.log(`   size: ${(atlasBuffer.length / 1024 / 1024).toFixed(2)} MB`);
console.log(`   tiles: ${TOTAL_BIOMS} / ${COLS * ROWS} slots`);
console.log(`   downloads failed: ${failed.length}`);
console.log('');
console.log('Next: upload to R2:');
console.log(`  npx wrangler r2 object put bioms-pngs/atlas/${ATLAS_VERSION}.webp \\`);
console.log(`    --file=${outPath} \\`);
console.log(`    --content-type=image/webp \\`);
console.log(`    --cache-control="public, max-age=31536000, immutable"`);
console.log('');
console.log('Then bump ATLAS_VERSION in soup.html if needed and push.');
