/**
 * POST /api/render
 *
 * Cloudflare Pages Function. Renders a single Bioms specimen via Cloudflare
 * Browser Rendering REST API and returns a PNG. The whole point is to get
 * the real CSS backdrop-filter glass effect that the local canvas renderer
 * in make.html cannot replicate.
 *
 * Body (JSON):
 *   { seed, w, h, tx, ty, scale, rotation, flipX, flipY }
 *
 * Required environment variables (set in Pages → Settings → Environment vars):
 *   CF_ACCOUNT_ID  — plain text
 *   CF_API_TOKEN   — secret, token must have "Browser Rendering: Edit"
 *
 * Notes:
 * - Workers Paid plan is required for Browser Rendering.
 * - render.html (same origin) is the page Chromium opens. It signals readiness
 *   by setting body[data-ready="1"]; we wait on that before screenshotting.
 * - Light per-IP cap to discourage abuse; tune as needed.
 */

const MAX_DIM       = 4000;       // hard cap per side; 4000×4000 = 16MP
const MAX_PIXELS    = 8_000_000;  // soft cap on w*h
const SCREENSHOT_MS = 25_000;     // BR API call timeout

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  // === Origin check (cheap CSRF / abuse barrier) ===
  const allowedOrigins = new Set([
    'https://thebioms.com',
    'https://www.thebioms.com',
  ]);
  const origin = request.headers.get('Origin') || '';
  const isPagesPreview = /\.pages\.dev$/.test(new URL(origin || 'http://x').hostname || '');
  if (origin && !allowedOrigins.has(origin) && !isPagesPreview) {
    return json({ error: 'origin-not-allowed' }, 403);
  }

  // === Config check ===
  if (!env.CF_ACCOUNT_ID || !env.CF_API_TOKEN) {
    return json({
      error: 'browser-rendering-not-configured',
      hint:  'Set CF_ACCOUNT_ID and CF_API_TOKEN env vars in Pages dashboard.',
    }, 503);
  }

  // === Parse + validate body ===
  let body;
  try { body = await request.json(); }
  catch { return json({ error: 'invalid-json' }, 400); }

  const seed = clamp(int(body.seed, 0),      0, 2999);
  const w    = clamp(int(body.w,   1500),   64, MAX_DIM);
  const h    = clamp(int(body.h,   500),    64, MAX_DIM);
  if (w * h > MAX_PIXELS) {
    return json({ error: 'too-large', max_pixels: MAX_PIXELS }, 400);
  }
  const tx       = num(body.tx, 0);
  const ty       = num(body.ty, 0);
  const scale    = clamp(num(body.scale, 1),     0.05, 5);
  const rotation = clamp(num(body.rotation, 0), -360, 360);
  const flipX    = Math.sign(num(body.flipX, 1)) || 1;
  const flipY    = Math.sign(num(body.flipY, 1)) || 1;

  // === Build render URL on the same origin ===
  const renderUrl = new URL('/render.html', request.url);
  renderUrl.searchParams.set('seed', String(seed));
  renderUrl.searchParams.set('w',    String(w));
  renderUrl.searchParams.set('h',    String(h));
  renderUrl.searchParams.set('tx',   String(tx));
  renderUrl.searchParams.set('ty',   String(ty));
  renderUrl.searchParams.set('scale', String(scale));
  renderUrl.searchParams.set('rot',  String(rotation));
  renderUrl.searchParams.set('fx',   String(flipX));
  renderUrl.searchParams.set('fy',   String(flipY));

  // === Call Browser Rendering REST API ===
  const brEndpoint =
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
    `/browser-rendering/screenshot`;

  const brPayload = {
    url: renderUrl.toString(),
    viewport: { width: w, height: h, deviceScaleFactor: 1 },
    screenshotOptions: {
      type: 'png',
      omitBackground: false,
      clip: { x: 0, y: 0, width: w, height: h },
    },
    waitForSelector: { selector: 'body[data-ready="1"]', timeout: 15_000 },
    gotoOptions: { waitUntil: 'networkidle0', timeout: 15_000 },
  };

  const controller = new AbortController();
  const killTimer  = setTimeout(() => controller.abort(), SCREENSHOT_MS);
  let resp;
  try {
    resp = await fetch(brEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body:   JSON.stringify(brPayload),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(killTimer);
    return json({ error: 'render-fetch-failed', detail: String(e && e.message || e) }, 502);
  }
  clearTimeout(killTimer);

  if (!resp.ok) {
    const text = await safeText(resp);
    return json({ error: 'browser-rendering-error', status: resp.status, body: text }, 502);
  }

  const png = await resp.arrayBuffer();
  return new Response(png, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `inline; filename="bioms-biom-${seed}-${w}x${h}.png"`,
      'Cache-Control': 'public, max-age=300',
      ...corsHeaders(origin),
    },
  });
}

// Browsers send a CORS preflight before the POST.
export function onRequestOptions({ request }) {
  const origin = request.headers.get('Origin') || '';
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

// === helpers ===
function int(v, dflt)   { const n = parseInt(v, 10);   return Number.isFinite(n) ? n : dflt; }
function num(v, dflt)   { const n = parseFloat(v);     return Number.isFinite(n) ? n : dflt; }
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
async function safeText(r) { try { return await r.text(); } catch { return ''; } }

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
