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

app.get('/api/binance-p2p', async (req, res) => {
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


// ---------- OKX + Bybit P2P (server-side, cached for 15 minutes) ----------
// The browser calls this Render endpoint, so exchange requests do not depend on
// a third-party CORS proxy. Prices are medians of valid advertised prices.
const P2P_CACHE_TTL = 15 * 60 * 1000;
let p2pCache = null;
let p2pUpdatedAt = 0;
let p2pLastErrors = [];
let p2pInFlight = null;

function median(values) {
  const sorted = values.map(Number).filter(n => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The median of 50 ads is dragged away from the real market by stale/low-quality ads deep in
// the book. Real P2P screens show the best ads first, so use the median of the TOP_N best ones.
// 'buy' = customer buys USDT (cheapest ads best), 'sell' = customer sells USDT (highest ads best).
const TOP_N = 8;
function topMedian(values, side) {
  const sorted = values.map(Number).filter(n => Number.isFinite(n) && n > 0)
    .sort((a, b) => side === 'sell' ? b - a : a - b);
  return median(sorted.slice(0, TOP_N));
}

function validPrices(items) {
  return (Array.isArray(items) ? items : [])
    .map(item => Number(item && (item.price ?? item.adv?.price ?? item.advertisement?.price)))
    .filter(n => Number.isFinite(n) && n > 0);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(12000),
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; MMKGoldTerminal/1.0)',
      ...(options.headers || {})
    }
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 180)}`);
  try { return JSON.parse(body); }
  catch { throw new Error(`Non-JSON response: ${body.slice(0, 120)}`); }
}

async function fetchOkxSide(side) {
  const url = new URL('https://www.okx.com/v3/c2c/tradingOrders/books');
  url.search = new URLSearchParams({
    quoteCurrency: 'MMK',
    baseCurrency: 'USDT',
    side,
    paymentMethod: 'all',
    userType: 'all',
    limit: '20'
  }).toString();
  const json = await fetchJson(url.toString(), { headers: { 'Referer': 'https://www.okx.com/' } });
  const data = json?.data;
  // OKX returns ad books grouped by side. The requested book is preferred,
  // with alternate common response shapes handled for resilience.
  const candidates = side === 'sell'
    ? [data?.sell, data?.sellOrders, data?.sellList, data?.data?.sell, data?.list]
    : [data?.buy, data?.buyOrders, data?.buyList, data?.data?.buy, data?.list];
  const ads = candidates.find(Array.isArray) || [];
  return validPrices(ads);
}

// Bybit: the old /v5/p2p/item/online endpoint needs a signed API key, so it always fails.
// The public web endpoint is api2.bybit.com/fiat/otc/item/online (what bybit.com itself uses).
// Bybit sits behind CloudFront and blocks many datacenter/US IPs, so we try alternate
// domains and an optional proxy (BYBIT_PROXY_URL, e.g. a Cloudflare Worker that forwards the request).
const BYBIT_HOSTS = [
  'https://api2.bybit.com',
  'https://api2.bytick.com',
];
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function bybitBody(side) {
  return {
    userId: '',
    tokenId: 'USDT',
    currencyId: 'MMK',
    payment: [],
    side,            // '1' = customer buys USDT, '0' = customer sells USDT
    size: '50',
    page: '1',
    amount: '',
    authMaker: false,
    canTrade: false,
  };
}

async function bybitOnce(base, side) {
  const json = await fetchJson(`${base}/fiat/otc/item/online`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Origin': 'https://www.bybit.com',
      'Referer': 'https://www.bybit.com/',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': BROWSER_UA,
      'platform': 'web',
    },
    body: JSON.stringify(bybitBody(side)),
  });
  const code = json?.ret_code ?? json?.retCode;
  if (code !== undefined && Number(code) !== 0) {
    throw new Error(`Bybit code ${code}: ${json.ret_msg || json.retMsg || 'request failed'}`);
  }
  const items = json?.result?.items || json?.result?.data || json?.items || [];
  return validPrices(items);
}

async function fetchBybitSide(side) {
  const bases = [...new Set([process.env.BYBIT_PROXY_URL, ...BYBIT_HOSTS].filter(Boolean))];
  const errs = [];
  for (const base of bases) {
    try {
      const prices = await bybitOnce(base.replace(/\/$/, ''), side);
      if (prices.length) return prices;
      errs.push(`${base}: no ads`);
    } catch (e) {
      errs.push(`${base}: ${e.message}`);
    }
  }
  throw new Error(errs.join(' | '));
}

async function collectP2P() {
  const errors = [];
  const tasks = [
    ['okxBuy', () => fetchOkxSide('sell')], // advertiser sells USDT; customer buys USDT
    ['okxSell', () => fetchOkxSide('buy')], // advertiser buys USDT; customer sells USDT
    ['bybitBuy', () => fetchBybitSide('1')],
    ['bybitSell', () => fetchBybitSide('0')]
  ];
  const result = {
    okx: { buy: null, sell: null, buyCount: 0, sellCount: 0 },
    bybit: { buy: null, sell: null, buyCount: 0, sellCount: 0 },
    reference: { buy: null, sell: null },
    updatedAt: Date.now(),
    source: 'OKX + Bybit P2P',
    errors: []
  };
  const raw = { okxBuy: [], okxSell: [], bybitBuy: [], bybitSell: [] };
  for (const [key, task] of tasks) {
    try {
      raw[key] = await task();
      if (!raw[key].length) errors.push(`${key}: exchange returned no usable MMK ads`);
    } catch (err) {
      errors.push(`${key}: ${err.message}`);
    }
  }
  result.okx.buy = topMedian(raw.okxBuy, 'buy');
  result.okx.sell = topMedian(raw.okxSell, 'sell');
  result.okx.buyCount = raw.okxBuy.length;
  result.okx.sellCount = raw.okxSell.length;
  result.bybit.buy = topMedian(raw.bybitBuy, 'buy');
  result.bybit.sell = topMedian(raw.bybitSell, 'sell');
  result.bybit.buyCount = raw.bybitBuy.length;
  result.bybit.sellCount = raw.bybitSell.length;
  // Central reference = median of all usable advertised prices on both exchanges,
  // calculated separately for the customer-buy and customer-sell sides.
  result.reference.buy = median([result.okx.buy, result.bybit.buy]);
  result.reference.sell = median([result.okx.sell, result.bybit.sell]);
  // Keep last good value for a side that failed this round instead of showing "—".
  const prev = p2pCache;
  if (prev) {
    for (const ex of ['okx', 'bybit']) {
      for (const k of ['buy', 'sell']) {
        if (result[ex][k] == null && prev[ex] && prev[ex][k] != null) {
          result[ex][k] = prev[ex][k];
          result[ex][k + 'Count'] = prev[ex][k + 'Count'] || 0;
          result[ex].stale = true;
        }
      }
    }
    result.reference.buy = result.reference.buy ?? prev.reference?.buy ?? null;
    result.reference.sell = result.reference.sell ?? prev.reference?.sell ?? null;
  }
  result.errors = errors;
  result.updatedAt = Date.now();
  return result;
}

app.get('/api/p2p', async (req, res) => {
  const ttl = p2pLastErrors.length ? 2 * 60 * 1000 : P2P_CACHE_TTL; // retry sooner after a failure
  const fresh = p2pCache && Date.now() - p2pUpdatedAt < ttl;
  if (!fresh) {
    if (!p2pInFlight) {
      p2pInFlight = collectP2P()
        .then(data => {
          p2pCache = data;
          p2pUpdatedAt = Date.now();
          p2pLastErrors = data.errors;
        })
        .catch(err => { p2pLastErrors = [err.message]; })
        .finally(() => { p2pInFlight = null; });
    }
    await p2pInFlight;
  }
  if (!p2pCache) {
    return res.status(503).json({
      error: 'P2P prices unavailable',
      errors: p2pLastErrors,
      hint: 'Check Render logs and /api/p2p-status.'
    });
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    ...p2pCache,
    ageSec: Math.max(0, Math.round((Date.now() - p2pUpdatedAt) / 1000)),
    cacheTtlSec: Math.max(0, Math.ceil((P2P_CACHE_TTL - (Date.now() - p2pUpdatedAt)) / 1000))
  });
});

app.get('/api/p2p-status', (req, res) => {
  res.json({
    hasCache: Boolean(p2pCache),
    updatedAt: p2pUpdatedAt || null,
    ageSec: p2pUpdatedAt ? Math.round((Date.now() - p2pUpdatedAt) / 1000) : null,
    cacheTtlSec: P2P_CACHE_TTL / 1000,
    errors: p2pLastErrors,
    data: p2pCache ? {
      okx: p2pCache.okx,
      bybit: p2pCache.bybit,
      reference: p2pCache.reference
    } : null
  });
});


module.exports = { fetchAll };

if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
