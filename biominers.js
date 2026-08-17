/* Biominers — the collection, generated in the browser.
 *
 * This file is a straight port of the Node generator at
 * ~/Desktop/biominers/src/. The trait tables, the weights, the roll order and
 * the render pipeline are identical, so the sprite a visitor sees here is
 * byte-for-byte the sprite the contract points at. If you change one, change
 * both, or the site starts lying about the collection.
 */
(function () {
"use strict";

var R = 64, SUPPLY = 4444, PER = 48;

/* ===================== colour ===================== */
function rng(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hsv(h, s, v) {
  h = ((h % 360) + 360) % 360;
  var c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c, r, g, b;
  if (h < 60) { r = c; g = x; b = 0; } else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; } else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; } else { r = c; g = 0; b = x; }
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
/* hue rotates cool into shadow and warm into light; saturation peaks in the
   middle; brightness climbs with smaller steps at the top */
function ramp(hue, sat, val) {
  var N = 6, o = [];
  sat = sat === undefined ? 1 : sat; val = val === undefined ? 1 : val;
  for (var i = 0; i < N; i++) {
    var t = i / (N - 1), h = hue + (t - 0.5) * 50;
    var s = (0.34 + 0.5 * Math.sin(Math.PI * t)) * (1 - 0.34 * Math.pow(t, 3)) * sat;
    var v = (0.24 + 0.735 * Math.pow(t, 0.72)) * val;
    o.push(hsv(h, Math.max(0.03, Math.min(0.92, s)), Math.max(0, Math.min(0.985, v))));
  }
  return o;
}

/* ===================== geometry ===================== */
function cap(x1, y1, x2, y2, r) { return { x1: x1, y1: y1, x2: x2, y2: y2, r: r }; }
function sph(x, y, r) { return { x1: x, y1: y, x2: x, y2: y, r: r }; }
function capF(px, py, b) {
  var vx = b.x2 - b.x1, vy = b.y2 - b.y1, wx = px - b.x1, wy = py - b.y1;
  var L2 = vx * vx + vy * vy, t = L2 > 0 ? (wx * vx + wy * vy) / L2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  var dx = px - (b.x1 + vx * t), dy = py - (b.y1 + vy * t);
  return { f: 1 - (dx * dx + dy * dy) / (b.r * b.r), dx: dx / b.r, dy: dy / b.r, t: t };
}
var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
var LX = -0.5, LY = -0.6, LZ = 0.62;
(function () { var m = Math.hypot(LX, LY, LZ); LX /= m; LY /= m; LZ /= m; })();

/* ===================== the six axes ===================== */
var SHAPES = [
  { k: "coccus", n: "Coccus", w: 16, family: "sphere", make: function () { return [sph(32, 32, 17)]; } },
  { k: "diplococcus", n: "Diplococcus", w: 12, family: "sphere", make: function () { return [sph(21, 32, 13), sph(43, 32, 13)]; } },
  { k: "streptococcus", n: "Streptococcus", w: 10, family: "chain", make: function () {
      return [sph(12, 40, 9), sph(23, 34, 9), sph(35, 30, 10), sph(47, 33, 9), sph(56, 40, 9)]; } },
  { k: "staphylococcus", n: "Staphylococcus", w: 9, family: "cluster", make: function () {
      return [sph(24, 24, 9), sph(38, 22, 8), sph(46, 33, 9), sph(38, 44, 8), sph(24, 42, 9), sph(16, 33, 8), sph(32, 33, 9)]; } },
  { k: "tetrad", n: "Tetrad", w: 9, family: "cluster", make: function () {
      return [sph(23, 23, 11), sph(42, 23, 11), sph(23, 42, 11), sph(42, 42, 11)]; } },
  { k: "bacillus", n: "Bacillus", w: 16, family: "rod", make: function () { return [cap(21, 32, 43, 32, 11.5)]; } },
  { k: "vibrio", n: "Vibrio", w: 11, family: "rod", make: function () { return [cap(18, 42, 30, 26, 8), cap(30, 26, 46, 22, 8)]; } },
  { k: "spirillum", n: "Spirillum", w: 10, family: "helix", make: function () {
      var a = [];
      for (var t = 0; t < 15; t++) {
        var x = 10 + t * 3.2, y = 32 + Math.sin(t * 0.6) * 12;
        var x2 = 10 + (t + 1) * 3.2, y2 = 32 + Math.sin((t + 1) * 0.6) * 12;
        a.push(cap(x, y, x2, y2, 6.4));
      }
      return a; } },
  { k: "stella", n: "Stella", w: 4, family: "radial", make: function () {
      var a = [sph(32, 32, 9)];
      for (var k = 0; k < 6; k++) { var t = k * Math.PI / 3 + 0.28;
        a.push(cap(32, 32, 32 + Math.cos(t) * 18, 32 + Math.sin(t) * 18, 5)); }
      return a; } }
];
var STAINS = [
  { k: "crystal_violet", n: "Crystal violet", h: 274, s: 1, v: 1, w: 16 },
  { k: "safranin", n: "Safranin", h: 352, s: 0.95, v: 1, w: 16 },
  { k: "carbol_fuchsin", n: "Carbol fuchsin", h: 330, s: 1.05, v: 1, w: 12 },
  { k: "malachite", n: "Malachite", h: 158, s: 0.95, v: 1, w: 12 },
  { k: "methylene", n: "Methylene", h: 214, s: 1, v: 1, w: 12 },
  { k: "auramine", n: "Auramine", h: 50, s: 1.02, v: 1, w: 10 },
  { k: "giemsa", n: "Giemsa", h: 252, s: 0.82, v: 1, w: 10 },
  { k: "sulfur", n: "Sulfur", h: 38, s: 1.05, v: 1, w: 8 },
  /* a negative stain: at full value the low saturation bleaches it away */
  { k: "india_ink", n: "India ink", h: 222, s: 0.2, v: 0.62, w: 4 }
];
var SURFACES = [
  { k: "smooth", n: "Smooth", w: 20 }, { k: "granular", n: "Granular", w: 14 },
  { k: "ridged", n: "Ridged", w: 12 }, { k: "pitted", n: "Pitted", w: 10 },
  { k: "warty", n: "Warty", w: 10, geo: 1 }, { k: "spined", n: "Spined", w: 9, geo: 1 },
  { k: "lattice", n: "Lattice", w: 4 }
];
var APPENDAGES = [
  { k: "none", n: "None", w: 18 }, { k: "mono", n: "Monotrichous", w: 14 },
  { k: "lopho", n: "Lophotrichous", w: 11 }, { k: "amphi", n: "Amphitrichous", w: 10 },
  { k: "peri", n: "Peritrichous", w: 11 }, { k: "fimbriae", n: "Fimbriae", w: 9 }
];
var INCLUSIONS = [
  { k: "none", n: "None", w: 22 }, { k: "nucleoid", n: "Nucleoid", w: 13 },
  { k: "spore", n: "Endospore", w: 9 }
];
var ENVELOPES = [
  { k: "none", n: "None", w: 22 }, { k: "capsule", n: "Capsule", w: 12 },
  { k: "slime", n: "Slime layer", w: 8 }, { k: "sheath", n: "Sheath", w: 5 }
];
var POOLS = {
  sphere:  [{ s: "MRNA", n: "Moderna" }, { s: "BNTX", n: "BioNTech" }],
  chain:   [{ s: "REGN", n: "Regeneron" }, { s: "VRTX", n: "Vertex" }],
  cluster: [{ s: "AMGN", n: "Amgen" }, { s: "GILD", n: "Gilead" }],
  rod:     [{ s: "LLY", n: "Eli Lilly" }, { s: "NVO", n: "Novo Nordisk" }],
  helix:   [{ s: "CRSP", n: "CRISPR Therapeutics" }, { s: "NTLA", n: "Intellia" }],
  radial:  [{ s: "ILMN", n: "Illumina" }, { s: "BIIB", n: "Biogen" }]
};

function addWarts(body, rand) {
  var out = body.slice();
  body.forEach(function (b) {
    var n = 3 + Math.floor(rand() * 3);
    for (var i = 0; i < n; i++) {
      var a = rand() * Math.PI * 2, t = rand();
      var cx = b.x1 + (b.x2 - b.x1) * t, cy = b.y1 + (b.y2 - b.y1) * t;
      out.push(sph(cx + Math.cos(a) * b.r * 0.85, cy + Math.sin(a) * b.r * 0.85, b.r * 0.3 + 1.4));
    }
  });
  return out;
}
function addSpines(body, rand) {
  var out = body.slice();
  body.forEach(function (b) {
    var n = 5 + Math.floor(rand() * 4);
    for (var i = 0; i < n; i++) {
      var a = (i / n) * Math.PI * 2 + rand() * 0.5, t = rand();
      var cx = b.x1 + (b.x2 - b.x1) * t, cy = b.y1 + (b.y2 - b.y1) * t, L = b.r * 0.55 + 3;
      out.push(cap(cx + Math.cos(a) * b.r * 0.6, cy + Math.sin(a) * b.r * 0.6,
                   cx + Math.cos(a) * (b.r + L), cy + Math.sin(a) * (b.r + L), 2.1));
    }
  });
  return out;
}

/* ===================== render =====================
 * Shading comes off the capsule normal, never off distance to the edge.
 * Distance-to-edge shading is pillow shading and it flattens everything.
 */
var M_BODY = 0, M_LIGHT = 2, M_OUT = 3, M_ENV = 4;
function render(spec, cv) {
  var rand = rng((spec.seed >>> 0) + 77);
  var body = spec.shape.make();
  if (spec.surface.k === "warty") body = addWarts(body, rand);
  if (spec.surface.k === "spined") body = addSpines(body, rand);

  var st = spec.stain, RA = ramp(st.h, st.s, st.v);
  var OUT = hsv(st.h - 32, Math.min(0.7, st.s * 0.62), 0.19 * st.v);
  var ENVC = hsv(st.h + 6, st.s * 0.22, 0.93);
  var idx = new Int8Array(R * R).fill(-1), mat = new Int8Array(R * R).fill(-1);
  var depth = new Float32Array(R * R), x, y, i, k;

  for (y = 0; y < R; y++) for (x = 0; x < R; x++) {
    var px = x + 0.5, py = y + 0.5, best = null, bf = 0;
    for (i = 0; i < body.length; i++) { var c = capF(px, py, body[i]); if (c.f > bf) { bf = c.f; best = c; } }
    if (!best || bf <= 0) continue;
    k = y * R + x; depth[k] = bf;
    var nz = Math.sqrt(Math.max(0, bf)), nl = Math.hypot(best.dx, best.dy, nz);
    var d = (best.dx * LX + best.dy * LY + nz * LZ) / nl;
    var lum = 0.17 + 0.86 * Math.max(0, d), edge = 1 - Math.min(1, bf * 2.6);
    if (d < 0.18 && edge > 0.45) lum += 0.3 * edge;      /* rim light */
    if (d > 0.93) lum = 1.06;                            /* specular */
    var su = spec.surface.k;
    if (su === "granular") { var h1 = (((x >> 1) * 73856093) ^ ((y >> 1) * 19349663)) >>> 0; lum += ((h1 % 100) / 100 - 0.5) * 0.19; }
    else if (su === "ridged") lum += Math.sin(best.t * Math.PI * 9 + best.dy * 2.2) * 0.085;
    else if (su === "pitted") { var h2 = ((x * 0x9E37) ^ (y * 0x85EB)) >>> 0; if (h2 % 17 === 0) lum -= 0.24; }
    else if (su === "lattice") { var u = x * 0.5 + y * 0.866, v2 = x * 0.5 - y * 0.866;
      if (((Math.round(u) % 4) + 4) % 4 === 0 || ((Math.round(v2) % 4) + 4) % 4 === 0) lum -= 0.2; }
    /* dither only near a band boundary, or the whole surface turns to noise */
    var g = Math.max(0, Math.min(1, lum)) * 5, b4 = BAYER[(y & 3) * 4 + (x & 3)] / 16;
    idx[k] = Math.max(0, Math.min(5, Math.round(g + (b4 - 0.5) * 0.42)));
    mat[k] = M_BODY;
  }
  for (y = 1; y < R - 1; y++) for (x = 1; x < R - 1; x++) {
    k = y * R + x;
    var n = (idx[k - 1] >= 0) + (idx[k + 1] >= 0) + (idx[k - R] >= 0) + (idx[k + R] >= 0);
    if (idx[k] >= 0 && n === 0) { idx[k] = -1; mat[k] = -1; }
    if (idx[k] < 0 && n >= 3) { idx[k] = 2; mat[k] = M_BODY; }
  }
  function has(a, b) { a = Math.round(a); b = Math.round(b);
    return a >= 0 && b >= 0 && a < R && b < R && idx[b * R + a] >= 0; }
  function set(a, b, v, m) { a = Math.round(a); b = Math.round(b);
    if (a < 0 || b < 0 || a >= R || b >= R) return; idx[b * R + a] = v; mat[b * R + a] = m; }

  if (spec.envelope.k !== "none") {
    var pad = spec.envelope.k === "capsule" ? 3 : spec.envelope.k === "slime" ? 4 : 5, hits = [];
    for (y = 0; y < R; y++) for (x = 0; x < R; x++) {
      if (idx[y * R + x] >= 0) continue;
      var near = false;
      for (var dy = -pad; dy <= pad && !near; dy++) for (var dx = -pad; dx <= pad; dx++) {
        if (dx * dx + dy * dy > pad * pad) continue;
        if (has(x + dx, y + dy)) { near = true; break; }
      }
      if (!near) continue;
      if (spec.envelope.k === "slime" && ((((x * 0x27D4) ^ (y * 0x1656)) >>> 0) % 3 === 0)) continue;
      if (spec.envelope.k === "sheath" && ((x + y) % 3 !== 0)) continue;
      hits.push(y * R + x);
    }
    hits.forEach(function (kk) { idx[kk] = 4; mat[kk] = M_ENV; });
  }

  var cx0 = 0, cy0 = 0;
  body.forEach(function (b) { cx0 += (b.x1 + b.x2) / 2; cy0 += (b.y1 + b.y2) / 2; });
  cx0 /= body.length; cy0 /= body.length;
  /* walk out to the real edge: a fixed offset lands inside a long rod and
     the filament, which refuses to draw over the body, disappears */
  function edgeAt(ang) {
    var last = { x: cx0, y: cy0 };
    for (var s = 1; s < 44; s += 0.5) {
      var xx = cx0 + Math.cos(ang) * s, yy = cy0 + Math.sin(ang) * s;
      if (!has(xx, yy)) return { x: xx, y: yy };
      last = { x: xx, y: yy };
    }
    return last;
  }
  function fil(x0, y0, ang, len, amp, freq) {
    for (var s = 0; s < len; s += 0.3) {
      var w = Math.sin(s * freq) * amp * (s / len);
      var xx = x0 + Math.cos(ang) * s - Math.sin(ang) * w;
      var yy = y0 + Math.sin(ang) * s + Math.cos(ang) * w;
      if (!has(xx, yy)) set(xx, yy, 1, M_BODY);
    }
  }
  var e, ap = spec.appendage.k;
  if (ap === "mono") { e = edgeAt(Math.PI); fil(e.x, e.y, Math.PI * 0.98, 16, 5, 0.42); }
  else if (ap === "lopho") { for (i = 0; i < 4; i++) { var al = Math.PI * (0.88 + i * 0.06); e = edgeAt(al); fil(e.x, e.y, al, 15, 4.4, 0.44); } }
  else if (ap === "amphi") { e = edgeAt(Math.PI); fil(e.x, e.y, Math.PI, 15, 4.6, 0.44); e = edgeAt(0); fil(e.x, e.y, 0, 15, 4.6, 0.44); }
  else if (ap === "peri") { for (i = 0; i < 8; i++) { var a2 = (i / 8) * Math.PI * 2 + 0.2; e = edgeAt(a2); fil(e.x, e.y, a2, 15, 3.4, 0.34); } }
  else if (ap === "fimbriae") { for (i = 0; i < 34; i++) { var a3 = (i / 34) * Math.PI * 2; e = edgeAt(a3);
      for (var s2 = 0; s2 < 5; s2 += 0.4) { var x3 = e.x + Math.cos(a3) * s2, y3 = e.y + Math.sin(a3) * s2;
        if (!has(x3, y3)) set(x3, y3, 1, M_BODY); } } }

  function inBody(a, b) { a = Math.round(a); b = Math.round(b);
    return a >= 0 && b >= 0 && a < R && b < R && mat[b * R + a] === M_BODY && depth[b * R + a] > 0.16; }
  if (spec.inclusion.k === "nucleoid") {
    for (y = 0; y < R; y++) for (x = 0; x < R; x++) {
      if (!inBody(x, y)) continue;
      var nd = Math.hypot(x - cx0, (y - cy0) * 1.35);
      var wob = Math.sin(x * 0.55) * 1.6 + Math.cos(y * 0.5) * 1.6;
      if (nd + wob < 8.5) set(x, y, Math.max(0, idx[y * R + x] - 2), M_BODY);
    }
  } else if (spec.inclusion.k === "spore") {
    var sx = cx0 + 11, sy = cy0;
    if (!inBody(sx, sy)) { sx = cx0; sy = cy0; }
    for (y = -7; y <= 7; y++) for (x = -7; x <= 7; x++) {
      if ((x * x + y * y) / 49 > 1) continue;
      if (inBody(sx + x, sy + y)) set(sx + x, sy + y, (x * x + y * y) / 49 < 0.45 ? 5 : 4, M_LIGHT);
    }
  }

  var oidx = idx.slice(), omat = mat.slice();
  for (y = 0; y < R; y++) for (x = 0; x < R; x++) {
    k = y * R + x; if (idx[k] >= 0) continue;
    var lit = -1;
    if (x > 0 && idx[k - 1] >= 0 && mat[k - 1] !== M_ENV) lit = Math.max(lit, idx[k - 1]);
    if (x < R - 1 && idx[k + 1] >= 0 && mat[k + 1] !== M_ENV) lit = Math.max(lit, idx[k + 1]);
    if (y > 0 && idx[k - R] >= 0 && mat[k - R] !== M_ENV) lit = Math.max(lit, idx[k - R]);
    if (y < R - 1 && idx[k + R] >= 0 && mat[k + R] !== M_ENV) lit = Math.max(lit, idx[k + R]);
    if (lit < 0) continue;
    oidx[k] = 0; omat[k] = lit >= 4 ? M_LIGHT : M_OUT;   /* sel-out */
  }

  var ctx = cv.getContext("2d"); ctx.imageSmoothingEnabled = false;
  var img = ctx.createImageData(R, R), D = img.data;
  for (i = 0; i < R * R; i++) {
    D[i * 4] = 255; D[i * 4 + 1] = 255; D[i * 4 + 2] = 255; D[i * 4 + 3] = 255;
    if (oidx[i] < 0) continue;
    var col = omat[i] === M_OUT ? OUT : omat[i] === M_LIGHT ? RA[Math.max(0, oidx[i])]
            : omat[i] === M_ENV ? ENVC : RA[oidx[i]];
    D[i * 4] = col[0]; D[i * 4 + 1] = col[1]; D[i * 4 + 2] = col[2];
  }
  ctx.putImageData(img, 0, 0);
}

/* ===================== roll the set ===================== */
function weighted(rand, arr) {
  var tot = 0, i;
  for (i = 0; i < arr.length; i++) tot += arr[i].w;
  var v = rand() * tot;
  for (i = 0; i < arr.length; i++) { v -= arr[i].w; if (v <= 0) return arr[i]; }
  return arr[arr.length - 1];
}
function rollSpec(seed) {
  var rand = rng(seed), shape = weighted(rand, SHAPES);
  return {
    seed: seed, shape: shape, stain: weighted(rand, STAINS),
    surface: weighted(rand, SURFACES), appendage: weighted(rand, APPENDAGES),
    inclusion: weighted(rand, INCLUSIONS), envelope: weighted(rand, ENVELOPES),
    ticker: (function () { var p = POOLS[shape.family] || POOLS.sphere; return p[Math.floor(rand() * p.length)]; })()
  };
}
function key(s) { return [s.shape.k, s.stain.k, s.surface.k, s.appendage.k, s.inclusion.k, s.envelope.k].join("|"); }

var SET = [], seen = {};
for (var id = 1; id <= SUPPLY; id++) {
  var spec = null;
  /* 40,824 combinations against 4,444 draws makes duplicates certain, so
     reroll on a salted seed. The salt keeps it deterministic. */
  for (var att = 0; att < 400; att++) {
    var c = rollSpec(id * 2654435761 + att * 40503);
    if (!seen[key(c)]) { spec = c; break; }
  }
  seen[key(spec)] = 1; spec.id = id; SET.push(spec);
}
var AXK = ["shape", "stain", "surface", "appendage", "inclusion", "envelope"], freq = {};
AXK.forEach(function (ax) { freq[ax] = {};
  SET.forEach(function (s) { freq[ax][s[ax].k] = (freq[ax][s[ax].k] || 0) + 1; }); });
SET.forEach(function (s) { s.rarity = AXK.reduce(function (a, ax) { return a + SUPPLY / freq[ax][s[ax].k]; }, 0); });
SET.slice().sort(function (a, b) { return b.rarity - a.rarity; }).forEach(function (s, i) { s.rank = i + 1; });

/* ===================== hero shelf ===================== */
var shelf = document.getElementById("shelf");
if (shelf) {
  [1, 7, 23, 44, 91, 158, 233, 402, 617, 888, 1204, 1777].forEach(function (n) {
    var s = SET[n - 1]; if (!s) return;
    var cv = document.createElement("canvas");
    cv.width = R; cv.height = R;
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", "Biominer " + s.id + ", " + s.shape.n);
    shelf.appendChild(cv);
    render(s, cv);
  });
}

/* ===================== explorer ===================== */
var grid = document.getElementById("grid");
if (!grid) return;

var FILTERS = [["fShape", "shape", SHAPES, "Any shape"], ["fStain", "stain", STAINS, "Any stain"],
  ["fSurface", "surface", SURFACES, "Any surface"], ["fApp", "appendage", APPENDAGES, "Any appendage"],
  ["fInc", "inclusion", INCLUSIONS, "Any inclusion"], ["fEnv", "envelope", ENVELOPES, "Any envelope"]];
FILTERS.forEach(function (f) {
  var sel = document.getElementById(f[0]);
  sel.innerHTML = '<option value="">' + f[3] + "</option>" +
    f[2].map(function (o) { return '<option value="' + o.k + '">' + o.n + "</option>"; }).join("");
  sel.addEventListener("change", function () { page = 0; apply(); });
});
var tickers = {};
SET.forEach(function (s) { tickers[s.ticker.s] = 1; });
var ft = document.getElementById("fTicker");
ft.innerHTML = '<option value="">Any ticker</option>' +
  Object.keys(tickers).sort().map(function (t) { return '<option value="' + t + '">' + t + "</option>"; }).join("");
ft.addEventListener("change", function () { page = 0; apply(); });
document.getElementById("sort").addEventListener("change", function () { page = 0; apply(); });

var view = SET, page = 0;
function apply() {
  var f = {};
  FILTERS.forEach(function (x) { f[x[1]] = document.getElementById(x[0]).value; });
  var tk = ft.value;
  view = SET.filter(function (s) {
    for (var ax in f) { if (f[ax] && s[ax].k !== f[ax]) return false; }
    if (tk && s.ticker.s !== tk) return false;
    return true;
  });
  var mode = document.getElementById("sort").value;
  if (mode === "rare") view = view.slice().sort(function (a, b) { return a.rank - b.rank; });
  else if (mode === "common") view = view.slice().sort(function (a, b) { return b.rank - a.rank; });
  else view = view.slice().sort(function (a, b) { return a.id - b.id; });
  document.getElementById("hits").textContent =
    view.length.toLocaleString() + " of " + SUPPLY.toLocaleString();
  draw();
}
function draw() {
  var total = Math.max(1, Math.ceil(view.length / PER));
  if (page >= total) page = total - 1;
  if (page < 0) page = 0;
  grid.innerHTML = "";
  view.slice(page * PER, page * PER + PER).forEach(function (s) {
    var b = document.createElement("button");
    b.className = "card"; b.type = "button";
    var cv = document.createElement("canvas");
    cv.width = R; cv.height = R;
    cv.setAttribute("role", "img");
    cv.setAttribute("aria-label", s.shape.n + ", " + s.stain.n);
    b.appendChild(cv);
    var cap2 = document.createElement("div");
    cap2.className = "cap";
    cap2.innerHTML = '<span class="tk">' + s.ticker.s + '</span><span class="id">#' + s.id + "</span>" +
      '<div class="sh">' + s.shape.n + "</div>";
    b.appendChild(cap2);
    b.addEventListener("click", function () { detail(s); });
    grid.appendChild(b);
    render(s, cv);
  });
  document.getElementById("page").textContent = "page " + (page + 1) + " / " + total;
  document.getElementById("prev").disabled = page === 0;
  document.getElementById("next").disabled = page >= total - 1;
}
document.getElementById("prev").addEventListener("click", function () {
  page--; draw(); document.getElementById("explore").scrollIntoView(); });
document.getElementById("next").addEventListener("click", function () {
  page++; draw(); document.getElementById("explore").scrollIntoView(); });
document.getElementById("clear").addEventListener("click", function () {
  FILTERS.forEach(function (x) { document.getElementById(x[0]).value = ""; });
  ft.value = ""; document.getElementById("sort").value = "id";
  document.getElementById("jump").value = ""; page = 0; apply();
});
document.getElementById("jump").addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  var n = parseInt(this.value, 10);
  if (n >= 1 && n <= SUPPLY) detail(SET[n - 1]);
});

