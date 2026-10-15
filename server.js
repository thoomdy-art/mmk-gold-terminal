const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ---------- OANDA:XAUUSD (unchanged) ----------
app.get("/api/oanda-gold", async (req, res) => {
  try {
    const response = await fetch("https://scanner.tradingview.com/cfd/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbols: { tickers: ["OANDA:XAUUSD"] },
        columns: ["close", "open", "high", "low", "change"]
      })
    });
    const data = await response.json();
    if (data && data.data && data.data.length > 0) {
      const metrics = data.data[0].d;
      res.json({
        close: metrics[0], open: metrics[1], high: metrics[2], low: metrics[3], change: metrics[4]
      });
    } else {
      res.status(404).json({ error: "Symbol not found" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Binance P2P (cached, stale-on-error, optional push) ----------
const P2P_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const BANKS = ['KBZBank', 'CBBank', 'BANK', 'AYABank', 'YomaBank'];
const WALLETS = ['KBZPay', 'WavePay', 'AYAPay'];
const GROUPS = {
  bankBuy: ['BUY', BANKS], bankSell: ['SELL', BANKS],
  walletBuy: ['BUY', WALLETS], walletSell: ['SELL', WALLETS],
};
const TTL = 5 * 60 * 1000;          // hit Binance at most once per 5 min, however many visitors
const RETRY_GAP = 60 * 1000;        // after a failure, wait 60s before trying again
const PUSH_FRESH = 15 * 60 * 1000;  // trust data pushed from your own PC for 15 min

let cache = null;       // { bankBuy:[], bankSell:[], walletBuy:[], walletSell:[], updatedAt, source }
let lastErrors = [];
let lastTry = 0;
let inflight = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function p2pRequest(tradeType, payTypes, extra = {}) {
  const r = await fetch(P2P_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Origin': 'https://p2p.binance.com',
      'Referer': 'https://p2p.binance.com/en',
      'clienttype': 'web',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
    body: JSON.stringify({ fiat: 'MMK', page: 1, rows: 50, tradeType, asset: 'USDT', payTypes, publisherType: null, ...extra }),
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);               // 403/451/429 = blocked or rate limited
  return r.json();
}

async function fetchGroup(tradeType, payTypes) {
  const j = await p2pRequest(tradeType, payTypes);
  const prices = (j.data || []).map(i => parseFloat(i.adv.price)).filter(Boolean);
  if (!prices.length) throw new Error(`no ads returned (Binance code=${j.code}, message=${j.message}, total=${j.total})`);
  return prices;
}

// Open /api/p2p-debug: runs test requests to find out WHY MMK ads come back empty.
app.get('/api/p2p-debug', async (req, res) => {
  const FULL = { countries: [], proMerchantAds: false, shieldMerchantAds: false, filterType: 'all', periods: [], additionalKycVerifyFilter: 0 };
  const tests = {
    MMK_simple: { extra: {} },
    MMK_full: { extra: FULL },
    THB_simple: { extra: { fiat: 'THB' } },
  };
  const out = {};
  try {
    const g = await (await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) })).json();
    out.server = { ip: g.ip, country: g.country, region: g.region, org: g.org };
  } catch (e) { out.server = { error: e.message }; }
  for (const [name, { extra }] of Object.entries(tests)) {
    try {
      const j = await p2pRequest('BUY', [], extra);
      const methods = {};
      for (const a of j.data || []) for (const m of (a.adv.tradeMethods || [])) methods[m.identifier] = m.tradeMethodName;
      out[name] = { code: j.code, message: j.message, total: j.total, ads: (j.data || []).length, methods };
    } catch (e) { out[name] = { error: e.message }; }
    await sleep(300);
  }
  res.json(out);
});

// Sequential on purpose. Returns whatever groups succeeded + error messages.
async function fetchAll() {
  const data = {}, errors = [];
  for (const [key, [type, pay]] of Object.entries(GROUPS)) {
    try { data[key] = await fetchGroup(type, pay); }
    catch (e) { errors.push(`${key}: ${e.message}`); }
    await sleep(300);
  }
  return { data, errors };
}

function refreshP2P() {
  if (inflight) return inflight;
  lastTry = Date.now();
  inflight = fetchAll().then(({ data, errors }) => {
    lastErrors = errors;
    if (Object.keys(data).length) {
      cache = { ...(cache || {}), ...data, updatedAt: Date.now(), source: 'server' };
    }
  }).finally(() => { inflight = null; });
  return inflight;
}

app.get('/api/p2p', async (req, res) => {
  const age = cache ? Date.now() - cache.updatedAt : Infinity;
  const pushedFresh = cache && cache.source === 'push' && age < PUSH_FRESH;
  if (!pushedFresh && age > TTL && Date.now() - lastTry > RETRY_GAP) await refreshP2P();
  if (!cache) return res.status(503).json({ error: 'P2P unavailable', errors: lastErrors });
  // Stale data is still served; the page shows how old it is. `errors` tells you WHY it's stale.
  res.json({ ...cache, ageSec: Math.round((Date.now() - cache.updatedAt) / 1000), errors: lastErrors });
});

// Lets a PC/Pi with a Thai home IP feed prices in (see p2p-pusher.js). Set PUSH_TOKEN in Render env vars.
app.post('/api/p2p-push', (req, res) => {
  const token = process.env.PUSH_TOKEN;
  if (!token || req.get('x-push-token') !== token) return res.status(401).json({ error: 'unauthorized' });
  const clean = {};
  for (const key of Object.keys(GROUPS)) {
    const arr = Array.isArray(req.body[key]) ? req.body[key].map(Number).filter(n => n > 0) : [];
    if (!arr.length) return res.status(400).json({ error: `missing ${key}` });
    clean[key] = arr;
  }
  cache = { ...clean, updatedAt: Date.now(), source: 'push' };
  res.json({ ok: true });
});

module.exports = { fetchAll };

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
