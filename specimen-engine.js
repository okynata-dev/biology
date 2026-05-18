/**
 * Bioms · Specimen Engine
 * Shared rendering engine for procedural Biom specimens. Exposes
 * window.BiomEngine.renderSpecimen(targetEl, seed, options).
 *
 * Mirror of the inline engine in preview.html — kept in sync so banner
 * maker / trait explorer can render specimens directly into DOM (no iframe).
 */
(function () {
  'use strict';

  // ============================================================
  // RNG
  // ============================================================
  function mulberry32(seed) {
    let t = seed;
    return function () {
      t = (t + 0x6D2B79F5) | 0;
      let r = Math.imul(t ^ (t >>> 15), 1 | t);
      r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
      return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ============================================================
  // PALETTES (12 stains)
  // ============================================================
  const PALETTES = {
    gramPositive: {
      capsule:  'rgba(155, 110, 195, 0.30)', cellWall: 'rgba(110, 70, 160, 0.30)',
      body:     'rgba(140,  90, 180, 0.55)', bodyDark: 'rgba( 90, 50, 140, 0.65)',
      bodyDeep: 'rgba( 55,  25, 100, 0.75)', organelle:'rgba(200, 160, 220, 0.6)',
      accent:   'rgba(255, 220,  90, 0.65)', accentB:  'rgba(255, 140,  60, 0.6)',
    },
    gramNegative: {
      capsule:  'rgba(245, 160, 195, 0.30)', cellWall: 'rgba(210, 100, 150, 0.30)',
      body:     'rgba(240, 140, 180, 0.55)', bodyDark: 'rgba(200,  70, 130, 0.65)',
      bodyDeep: 'rgba(140,  30,  90, 0.75)', organelle:'rgba(250, 200, 220, 0.6)',
      accent:   'rgba(100, 200, 220, 0.65)', accentB:  'rgba( 70, 160, 230, 0.6)',
    },
    fluorescent: {
      capsule:  'rgba(160, 230, 170, 0.30)', cellWall: 'rgba( 90, 180, 120, 0.30)',
      body:     'rgba(120, 220, 140, 0.55)', bodyDark: 'rgba( 60, 160, 100, 0.65)',
      bodyDeep: 'rgba( 30, 100,  70, 0.75)', organelle:'rgba(200, 250, 200, 0.6)',
      accent:   'rgba(255, 180,  80, 0.65)', accentB:  'rgba(255, 120,  60, 0.6)',
    },
    methylene: {
      capsule:  'rgba(110, 150, 220, 0.30)', cellWall: 'rgba( 60, 100, 200, 0.30)',
      body:     'rgba( 80, 130, 220, 0.55)', bodyDark: 'rgba( 40,  80, 170, 0.65)',
      bodyDeep: 'rgba( 20,  40, 120, 0.75)', organelle:'rgba(160, 190, 240, 0.6)',
      accent:   'rgba(255, 200, 100, 0.65)', accentB:  'rgba(255, 130, 100, 0.6)',
    },
    darkfield: {
      capsule:  'rgba(180, 180, 180, 0.30)', cellWall: 'rgba(140, 140, 140, 0.30)',
      body:     'rgba(220, 220, 220, 0.55)', bodyDark: 'rgba(160, 160, 160, 0.65)',
      bodyDeep: 'rgba( 80,  80,  80, 0.75)', organelle:'rgba(240, 240, 240, 0.6)',
      accent:   'rgba(255, 240, 180, 0.65)', accentB:  'rgba(180, 220, 255, 0.6)',
    },
    iridescent_aurora: {
      capsule:  'rgba(160, 200, 220, 0.30)', cellWall: 'rgba(120, 180, 200, 0.30)',
      body:     ['rgba(120, 220, 200, 0.75)', 'rgba(160, 140, 220, 0.65)', 'rgba(255, 180, 200, 0.6)'],
      bodyDark: 'rgba( 80, 120, 180, 0.7)',  bodyDeep: 'rgba( 40,  60, 120, 0.78)',
      organelle:'rgba(220, 240, 250, 0.6)',  accent:   'rgba(255, 200, 120, 0.65)',
      accentB:  'rgba(255, 140, 180, 0.6)',
    },
    ghost: {
      capsule:  'rgba(200, 225, 240, 0.06)', cellWall: 'rgba(180, 215, 235, 0.08)',
      body:     'rgba(190, 220, 240, 0.10)', bodyDark: 'rgba(140, 180, 215, 0.20)',
      bodyDeep: 'rgba( 50,  95, 140, 0.70)', organelle:'rgba(180, 215, 240, 0.45)',
      accent:   'rgba(110, 160, 205, 0.50)', accentB:  'rgba(140, 185, 215, 0.45)',
    },
    gram_variable: {
      capsule:  'rgba(200, 135, 195, 0.30)', cellWall: 'rgba(160,  90, 155, 0.30)',
      body:     '__GRAM_VARIABLE__',         bodyDark: 'rgba(140,  60, 130, 0.65)',
      bodyDeep: 'rgba( 80,  20,  80, 0.75)', organelle:'rgba(225, 180, 220, 0.6)',
      accent:   'rgba(255, 220, 100, 0.65)', accentB:  'rgba(120, 220, 200, 0.6)',
      _gramPlus:  'rgba(140,  90, 180, 0.55)',
      _gramMinus: 'rgba(240, 140, 180, 0.55)',
    },
    acid_fast: {
      capsule:  'rgba(180, 220, 235, 0.30)', cellWall: 'rgba(140, 200, 220, 0.30)',
      body:     'rgba(220,  60,  50, 0.55)', bodyDark: 'rgba(180,  30,  30, 0.65)',
      bodyDeep: 'rgba(110,  10,  20, 0.78)', organelle:'rgba(240, 130, 110, 0.60)',
      accent:   'rgba( 80, 170, 220, 0.65)', accentB:  'rgba(100, 180, 230, 0.60)',
    },
    giemsa: {
      capsule:  'rgba(220, 180, 220, 0.30)', cellWall: 'rgba(190, 140, 200, 0.30)',
      body:     'rgba(200, 110, 180, 0.55)', bodyDark: 'rgba(160,  70, 150, 0.65)',
      bodyDeep: 'rgba(100,  30, 100, 0.78)', organelle:'rgba(230, 180, 220, 0.60)',
      accent:   'rgba(180, 100, 200, 0.65)', accentB:  'rgba(220, 130, 170, 0.60)',
    },
    safranin: {
      capsule:  'rgba(245, 200, 200, 0.30)', cellWall: 'rgba(230, 170, 175, 0.30)',
      body:     'rgba(235, 150, 160, 0.55)', bodyDark: 'rgba(200, 100, 120, 0.65)',
      bodyDeep: 'rgba(140,  50,  70, 0.78)', organelle:'rgba(250, 200, 210, 0.60)',
      accent:   'rgba(255, 180, 130, 0.65)', accentB:  'rgba(250, 160, 110, 0.60)',
    },
    india_ink: {
      capsule:  'rgba( 50,  50,  60, 0.25)', cellWall: 'rgba( 30,  30,  40, 0.30)',
      body:     'rgba( 30,  30,  40, 0.60)', bodyDark: 'rgba( 15,  15,  25, 0.80)',
      bodyDeep: 'rgba(200, 200, 210, 0.70)', organelle:'rgba(220, 220, 230, 0.70)',
      accent:   'rgba(180, 180, 200, 0.65)', accentB:  'rgba(140, 140, 160, 0.55)',
    },
  };

  // ============================================================
  // TRAIT WEIGHTS
  // ============================================================
  const PALETTE_WEIGHTS = [
    ['gramPositive', 20], ['gramNegative', 16], ['fluorescent', 14], ['methylene', 12],
    ['darkfield', 8], ['acid_fast', 6], ['giemsa', 5], ['iridescent_aurora', 7],
    ['ghost', 5], ['safranin', 3], ['india_ink', 3], ['gram_variable', 1],
  ];
  const MORPHOLOGY_WEIGHTS = [
    ['coccus', 13], ['bacillus', 13], ['vibrio', 12], ['spirillum', 12],
    ['filament', 10], ['cluster', 10], ['diplo', 10], ['streptobacillus', 8],
    ['tetrad', 7], ['sarcina', 3], ['mycelium', 2],
  ];
  const RESERVE_WEIGHTS = [
    ['none', 64], ['phb', 12], ['volutin', 10], ['magnetosomes', 7],
    ['sulfur', 4], ['crystalline', 3],
  ];
  const LIFECYCLE_WEIGHTS = [
    ['vegetative', 78], ['binary_fission', 10], ['sporulating', 6], ['heterocyst', 6],
  ];

  function pickW(weights, rng) {
    const r = rng() * 100;
    let acc = 0;
    for (const [n, w] of weights) { acc += w; if (r < acc) return n; }
    return weights[weights.length - 1][0];
  }

  // ============================================================
  // PALETTE MIXING — blend two stains channel-by-channel.
  // Result is registered into PALETTES under a synthetic key
  // `_mix_${a}_${b}` (sorted) so the rest of the engine can look it
  // up by name like any other palette. Used by the Lab's burn flow:
  // two absorbed organisms produce a gradient-blend of their stains.
  // ============================================================
  function _parseRgba(s) {
    if (Array.isArray(s)) s = s[0]; // aurora's body is gradient stops — use first
    if (typeof s !== 'string') return null;
    const m = s.match(/rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
  }
  function _blendRgba(sa, sb) {
    const pa = _parseRgba(sa), pb = _parseRgba(sb);
    if (!pa) return sb;
    if (!pb) return sa;
    const r = Math.round((pa.r + pb.r) / 2);
    const g = Math.round((pa.g + pb.g) / 2);
    const b = Math.round((pa.b + pb.b) / 2);
    const a = ((pa.a + pb.a) / 2).toFixed(2);
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  function mixPalettes(idA, idB) {
    if (idA === idB) return idA;
    const pa = PALETTES[idA], pb = PALETTES[idB];
    if (!pa || !pb) return idA || idB;
    const key = `_mix_${[idA, idB].sort().join('_')}`;
    if (PALETTES[key]) return key;
    const mixed = {};
    const keys = new Set([...Object.keys(pa), ...Object.keys(pb)]);
    for (const k of keys) {
      const va = pa[k], vb = pb[k];
      if (va === '__GRAM_VARIABLE__' || vb === '__GRAM_VARIABLE__') {
        // Gram-variable has a sentinel — fall back to whichever real value exists
        mixed[k] = (va === '__GRAM_VARIABLE__' ? vb : va) || va;
      } else if (va && vb) {
        mixed[k] = _blendRgba(va, vb);
      } else {
        mixed[k] = va || vb;
      }
    }
    PALETTES[key] = mixed;
    return key;
  }

  const NAME_PREFIX = [
    'Halo','Aure','Lumi','Spiro','Vibrio','Coccu','Micro','Crypto',
    'Polyspora','Sympha','Glia','Plasmo','Endo','Strepto',
    'Acid','Chemo','Pheno','Pseudo','Auro','Cyto','Phago','Lipo',
    'Astro','Cryo','Thermo','Photo','Carbo','Ferro','Magneto','Geo','Nano','Xeno',
  ];
  const NAME_SUFFIX = [
    'philia','lensis','nescens','aria','caula','genia','nax',
    'corymba','roteus','mensis','tarchus','lina','striga','thymos',
    'bacter','coccus','monas','philis','mira','voraxa','geri',
    'fila','ster','dictyon','helios','gena','sphaera','tuus','vorans','capsa','mantia','oides',
  ];
  function pickName(seed) {
    const r = mulberry32(seed);
    return (NAME_PREFIX[Math.floor(r() * 32)] + NAME_SUFFIX[Math.floor(r() * 32)]).toUpperCase();
  }

  // ============================================================
  // STATE GENERATION (mirrors preview.html randomize)
  // ============================================================
  function generateState(seed) {
    const rng = mulberry32(seed);
    const state = {
      seed: seed,
      organelles: new Set(['capsule']),
    };
    state.morphology = pickW(MORPHOLOGY_WEIGHTS, rng);
    state.palette = pickW(PALETTE_WEIGHTS, rng);
    state.cellCount = 1 + Math.floor(rng() * 6);
    state.accentCount = Math.floor(rng() * 4);
    if (rng() < 0.85) state.organelles.add('nucleoid');
    if (rng() < 0.45) state.organelles.add('ribosomes');
    if (rng() < 0.55) state.organelles.add('pili');
    if (rng() < 0.30) state.organelles.add('flagellum');
    if (rng() < 0.40) state.organelles.add('plasmid');
    if (rng() < 0.15) state.organelles.add('endospore');
    if (rng() < 0.20) state.organelles.add('inclusion');
    if (rng() < 0.20) state.organelles.add('eyespot');
    if (rng() < 0.15) state.organelles.add('axial');
    state.reserveGranule = pickW(RESERVE_WEIGHTS, rng);
    let lc = pickW(LIFECYCLE_WEIGHTS, rng);
    if (lc === 'heterocyst' && state.morphology !== 'filament' && state.morphology !== 'mycelium') lc = 'vegetative';
    state.lifecycle = lc;
    state.phageAttached = rng() < 0.015;
    state.endosymbiont = rng() < 0.01;
    state.biofilmHalo  = rng() < 0.02;
    return state;
  }

  // ============================================================
  // MORPHOLOGY GENERATORS
  // ============================================================
  function clusterPositions(count) {
    const layouts = {
      1: [{ x: 48, y: 50 }],
      2: [{ x: 36, y: 44 }, { x: 60, y: 58 }],
      3: [{ x: 36, y: 38 }, { x: 60, y: 48 }, { x: 42, y: 64 }],
      4: [{ x: 42, y: 34 }, { x: 60, y: 48 }, { x: 38, y: 62 }, { x: 56, y: 78 }],
      5: [{ x: 38, y: 32 }, { x: 58, y: 38 }, { x: 48, y: 52 }, { x: 36, y: 68 }, { x: 60, y: 74 }],
      6: [{ x: 36, y: 30 }, { x: 56, y: 34 }, { x: 44, y: 48 }, { x: 60, y: 56 }, { x: 36, y: 66 }, { x: 56, y: 78 }],
    };
    return layouts[count] || layouts[4];
  }

  function grapeCluster(count, rng) {
    const result = [];
    const cx = 48, cy = 50;
    for (let i = 0; i < count; i++) {
      const angle = rng() * Math.PI * 2;
      const dist = 8 + rng() * 8;
      result.push({
        x: cx + Math.cos(angle) * dist,
        y: cy + Math.sin(angle) * dist,
        r: 7 + rng() * 4,
      });
    }
    return result;
  }

  function generateMorphology(type, count, state) {
    const panels = [];
    switch (type) {
      case 'coccus': {
        clusterPositions(count).forEach((p, i) => {
          panels.push({ cx: p.x, cy: p.y, w: 24, h: 24, r: 50, z: 80 + i * 8, color: 'body' });
        });
        break;
      }
      case 'bacillus': {
        for (let i = 0; i < count; i++) {
          panels.push({
            cx: 48 + (i % 2 === 0 ? -3 : 3),
            cy: 30 + i * (45 / Math.max(count, 1)),
            w: 36, h: 18, r: 30, z: 80 + i * 10, color: 'body',
            rot: i % 2 === 0 ? -4 : 4,
          });
        }
        break;
      }
      case 'vibrio': {
        const bulges = Math.min(count, 3);
        for (let i = 0; i < bulges; i++) {
          const t = bulges === 1 ? 0.5 : i / (bulges - 1);
          panels.push({
            cx: 48 + Math.sin(t * Math.PI) * 8, cy: 28 + t * 50,
            w: 44 - i * 4, h: 30, r: 40, z: 70 + i * 15, color: 'body',
            rot: -10 + t * 30,
          });
        }
        break;
      }
      case 'spirillum': {
        for (let i = 0; i < count; i++) {
          const t = i / Math.max(count - 1, 1);
          panels.push({
            cx: 48 + Math.sin(t * Math.PI * 1.8) * 9, cy: 22 + t * 64,
            w: 26, h: 18, r: 40, z: 60 + i * 12, color: 'body',
            rot: i % 2 === 0 ? 18 : -18,
          });
        }
        break;
      }
      case 'filament': {
        for (let i = 0; i < count; i++) {
          const t = i / Math.max(count - 1, 1);
          panels.push({ cx: 48, cy: 25 + t * 55, w: 16, h: 16, r: 50, z: 80 + i * 4, color: 'body' });
        }
        break;
      }
      case 'cluster': {
        grapeCluster(count, mulberry32(state.seed)).forEach((p, i) => {
          panels.push({ cx: p.x, cy: p.y, w: p.r * 2, h: p.r * 2, r: 50, z: 80 + i * 6, color: 'body' });
        });
        break;
      }
      case 'diplo': {
        const pairs = Math.max(1, Math.floor(count / 2));
        for (let i = 0; i < pairs; i++) {
          const y = 32 + i * (40 / Math.max(pairs, 1));
          panels.push({ cx: 38, cy: y, w: 26, h: 26, r: 50, z: 80 + i * 10, color: 'body' });
          panels.push({ cx: 58, cy: y, w: 26, h: 26, r: 50, z: 80 + i * 10, color: 'body' });
        }
        break;
      }
      case 'sarcina': {
        const back = [{ x: 42, y: 36 }, { x: 56, y: 36 }, { x: 42, y: 54 }, { x: 56, y: 54 }];
        back.forEach((p, i) => panels.push({ cx: p.x, cy: p.y, w: 17, h: 17, r: 50, z: 40 + i * 3, color: 'bodyDark' }));
        const front = [{ x: 38, y: 38 }, { x: 60, y: 38 }, { x: 38, y: 60 }, { x: 60, y: 60 }];
        front.forEach((p, i) => panels.push({ cx: p.x, cy: p.y, w: 22, h: 22, r: 50, z: 100 + i * 5, color: 'body' }));
        break;
      }
      case 'tetrad': {
        [{ x: 40, y: 42 }, { x: 58, y: 42 }, { x: 40, y: 60 }, { x: 58, y: 60 }].forEach((p, i) => {
          panels.push({ cx: p.x, cy: p.y, w: 22, h: 22, r: 50, z: 80 + i * 6, color: 'body' });
        });
        break;
      }
      case 'streptobacillus': {
        const chainLen = 5 + Math.min(count, 3);
        const totalH = 60;
        for (let i = 0; i < chainLen; i++) {
          panels.push({
            cx: 48 + (i % 2 === 0 ? -1.5 : 1.5),
            cy: 22 + (i + 0.5) * (totalH / chainLen),
            w: 26, h: (totalH / chainLen) - 1, r: 35,
            z: 80 + i * 5, color: 'body',
            rot: i % 2 === 0 ? -2 : 2,
          });
        }
        break;
      }
      case 'mycelium': {
        const branchRng = mulberry32(state.seed * 7919 + 1);
        function grow(x, y, angle, length, depth) {
          if (depth > 4 || length < 5) return;
          const segs = 3 + Math.floor(branchRng() * 3);
          let cx = x, cy = y;
          for (let s = 0; s < segs; s++) {
            const segLen = length / segs;
            cx += Math.cos(angle) * segLen;
            cy += Math.sin(angle) * segLen;
            if (cx < 8 || cx > 92 || cy < 8 || cy > 92) return;
            const cellSize = Math.max(3, 8 - depth * 1.3);
            panels.push({
              cx: cx, cy: cy, w: cellSize, h: cellSize, r: 50,
              z: 90 - depth * 12,
              color: depth === 0 ? 'body' : (depth === 1 ? 'bodyDark' : 'bodyDeep'),
            });
            angle += (branchRng() - 0.5) * 0.4;
          }
          if (depth < 3 && branchRng() < 0.65) {
            grow(cx, cy, angle + Math.PI / 4 + (branchRng() - 0.5) * 0.3, length * 0.7, depth + 1);
            grow(cx, cy, angle - Math.PI / 4 + (branchRng() - 0.5) * 0.3, length * 0.7, depth + 1);
          }
        }
        const startDirs = 3 + Math.floor(branchRng() * 2);
        for (let i = 0; i < startDirs; i++) {
          grow(48, 50, (i / startDirs) * Math.PI * 2 + branchRng() * 0.5, 20, 0);
        }
        break;
      }
    }
    return panels;
  }

  // ============================================================
  // ORGANELLES + LIFECYCLE + ULTRA-RARE
  // ============================================================
  function computeBbox(cells) {
    let minX = 100, maxX = 0, minY = 100, maxY = 0;
    cells.forEach(c => {
      minX = Math.min(minX, c.cx - c.w / 2);
      maxX = Math.max(maxX, c.cx + c.w / 2);
      minY = Math.min(minY, c.cy - c.h / 2);
      maxY = Math.max(maxY, c.cy + c.h / 2);
    });
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, w: maxX - minX, h: maxY - minY };
  }

  function generateOrganelles(state, cells, rng, isFitMode) {
    const result = [];

    if (state.organelles.has('capsule')) {
      const bbox = computeBbox(cells);
      let capCy, capW, capH;
      if (isFitMode) {
        capCy = bbox.cy + bbox.h * 0.05;
        capW = Math.max(bbox.w * 1.15 + 6, 48);
        capH = Math.max(bbox.h * 1.15 + 8, 52);
      } else {
        capCy = Math.max(bbox.cy + bbox.h * 0.3, 65);
        capW = Math.max(bbox.w * 1.4 + 20, 60);
        capH = Math.max(bbox.h * 1.4 + 24, 70);
      }
      result.push({ cx: bbox.cx, cy: capCy, w: capW, h: capH, r: 50, z: 0, color: 'capsule' });
      result.push({
        cx: bbox.cx, cy: bbox.cy + bbox.h * 0.15,
        w: bbox.w * 1.15 + 8, h: bbox.h * 1.15 + 10,
        r: 50, z: 20, color: 'cellWall',
      });
    }

    if (state.organelles.has('nucleoid')) {
      cells.forEach(cell => {
        result.push({
          cx: cell.cx, cy: cell.cy, w: cell.w * 0.4, h: cell.h * 0.4,
          r: 50, z: cell.z + 50, color: 'bodyDeep',
        });
      });
    }

    if (state.organelles.has('ribosomes')) {
      cells.forEach(cell => {
        const count = 2 + Math.floor(rng() * 3);
        for (let i = 0; i < count; i++) {
          const a = rng() * Math.PI * 2;
          const r = cell.w * 0.25 * rng();
          result.push({
            cx: cell.cx + Math.cos(a) * r, cy: cell.cy + Math.sin(a) * r,
            w: 2.4, h: 2.4, r: 50, z: cell.z + 60, color: 'organelle',
          });
        }
      });
    }

    if (state.organelles.has('pili')) {
      const bbox = computeBbox(cells);
      const r = Math.max(bbox.w, bbox.h) * 0.5 + 4;
      for (let i = 0; i < 14; i++) {
        const angle = (i / 14) * Math.PI * 2;
        if (angle > Math.PI * 0.6 && angle < Math.PI * 1.4) continue;
        result.push({
          cx: bbox.cx + Math.cos(angle - Math.PI / 2) * r,
          cy: bbox.cy + Math.sin(angle - Math.PI / 2) * r * 0.9,
          w: 6, h: 1.8, r: 1, z: 50, color: 'organelle',
          rot: (angle - Math.PI / 2) * 180 / Math.PI,
        });
      }
    }

    if (state.organelles.has('flagellum')) {
      for (let i = 0; i < 5; i++) {
        const t = i / 4;
        result.push({
          cx: 70 + t * 18, cy: 18 - t * 8 + Math.sin(i * 1.2) * 4,
          w: 8, h: 2.2, r: 2, z: 30, color: 'organelle',
          rot: 30 + Math.sin(i * 1.2) * 30,
        });
      }
    }

    if (state.organelles.has('plasmid')) {
      result.push({ cx: 80, cy: 28, w: 9, h: 8, r: 50, z: 200, color: 'accent' });
    }

    if (state.organelles.has('endospore')) {
      const c = cells[Math.floor(cells.length / 2)] || cells[0];
      if (c) {
        result.push({
          cx: c.cx, cy: c.cy, w: c.w * 0.5, h: c.h * 0.32,
          r: 50, z: c.z + 45, color: 'accentB', rot: -15,
        });
      }
    }

    if (state.organelles.has('inclusion')) {
      cells.slice(0, Math.min(2, cells.length)).forEach(cell => {
        result.push({
          cx: cell.cx + cell.w * 0.15, cy: cell.cy - cell.h * 0.15,
          w: cell.w * 0.18, h: cell.w * 0.18,
          r: 50, z: cell.z + 65, color: 'bodyDeep',
        });
      });
    }

    if (state.organelles.has('eyespot')) {
      const cell = cells[0] || { cx: 48, cy: 40, w: 28, h: 28, z: 100 };
      result.push({
        cx: cell.cx + cell.w * 0.2, cy: cell.cy - cell.h * 0.18,
        w: 10, h: 10, r: 50, z: cell.z + 75, color: 'bodyDeep',
      });
      result.push({
        cx: cell.cx + cell.w * 0.2 + 1, cy: cell.cy - cell.h * 0.18 - 1,
        w: 4, h: 4, r: 50, z: cell.z + 120, color: 'capsule',
      });
    }

    if (state.organelles.has('axial')) {
      const bbox = computeBbox(cells);
      result.push({ cx: bbox.cx, cy: bbox.cy, w: 4, h: bbox.h, r: 2, z: 130, color: 'bodyDeep' });
    }

    if (state.reserveGranule && state.reserveGranule !== 'none') {
      const grng = mulberry32(state.seed * 31337 + 7);
      cells.forEach(cell => {
        const cellR = (cell.w + cell.h) / 4;
        if (state.reserveGranule === 'phb') {
          const n = 2 + Math.floor(grng() * 2);
          for (let i = 0; i < n; i++) {
            const a = grng() * Math.PI * 2; const d = cellR * 0.3 * grng();
            result.push({
              cx: cell.cx + Math.cos(a)*d, cy: cell.cy + Math.sin(a)*d,
              w: cell.w*0.25, h: cell.h*0.25, r: 50, z: cell.z+55, color: 'organelle',
            });
          }
        } else if (state.reserveGranule === 'volutin') {
          const n = 2 + Math.floor(grng() * 2);
          for (let i = 0; i < n; i++) {
            const a = grng() * Math.PI * 2; const d = cellR * 0.35 * grng();
            result.push({
              cx: cell.cx + Math.cos(a)*d, cy: cell.cy + Math.sin(a)*d,
              w: cell.w*0.15, h: cell.h*0.15, r: 50, z: cell.z+58, color: 'bodyDeep',
            });
          }
        } else if (state.reserveGranule === 'magnetosomes') {
          const n = 5 + Math.floor(grng() * 4);
          for (let i = 0; i < n; i++) {
            const t = (i / Math.max(n - 1, 1) - 0.5) * 0.6;
            result.push({
              cx: cell.cx + t*cell.w, cy: cell.cy,
              w: cell.w*0.10, h: cell.h*0.10, r: 50, z: cell.z+60, color: 'bodyDeep',
            });
          }
        } else if (state.reserveGranule === 'sulfur') {
          const n = 1 + Math.floor(grng() * 2);
          for (let i = 0; i < n; i++) {
            const a = grng() * Math.PI * 2; const d = cellR * 0.25 * grng();
            result.push({
              cx: cell.cx + Math.cos(a)*d, cy: cell.cy + Math.sin(a)*d,
              w: cell.w*0.35, h: cell.h*0.35, r: 50, z: cell.z+65, color: 'accent',
            });
          }
        } else if (state.reserveGranule === 'crystalline') {
          result.push({
            cx: cell.cx, cy: cell.cy + cell.h*0.2,
            w: cell.w*0.3, h: cell.w*0.3, r: 5, z: cell.z+55, color: 'bodyDeep', rot: 45,
          });
        }
      });
    }

    if (state.lifecycle === 'binary_fission' && cells[0]) {
      result.push({
        cx: cells[0].cx, cy: cells[0].cy, w: cells[0].w*0.95, h: 2, r: 1,
        z: cells[0].z+100, color: 'bodyDeep',
      });
    } else if (state.lifecycle === 'sporulating') {
      const cell = cells[Math.floor(cells.length/2)] || cells[0];
      if (cell) result.push({
        cx: cell.cx, cy: cell.cy, w: cell.w*0.55, h: cell.h*0.45,
        r: 50, z: cell.z+70, color: 'accentB',
      });
    } else if (state.lifecycle === 'heterocyst') {
      const cell = cells[Math.floor(cells.length/2)];
      if (cell) result.push({
        cx: cell.cx, cy: cell.cy, w: cell.w*1.4, h: cell.h*1.4,
        r: 50, z: cell.z-10, color: 'accent',
      });
    }

    if (state.phageAttached && cells[0]) {
      const c = cells[0], sx = c.cx + c.w*0.4, sy = c.cy - c.h*0.4;
      result.push({ cx: sx, cy: sy, w: 4, h: 4, r: 30, z: 220, color: 'bodyDeep', rot: 30 });
      result.push({ cx: sx, cy: sy+4, w: 1.5, h: 5, r: 1, z: 218, color: 'bodyDeep' });
    }
    if (state.endosymbiont && cells[0]) {
      const c = cells[0];
      result.push({ cx: c.cx, cy: c.cy, w: c.w*0.42, h: c.h*0.42, r: 50, z: c.z+88, color: 'cellWall' });
      result.push({ cx: c.cx, cy: c.cy, w: c.w*0.35, h: c.h*0.35, r: 50, z: c.z+90, color: 'accent' });
    }
    if (state.biofilmHalo) {
      const bb = computeBbox(cells);
      const haloW = isFitMode ? bb.w * 1.35 + 14 : bb.w * 1.8 + 40;
      const haloH = isFitMode ? bb.h * 1.35 + 14 : bb.h * 1.8 + 40;
      result.push({ cx: bb.cx, cy: bb.cy, w: haloW, h: haloH, r: 50, z: -10, color: 'capsule' });
    }
    return result;
  }

  function generateAccents(count, rng) {
    const result = [];
    const positions = [{ x: 80, y: 30 }, { x: 18, y: 26 }, { x: 78, y: 14 }, { x: 14, y: 38 }];
    for (let i = 0; i < count; i++) {
      const p = positions[i % positions.length];
      const isB = i % 2 === 1;
      result.push({
        cx: p.x + (rng() - 0.5) * 6, cy: p.y + (rng() - 0.5) * 6,
        w: 4 + rng() * 5, h: 4 + rng() * 5,
        r: 50, z: 195 - i * 3,
        color: isB ? 'accentB' : 'accent',
      });
    }
    return result;
  }

  // ============================================================
  // COLOR + BORDER-RADIUS
  // ============================================================
  function resolveColor(name, palette, gradientAngle, cellIdx) {
    const v = palette[name];
    if (v === '__GRAM_VARIABLE__') {
      const idx = cellIdx != null ? cellIdx : 0;
      return idx % 2 === 0 ? palette._gramPlus : palette._gramMinus;
    }
    if (Array.isArray(v)) {
      const angle = gradientAngle != null ? gradientAngle : 145;
      const stops = v.map((c, i) => `${c} ${((i / (v.length - 1)) * 100).toFixed(0)}%`).join(', ');
      return `linear-gradient(${angle}deg, ${stops})`;
    }
    return v || name;
  }

  function formatBorderRadius(r) {
    return `${r[0].toFixed(1)}% ${r[1].toFixed(1)}% ${r[2].toFixed(1)}% ${r[3].toFixed(1)}% / ${r[4].toFixed(1)}% ${r[5].toFixed(1)}% ${r[6].toFixed(1)}% ${r[7].toFixed(1)}%`;
  }

  // ============================================================
  // MAIN: renderSpecimen(targetEl, seed, options)
  // ============================================================
  // Renders the specimen into targetEl (the composition root).
  // targetEl must be positioned absolutely with full inset, with perspective.
  // Options:
  //   isFitMode (bool, default true) — smaller capsule envelope
  function renderSpecimen(targetEl, seed, options) {
    const opts = options || {};
    const isFitMode = opts.isFitMode !== false;
    const state = generateState(seed);
    const cells = generateMorphology(state.morphology, state.cellCount, state);
    cells.forEach((c, i) => c.cellIndex = i);
    const rng = mulberry32(seed);
    // Burn enough rng calls to match preview.html's organelle/accent rng position
    // (preview.html uses the main rng for both trait selection and organelle
    // positions; here we use a fresh rng so positions may differ slightly per
    // platform — this only affects organelle micro-positions, not which traits.)
    const organelles = generateOrganelles(state, cells, rng, isFitMode);
    const accents = generateAccents(state.accentCount, rng);
    const all = [...cells, ...organelles, ...accents].sort((a, b) => a.z - b.z);

    targetEl.innerHTML = '';
    const palette = PALETTES[state.palette];

    all.forEach((item, idx) => {
      const el = document.createElement('div');
      el.className = 'panel';
      if (item.color === 'capsule' || item.color === 'cellWall') el.classList.add('capsule-layer');
      if (item.w < 6) el.classList.add('lite');

      el.style.left = (item.cx - item.w / 2) + '%';
      el.style.top  = (item.cy - item.h / 2) + '%';
      el.style.width  = item.w + '%';
      el.style.height = item.h + '%';

      if (item.r >= 30 && item.w > 8) {
        const sr = mulberry32(seed + idx * 37 + 1);
        const radii = [];
        for (let i = 0; i < 8; i++) radii.push(35 + sr() * 35);
        el.style.borderRadius = formatBorderRadius(radii);
      } else if (item.r >= 49) {
        el.style.borderRadius = '50%';
      } else {
        el.style.borderRadius = item.r + '%';
      }

      const gradAngle = 80 + (idx * 47) % 200;
      el.style.background = resolveColor(item.color, palette, gradAngle, item.cellIndex);
      // Use z-index for layering (NOT translateZ) — html2canvas can't capture
      // 3D transforms; z-index is 2D and renders correctly in screenshot tools.
      el.style.zIndex = item.z;
      el.style.transform = `rotate(${item.rot || 0}deg)`;
      targetEl.appendChild(el);
    });

    return state;  // caller may use this (e.g. for trait display)
  }

  // ============================================================
  // CANVAS RENDERER — for high-quality download PNG
  // ============================================================
  // Renders specimen DIRECTLY to a 2D canvas context, bypassing DOM/SVG/
  // backdrop-filter limitations. Output identical at any resolution.
  //
  // Args:
  //   canvas         HTMLCanvasElement, sized to target dimensions
  //   seed           the Biom seed
  //   opts.specSize  px — size of the square specimen area within canvas
  //   opts.tx, ty    px offset from canvas center
  //   opts.scale     specimen scale (1 = specSize, 2 = 2× specSize, etc)
  //   opts.rotation  degrees
  //   opts.flipX     1 or -1
  //   opts.flipY     1 or -1
  function renderSpecimenToCanvas(canvas, seed, opts) {
    opts = opts || {};
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);

    // Build the specimen data
    const state = generateState(seed);
    const cells = generateMorphology(state.morphology, state.cellCount, state);
    cells.forEach((c, i) => c.cellIndex = i);
    const rng = mulberry32(seed);
    const organelles = generateOrganelles(state, cells, rng, true);
    const accents = generateAccents(state.accentCount, rng);
    const all = [...cells, ...organelles, ...accents].sort((a, b) => a.z - b.z);
    const palette = PALETTES[state.palette];

    // Compute the drawing transform: center → translate → scale → rotate → flip
    // Match the CSS transform chain used by make.html:
    //   element CSS-positioned at left:50% top:50% of canvas, then
    //   transform: translate(-50%, -50%) translate(tx, ty) scale(fx, fy) rotate(rot)
    // transform-origin: center center  (rotate + scale pivot around element center)
    //
    // Canvas API ctx.translate/rotate/scale each post-multiplies the matrix,
    // so calling them in the SAME order as CSS reads (left to right) produces
    // the same composition. For the rotate/scale around center, we translate
    // to element center, rotate/scale, then translate back to top-left.
    const baseSize = opts.specSize || Math.min(W, H);
    const userScale = opts.scale != null ? opts.scale : 1;
    const finalSize = baseSize * userScale;
    const rotation = (opts.rotation || 0) * Math.PI / 180;
    const fx = opts.flipX || 1;
    const fy = opts.flipY || 1;
    const tx = opts.tx || 0;
    const ty = opts.ty || 0;

    ctx.save();
    ctx.translate(W / 2, H / 2);                          // element CSS position (left:50%, top:50%)
    ctx.translate(-finalSize / 2, -finalSize / 2);        // CSS: translate(-50%, -50%)
    ctx.translate(tx, ty);                                 // CSS: translate(tx, ty) in canvas coords
    // Now (0, 0) is the element's top-left. Pivot scale/rotate around center:
    ctx.translate(finalSize / 2, finalSize / 2);          // shift to element center
    ctx.scale(fx, fy);                                     // CSS: scale(fx, fy)
    ctx.rotate(rotation);                                  // CSS: rotate(rot)
    ctx.translate(-finalSize / 2, -finalSize / 2);        // shift back; drawing (0,0) = top-left

    // Draw each panel at its % coords scaled to finalSize
    all.forEach((item, idx) => {
      const px = (item.cx / 100) * finalSize - (item.w / 100 * finalSize) / 2;
      const py = (item.cy / 100) * finalSize - (item.h / 100 * finalSize) / 2;
      const pw = (item.w / 100) * finalSize;
      const ph = (item.h / 100) * finalSize;
      const itemRot = (item.rot || 0) * Math.PI / 180;

      ctx.save();
      // Rotate around panel center
      if (itemRot) {
        ctx.translate(px + pw / 2, py + ph / 2);
        ctx.rotate(itemRot);
        ctx.translate(-pw / 2, -ph / 2);
      } else {
        ctx.translate(px, py);
      }

      // Compute color
      const gradAngle = 80 + (idx * 47) % 200;
      const fillStyle = makeCanvasFill(ctx, item.color, palette, gradAngle, item.cellIndex, pw, ph);

      const radius = item.r;
      const isLite = pw < (finalSize * 0.06);  // tiny dots — simpler render

      // === LAYER 1: Base fill ===
      drawPanelPath(ctx, 0, 0, pw, ph, radius, seed, idx);
      ctx.fillStyle = fillStyle;
      ctx.fill();

      if (!isLite) {
        // === LAYER 2: Inner top highlight (replaces inset top white shadow) ===
        // Upper ~25% of panel gets a white gradient fade
        ctx.save();
        drawPanelPath(ctx, 0, 0, pw, ph, radius, seed, idx);
        ctx.clip();
        const innerTop = ctx.createLinearGradient(0, 0, 0, ph * 0.5);
        innerTop.addColorStop(0,    'rgba(255,255,255,0.85)');
        innerTop.addColorStop(0.15, 'rgba(255,255,255,0.45)');
        innerTop.addColorStop(0.5,  'rgba(255,255,255,0.08)');
        innerTop.addColorStop(1,    'rgba(255,255,255,0)');
        ctx.fillStyle = innerTop;
        ctx.fillRect(0, 0, pw, ph * 0.5);
        ctx.restore();

        // === LAYER 3: Inner bottom shadow (depth) ===
        ctx.save();
        drawPanelPath(ctx, 0, 0, pw, ph, radius, seed, idx);
        ctx.clip();
        const innerBot = ctx.createLinearGradient(0, ph * 0.6, 0, ph);
        innerBot.addColorStop(0, 'rgba(0,0,0,0)');
        innerBot.addColorStop(1, 'rgba(0,0,0,0.18)');
        ctx.fillStyle = innerBot;
        ctx.fillRect(0, ph * 0.6, pw, ph * 0.4);
        ctx.restore();

        // === LAYER 4: Diagonal sheen via overlay blend ===
        ctx.save();
        drawPanelPath(ctx, 0, 0, pw, ph, radius, seed, idx);
        ctx.clip();
        ctx.globalCompositeOperation = 'overlay';
        const sheen = ctx.createLinearGradient(0, 0, pw, ph);
        sheen.addColorStop(0,    'rgba(255,255,255,0)');
        sheen.addColorStop(0.22, 'rgba(255,255,255,0.35)');
        sheen.addColorStop(0.32, 'rgba(255,255,255,0.75)');
        sheen.addColorStop(0.4,  'rgba(255,255,255,0.30)');
        sheen.addColorStop(0.55, 'rgba(255,255,255,0)');
        ctx.fillStyle = sheen;
        ctx.fillRect(0, 0, pw, ph);
        ctx.restore();

        // === LAYER 5: Convex radial top-center highlight (overlay) ===
        ctx.save();
        drawPanelPath(ctx, 0, 0, pw, ph, radius, seed, idx);
        ctx.clip();
        ctx.globalCompositeOperation = 'overlay';
        const radial = ctx.createRadialGradient(pw * 0.5, ph * 0.3, 0, pw * 0.5, ph * 0.3, Math.max(pw, ph) * 0.65);
        radial.addColorStop(0,   'rgba(255,255,255,0.55)');
        radial.addColorStop(0.4, 'rgba(255,255,255,0.18)');
        radial.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.fillStyle = radial;
        ctx.fillRect(0, 0, pw, ph);
        ctx.restore();
      }

      // === LAYER 6: Outer border (subtle white edge) ===
      drawPanelPath(ctx, 0, 0, pw, ph, radius, seed, idx);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = Math.max(0.5, pw * 0.006);
      ctx.stroke();

      ctx.restore();
    });

    ctx.restore();
  }

  // Build a path on the context for a panel — ellipse, rounded rect, or blob.
  function drawPanelPath(ctx, x, y, w, h, r, seed, idx) {
    ctx.beginPath();
    if (r >= 49) {
      // Perfect ellipse
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else if (r >= 30 && w > 8) {
      // Asymmetric blob — approximate with rounded rect at avg radius
      const sr = mulberry32(seed + idx * 37 + 1);
      const radii = [];
      for (let i = 0; i < 8; i++) radii.push((35 + sr() * 35) / 100);
      // Use 4 corners (canvas roundedRect supports per-corner radii in newer browsers)
      const rTL = radii[0] * Math.min(w, h);
      const rTR = radii[1] * Math.min(w, h);
      const rBR = radii[2] * Math.min(w, h);
      const rBL = radii[3] * Math.min(w, h);
      if (ctx.roundRect) {
        ctx.roundRect(x, y, w, h, [rTL, rTR, rBR, rBL]);
      } else {
        // Fallback: simple round rect
        const avg = (rTL + rTR + rBR + rBL) / 4;
        roundedRect(ctx, x, y, w, h, avg);
      }
    } else if (r > 0) {
      const rad = (r / 100) * Math.min(w, h);
      if (ctx.roundRect) ctx.roundRect(x, y, w, h, rad);
      else roundedRect(ctx, x, y, w, h, rad);
    } else {
      ctx.rect(x, y, w, h);
    }
  }

  function roundedRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
  }

  // Resolve color to a canvas-compatible fill style (string or CanvasGradient)
  function makeCanvasFill(ctx, name, palette, gradientAngle, cellIdx, w, h) {
    const v = palette[name];
    if (v === '__GRAM_VARIABLE__') {
      const idx = cellIdx != null ? cellIdx : 0;
      return idx % 2 === 0 ? palette._gramPlus : palette._gramMinus;
    }
    if (Array.isArray(v)) {
      // Multi-stop gradient
      const angle = (gradientAngle != null ? gradientAngle : 145) * Math.PI / 180;
      const dx = Math.cos(angle), dy = Math.sin(angle);
      const cx = w / 2, cy = h / 2;
      const half = Math.max(w, h) / 2;
      const x0 = cx - dx * half, y0 = cy - dy * half;
      const x1 = cx + dx * half, y1 = cy + dy * half;
      const grad = ctx.createLinearGradient(x0, y0, x1, y1);
      v.forEach((color, i) => grad.addColorStop(i / (v.length - 1), color));
      return grad;
    }
    return v || name;
  }

  // ============================================================
  // EXPORT
  // ============================================================
  window.BiomEngine = {
    renderSpecimen,
    renderSpecimenToCanvas,
    generateState,
    pickName,
    mixPalettes,
    PALETTES,
    PALETTE_WEIGHTS,
    MORPHOLOGY_WEIGHTS,
    RESERVE_WEIGHTS,
    LIFECYCLE_WEIGHTS,
  };
})();
