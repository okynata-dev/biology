// make-glass-metadata.mjs — ERC-721 metadata for the 500 glass bioms.
//
// Pulls traitsFor() straight out of glass-500.html (single source of truth,
// pure JS — no THREE needed for traits) and emits one JSON per token plus a
// combined manifest. animation_url points at the R2 mp4 loop; image at the
// poster still (see make-glass-posters.sh).
//
//   node scripts/make-glass-metadata.mjs
//
// Output: meta/glass/<id>.json  +  meta/glass-manifest.json

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT = path.join(ROOT, "meta", "glass");
fs.mkdirSync(OUT, { recursive: true });

// ---- lift the trait engine out of the page ----
const html = fs.readFileSync(path.join(ROOT, "glass-500.html"), "utf8");
const mod = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
const a = mod.indexOf("const TOTAL=500;");
const marker = "return t;\n}";
const b = mod.indexOf(marker, a) + marker.length;
const { TOTAL, traitsFor } = new Function(mod.slice(a, b) + "\nreturn {TOTAL, traitsFor};")();

// ---- presentation ----
const COLLECTION = "Bioms · Glass";
const IMG_BASE = "https://pngs.thebioms.com/glass-img"; // poster stills (.webp)
const MP4_BASE = "https://pngs.thebioms.com/glass";     // seamless loop mp4s
const LIVE_BASE = "https://thebioms.com/glass-500.html"; // real-time renderer

const pretty = s => String(s).split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");
const pad = id => String(id).padStart(3, "0");

// which traits become on-chain attributes, in display order
const ATTRS = [
  ["Form", "form"], ["Surface", "surface"], ["Pattern", "pattern"],
  ["Appendage", "appendage"], ["Spines", "spines"], ["Shells", "shells"],
  ["Stain", "stain"], ["Light", "light"], ["Iridescence", "irid"],
  ["Nucleus", "nucleus"], ["Anomaly", "anomaly"], ["Tier", "tier"],
];

const DESC =
  "A microorganism cast in living glass — grown from a single seed and rendered in real time. " +
  "Refraction, iridescence and a slow breath are computed in the browser, never baked. One of 500 in Bioms · Glass.";

const manifest = [];
for (let id = 1; id <= TOTAL; id++) {
  const t = traitsFor(id);
  const p = pad(id);
  const meta = {
    name: `${COLLECTION} #${id}`,
    description: DESC,
    image: `${IMG_BASE}/${p}.jpg`,
    animation_url: `${MP4_BASE}/${p}.mp4`,
    external_url: `${LIVE_BASE}?id=${id}&token=1`,
    attributes: ATTRS.map(([label, key]) => ({ trait_type: label, value: pretty(t[key]) })),
  };
  fs.writeFileSync(path.join(OUT, `${id}.json`), JSON.stringify(meta, null, 2));
  manifest.push({ id, tier: t.tier, ...Object.fromEntries(ATTRS.map(([, k]) => [k, t[k]])) });
}
fs.writeFileSync(path.join(ROOT, "meta", "glass-manifest.json"), JSON.stringify(manifest, null, 2));

// quick distribution readout
const tiers = {};
for (const m of manifest) tiers[m.tier] = (tiers[m.tier] || 0) + 1;
console.log(`wrote ${TOTAL} token JSONs -> meta/glass/  + manifest`);
console.log("tiers:", tiers);
