const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Fetch OANDA:XAUUSD Live Price
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server listening on port ${PORT}`);
});
