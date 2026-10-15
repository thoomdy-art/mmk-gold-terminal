const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Fetch OANDA:XAUUSD Live Price from TradingView Scanner API
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
        close: metrics[0],
        open: metrics[1],
        high: metrics[2],
        low: metrics[3],
        change: metrics[4]
      });
    } else {
      res.status(404).json({ error: "Symbol not found" });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Fetch Binance P2P MMK with Strict Absolute Maximum Sorting
app.get("/api/mmk-p2p", async (req, res) => {
  let bankBuyMax = 4575;
  let bankSellMax = 4535;
  let walletBuyMid = 4520;
  let walletSellMid = 4490;

  try {
    const fetchAllPrices = async (tradeType, payTypes) => {
      const response = await fetch("https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0"
        },
        body: JSON.stringify({
          fiat: "MMK",
          page: 1,
          rows: 20,
          tradeType,
          asset: "USDT",
          payTypes,
          publisherType: "merchant"
        })
      });
      const json = await response.json();
      return (json?.data || []).map(item => parseFloat(item.adv.price)).filter(Boolean);
    };

    const bankBuyPrices = await fetchAllPrices("BUY", ["KBZBank", "CBBank", "BANK", "AYABank", "YomaBank"]);
    const bankSellPrices = await fetchAllPrices("SELL", ["KBZBank", "CBBank", "BANK", "AYABank", "YomaBank"]);
    const walletBuyPrices = await fetchAllPrices("BUY", ["KBZPay", "WavePay", "AYAPay"]);
    const walletSellPrices = await fetchAllPrices("SELL", ["KBZPay", "WavePay", "AYAPay"]);

    if (bankBuyPrices.length > 0) { bankBuyPrices.sort((a, b) => b - a); bankBuyMax = bankBuyPrices[0]; }
    if (bankSellPrices.length > 0) { bankSellPrices.sort((a, b) => b - a); bankSellMax = bankSellPrices[0]; }
    if (walletBuyPrices.length > 0) { walletBuyPrices.sort((a, b) => a - b); walletBuyMid = walletBuyPrices[Math.floor(walletBuyPrices.length / 2)]; }
    if (walletSellPrices.length > 0) { walletSellPrices.sort((a, b) => a - b); walletSellMid = walletSellPrices[Math.floor(walletSellPrices.length / 2)]; }

  } catch (e) {
    console.log("P2P live fetch warning, using baseline.");
  }

  res.json({
    bankMax: { buy: bankBuyMax, sell: bankSellMax },
    walletMiddle: { buy: walletBuyMid, sell: walletSellMid }
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