var box = document.getElementById("box"), boxIn = document.getElementById("boxIn");
function pct(ax, k) { return (freq[ax][k] * 100 / SUPPLY).toFixed(1) + "% of the set"; }
function detail(s) {
  boxIn.innerHTML = "";
  var cv = document.createElement("canvas");
  cv.width = R; cv.height = R;
  cv.setAttribute("role", "img");
  cv.setAttribute("aria-label", s.shape.n + ", " + s.stain.n);
  boxIn.appendChild(cv); render(s, cv);
  function row(k, v, sub) {
    return '<div class="r"><dt>' + k + "</dt><dd>" + v + (sub ? "<small>" + sub + "</small>" : "") + "</dd></div>";
  }
  var d = document.createElement("div");
  d.className = "det";
  d.innerHTML = "<h3>Biominer #" + s.id + "</h3>" +
    '<div class="rk mono">Rarity rank ' + s.rank + " of " + SUPPLY.toLocaleString() + "</div><dl>" +
    row("Shape", s.shape.n, pct("shape", s.shape.k)) +
    row("Stain", s.stain.n, pct("stain", s.stain.k)) +
    row("Surface", s.surface.n, pct("surface", s.surface.k)) +
    row("Appendage", s.appendage.n, pct("appendage", s.appendage.k)) +
    row("Inclusion", s.inclusion.n, pct("inclusion", s.inclusion.k)) +
    row("Envelope", s.envelope.n, pct("envelope", s.envelope.k)) +
    row("Inoculum", s.ticker.s, s.ticker.n) +
    row("Phase", "Dormant", "until cultured") + "</dl>";
  boxIn.appendChild(d);
  box.classList.add("on");
}
document.getElementById("boxClose").addEventListener("click", function () { box.classList.remove("on"); });
box.addEventListener("click", function (e) { if (e.target === box) box.classList.remove("on"); });
document.addEventListener("keydown", function (e) { if (e.key === "Escape") box.classList.remove("on"); });

apply();
})();
