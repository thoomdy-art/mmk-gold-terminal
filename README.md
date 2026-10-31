# mmk-gold-terminal
## Canonical gold reference API

`GET /api/gold-reference` returns one calculated snapshot of the reference gold prices used by the main gold table. It includes the source timestamp, OANDA XAU/USD close/bid/ask, the selected USDT/MMK P2P rates (Bybit first, then OKX, then the combined reference), the formulas, and calculated buy/sell prices for the old standard, new standard, 15-pae-yay, and PAXG.

Use this endpoint as the single source of truth when quoting the site's gold reference prices externally. Prices are reference calculations, not gold-shop quotes; source outages may make the endpoint unavailable or leave the P2P source stale.


## Historical market comparison chart

`GET /api/market-history?range=1y` returns indexed daily series for DXY (`DX-Y.NYB`), XAU/USD (`XAUUSD=X`), the site's archived USDT/MMK P2P reference, and implied Myanmar gold (XAU/USD × USDT/MMK). Supported ranges: `1m`, `3m`, `6m`, `1y`, `2y`, `5y`. DXY and XAU/USD history is retrieved from Yahoo Finance chart data and cached for 10 minutes.

The site archives the OKX/Bybit P2P reference about every 15 minutes, then uses the last available snapshot each UTC day for the comparison chart. P2P history starts only after this version is deployed; no older P2P history is fabricated. To preserve the archive across Render restarts and deploys, attach a Render Persistent Disk mounted at `/var/data` and add the environment variable `DATA_DIR=/var/data`. Without that disk, the archive is stored in the service filesystem and can be lost on restart.

The comparison chart rebases each series to 100 at its first available point in the selected range. It is intended to compare percentage movement, not absolute price levels.
