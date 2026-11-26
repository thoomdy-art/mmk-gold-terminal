// Cloudflare Worker: saves the USDT/MMK bank rate once a day on a schedule (cron),
// whether or not anyone visits the site. It writes to the same KV namespace (binding name RATES)
// that the site's /api/rate-history uses, with the same record format.
//
// Schedule: 30 11 * * *  = 11:30 UTC = 6:00 PM Myanmar time, every day.
// If the price server (Render) is asleep it waits and tries again, up to 3 tries.

const PRICE_SERVER = 'https://mmk-gold-terminal.onrender.com/api/p2p';
const KEEP_DAYS = 45;

const dayKey = (t) => new Date(t).toISOString().slice(0, 10);
const positive = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same rule the website uses: Bybit first, then OKX, then the server's reference rate.
export function pickRates(p2p) {
  const bank = positive(p2p?.bybit?.buy) ?? positive(p2p?.okx?.buy) ?? positive(p2p?.reference?.buy);
  const sell = positive(p2p?.bybit?.sell) ?? positive(p2p?.okx?.sell) ?? positive(p2p?.reference?.sell);
  return { bank, sell };
}

async function saveOnce(env, now) {
  const res = await fetch(PRICE_SERVER, { signal: AbortSignal.timeout(45000), headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('price server HTTP ' + res.status);
  const { bank, sell } = pickRates(await res.json());
  if (!bank) throw new Error('no usable rate');

  // Safety net: ignore a rate that is wildly different from yesterday's saved one (bad data).
  const yesterday = await env.RATES.get('rate:' + dayKey(now - 86400000), 'json');
  if (yesterday?.bank && Math.abs(bank / yesterday.bank - 1) > 0.35) throw new Error('rate looks wrong, not saved');

  const date = dayKey(now);
  await env.RATES.put('rate:' + date, JSON.stringify({ date, bank, sell, savedAt: now }), {
    expirationTtl: KEEP_DAYS * 86400
  });
  return { date, bank, sell };
}

export async function saveRate(env, { tries = 3, pauseMs = 15000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const saved = await saveOnce(env, Date.now());
      await env.RATES.put('status:lastRun', JSON.stringify({ ok: true, at: Date.now(), attempt, saved }));
      return saved;
    } catch (e) {
      lastError = e;
      if (attempt < tries) await sleep(pauseMs);
    }
  }
  await env.RATES.put('status:lastRun', JSON.stringify({ ok: false, at: Date.now(), error: String((lastError && lastError.message) || lastError) }));
  return null;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(saveRate(env));
  },
  // Opening the Worker's address shows when it last ran (it does not run the job).
  async fetch(request, env) {
    if (!env.RATES) return new Response('KV binding "RATES" is missing on this Worker.', { status: 500 });
    const status = await env.RATES.get('status:lastRun');
    return new Response(status || JSON.stringify({ ok: null, note: 'Has not run yet. It runs daily at 11:30 UTC (6:00 PM Myanmar time).' }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
};
