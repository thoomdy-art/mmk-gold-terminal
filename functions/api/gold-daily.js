// Cloudflare Pages Function: GET /api/gold-daily
// Daily spot-gold (XAU/USD) closes for the last ~2 months, so the chart's Old/New Standard
// lines use spot gold while the PAXG line keeps using PAXG closes.
// If Yahoo is unreachable this answers { days: {} } and the site falls back to PAXG closes.

const URL_YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?range=2mo&interval=1d';
const CACHE_SECONDS = 1800;

const json = (body, cache) => new Response(JSON.stringify(body), {
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache }
});

// Yahoo stamps forex days near midnight UTC; +12h makes both 23:00 and 00:00 land on the right day.
export function parseYahoo(payload) {
  const r = payload?.chart?.result?.[0];
  const closes = r?.indicators?.quote?.[0]?.close || [];
  const days = {};
  (r?.timestamp || []).forEach((t, i) => {
    const v = Number(closes[i]);
    if (Number.isFinite(v) && v > 0) days[new Date((t + 43200) * 1000).toISOString().slice(0, 10)] = Math.round(v * 100) / 100;
  });
  return days;
}

export async function onRequestGet({ request, waitUntil }) {
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).origin + '/api/gold-daily');
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }
  let days = {};
  try {
    const res = await fetch(URL_YAHOO, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MyanmarGoldPrice/1.0)' },
      signal: AbortSignal.timeout(15000)
    });
    if (res.ok) days = parseYahoo(await res.json());
  } catch (e) { console.warn('[gold-daily] failed:', e.message); }

  const ok = Object.keys(days).length > 0;
  const response = json({ source: 'Yahoo Finance XAUUSD=X', days }, `public, max-age=${ok ? CACHE_SECONDS : 120}`);
  if (cache) waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
