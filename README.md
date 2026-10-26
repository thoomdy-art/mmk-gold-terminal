# mmk-gold-terminal
## Canonical gold reference API

`GET /api/gold-reference` returns one calculated snapshot of the reference gold prices used by the main gold table. It includes the source timestamp, OANDA XAU/USD close/bid/ask, the selected USDT/MMK P2P rates (Bybit first, then OKX, then the combined reference), the formulas, and calculated buy/sell prices for the old standard, new standard, 15-pae-yay, and PAXG.

Use this endpoint as the single source of truth when quoting the site's gold reference prices externally. Prices are reference calculations, not gold-shop quotes; source outages may make the endpoint unavailable or leave the P2P source stale.
