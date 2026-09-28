# evidence

Real CoinMarketCap API responses, saved on 2026-09-28 from the Worker's `/probe` pages. The API key is not in them: it is sent only in the request header.

- `quotes-historical-btc-2020-03.json`: `/probe/btc` (`/v3/cryptocurrency/quotes/historical`, Bitcoin, March 2020)
- `ohlcv-historical-btc-2020-03.json`: `/probe/ohlcv` (`/v2/cryptocurrency/ohlcv/historical`, same request)
- `fear-and-greed-historical-all.json`: `/probe/fng` (every page of `/v3/fear-and-greed/historical`, summarized)

The first two were copied from a phone, and the last few closing brackets were cut off. Only those brackets were added back; every value is as the API returned it.
