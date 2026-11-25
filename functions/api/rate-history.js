// Cloudflare Pages Function: GET /api/rate-history
//
// Keeps one saved USDT/MMK "bank" rate per UTC day (last ~45 days) in Cloudflare KV,
// so the Kyat chart can use each day's own rate instead of today's rate for every day.
//
// Setup (once): Cloudflare dashboard -> Workers & Pages -> KV -> create a namespace,
// then your Pages project -> Settings -> Bindings -> add a KV namespace binding named RATES.
// Without that binding this endpoint answers { configured:false } and the site keeps working.
//
// How days get saved: whenever the chart asks for the history and today's rate is missing
// (or older than 30 minutes), the function fetches the live rate from the price server in the
// background and overwrites today's record. The last save of the day is the day's rate.

const PRICE_SERVER = 'https://mmk-gold-terminal.onrender.com/api/p2p';
const KEEP_DAYS = 45;                 // records expire by themselves after this
const SHOW_DAYS = 31;                 // how many days the chart can read
const REFRESH_MS = 30 * 60 * 1000;    // refresh today's record at most every 30 minutes
const CACHE_SECONDS = 300;            // browsers / edge reuse the answer for 5 minutes

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const json = (body, status = 200, cache = 'no-store') => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache }
});

// Same rule the website uses for its live rate: Bybit first, then OKX, then the server's reference.
export function pickRates(p2p) {
  const bank = positive(p2p?.bybit?.buy) ?? positive(p2p?.okx?.buy) ?? positive(p2p?.reference?.buy);
  const sell = positive(p2p?.bybit?.sell) ?? positive(p2p?.okx?.sell) ?? positive(p2p?.reference?.sell);
  return { bank, sell };
}

export async function saveToday(env, now = Date.now()) {
  const res = await fetch(PRICE_SERVER, { signal: AbortSignal.timeout(25000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('price server HTTP ' + res.status);
  const { bank, sell } = pickRates(await res.json());
  if (!bank) throw new Error('no usable rate');

  // Safety net: ignore a rate that is wildly different from the last saved day (bad scrape).
  const yesterday = await env.RATES.get('rate:' + dayKey(now - 86400000), 'json');
  if (yesterday?.bank && Math.abs(bank / yesterday.bank - 1) > 0.35) throw new Error('rate looks wrong, not saved');

  const date = dayKey(now);
  await env.RATES.put('rate:' + date, JSON.stringify({ date, bank, sell, savedAt: now }), {
    expirationTtl: KEEP_DAYS * 86400
  });
}

export async function onRequestGet({ request, env, waitUntil }) {
  if (!env || !env.RATES) return json({ configured: false, days: [] });

  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(new URL(request.url).origin + '/api/rate-history');
  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const now = Date.now();
  const keys = [];
  for (let i = 0; i < SHOW_DAYS; i++) keys.push('rate:' + dayKey(now - i * 86400000));
  const records = await Promise.all(keys.map((k) => env.RATES.get(k, 'json').catch(() => null)));
  const days = records
    .filter((r) => r && r.date && r.bank > 0)
    .map((r) => ({ date: r.date, bank: r.bank, sell: r.sell || null }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const today = records[0];
  if (!today || now - Number(today.savedAt || 0) > REFRESH_MS) {
    waitUntil(saveToday(env, now).catch((e) => console.warn('[rate-history] save failed:', e.message)));
  }

  const response = json({ configured: true, days, generatedAt: now }, 200, `public, max-age=${CACHE_SECONDS}`);
  if (cache) waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
