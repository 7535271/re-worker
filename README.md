# frctlns

**Find two moments in time that overlap.** Look at both through the same windows, as each looked at 00:00, and at what came after each.

- **Live app:** https://re-worker.stella-753-5271.workers.dev/
- **Demo video:** *(link)*
- **Built for** Build with CMC: API Hackathon (DoraHacks, September 2026) · **Track:** Data and Visualisation

frctlns observes; it does not predict. It is not investment advice.

*The name:* frctlns is “fractal lens” with only its consonants left, always written in lowercase.

## What you do

1. **Choose where to stand.** Pick a coin (BTC, ETH, XRP, SOL or DOGE). Then roll a day 🎲 and let chance pick one, or follow a word (a topic or an event) to the days it left traces. Once you are on a day, you can turn its date to any other day.
2. **See the places that overlap.** Other days that overlap with yours are listed with the most overlap first. Each place is tagged with how it overlaps: *at 00:00*, *afterwards*, *N windows*, or the *“word”*.
3. **Open a pair.** Both days, side by side:
   - **What overlapped?** How much the two days overlap, each way.
   - **Why this pair?** Exactly what was compared.
   - **What happened next.** Both days on one chart, with the compared stretch shaded.
   - **Look around.** Both days through the same windows, as each looked at 00:00.
4. **Keep wandering.** Step to the next place, or explore either day: the windows at 00:00, what happened next, and what moved with it.

The coin, the day, the word and the pair are all in the address, so a shared link opens the same view.

## Why CMC

frctlns looks at each moment through several windows, and CoinMarketCap is the market window. Its daily history says where the market stood at 00:00 on any day, and how the price moved afterwards. Those are two of the ways two days can overlap. The other windows look at the same days from other directions.

From CMC, frctlns keeps its own archive of every day of five coins (Bitcoin, Ethereum, XRP, Solana, Dogecoin), as far back as CMC has them. For each day it stores price, volume, market cap, daily range, 24h / 7d / 30d change, and CMC's Fear & Greed index (which starts on 2023-06-29).

## How overlaps are found

For the day you stand on, frctlns looks three ways at once, or four when you came with a word:

- **At 00:00.** Where the market stood over the 7 days up to each day. The measures are price, market cap, volume, volatility and 24h / 7d / 30d change, each as a place within its own past year, and Fear & Greed on its own 0–100 scale. Only what was out by 00:00 UTC of each day is used. An earlier day counts only if its own next 30 days had already happened. Near the start of the archive, where fewer than five earlier days qualify, later days fill in and are shown as later.
- **Afterwards** *(hindsight)*. The shape of the price from 2 days before to a week after. Only the shape counts, so a smaller move, or one that took half or twice as long, can still match.
- **Together** *(hindsight)*. The set of windows that made an unusual jump on the day or the day after, found again on another day. An unusual jump is a change at least 3× that window's usual day-to-day change over the year before.
- **The word.** The days a word left public traces: its English Wikipedia article read far more than usual (from 2015-07-01), or a Hacker News story with it in the title at its most points. These are found with today's records, so this is not an event detector.

Every place found is listed (for a word, up to five of its other days), and the order is the mean of the three measures. Only what both days have is compared, and a day is compared only if at least half of the market can be compared. Everything that uses what came after a day is marked as hindsight. The at-00:00 comparison never uses it.

The full rules are in the app's Observatory (*Everything behind the overlaps*).

## Every window has its own clock

“At 00:00” means the newest day each window had published by 00:00 UTC on the day you stand on.

| Window | Source | At 00:00 on day D it shows |
|---|---|---|
| Market | CoinMarketCap API | D itself: quotes at D 00:00, and the candle that closed at the end of D−1 |
| Attention | Wikimedia pageviews | D−2 |
| Bitcoin network | Blockchain.com | D−2 |
| Hacker News | HN Search (Algolia) | D−1 |
| X | X search (a link only; nothing is read from X) | a link to search D−1 |
| Money | ECB rates via Frankfurter | the last business day |
| Earth | USGS earthquake catalog | D−1 |
| Sky | NASA Astronomy Picture of the Day | D−1 |
| Weather | Open-Meteo | D−2 |

Two more groups are used only in hindsight, in *What moved with it?* and in the *Together* search: Nasdaq, VIX and the US dollar index (FRED), and all of English Wikipedia. Fear & Greed covers the whole crypto market and the Bitcoin network is Bitcoin's own chain, so both are the same for every coin.

## Under the hood

### Architecture

- A **Cloudflare Worker** (free plan) calls the CMC API and the other sources, and serves the page.
- **Workers KV** holds the archive: one box per coin per year. A cron job runs every 5 minutes and does one unit of work for one coin: it fills a missing year, or re-fetches the recent days (from 10 days ago to today). A failed fetch never overwrites stored data.
- The **page** loads a coin's archive once. All market comparisons run in the browser (`public/engine.js`, pure functions), so moving between days needs no CMC call and no credits.

### How CMC is used

| Endpoint | Used for |
|---|---|
| `GET /v3/cryptocurrency/quotes/historical` | price, 24h volume, market cap, 24h / 7d / 30d change |
| `GET /v2/cryptocurrency/ohlcv/historical` | daily high / low → the daily range |
| `GET /v3/fear-and-greed/historical` | the Fear & Greed axis |
| `GET /v3/fear-and-greed/latest` | a log of when each Fear & Greed value first appears |

Every call goes through one function, `hit()` in `src/worker.js`. It records the request and the response. The key lives only in a Cloudflare secret (`CMC_KEY`) and is sent only in the request header, so it never appears in a URL or in the recorded responses.

```js
async function hit(env, path, params) {
  const url = new URL(CMC + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const r = await fetch(url.toString(), {
    headers: { "X-CMC_PRO_API_KEY": env.CMC_KEY, Accept: "application/json" },
  });
  // … returns { request: { endpoint, params, url, at }, response: { http_status, status, data } }
}
```

### Evidence: real responses

Three real responses, called on 2026-09-28, are saved in [`evidence/`](evidence/). Every request returned HTTP 200 and used 1 credit.

**Quotes, Bitcoin, March 2020** ([full response](evidence/quotes-historical-btc-2020-03.json))

`GET /v3/cryptocurrency/quotes/historical?id=1&time_start=2020-03-01&time_end=2020-03-31&interval=daily&convert=USD`

```json
{ "quotes": [
  { "timestamp": "2020-03-12T00:00:00.000Z", "quote": { "USD": { "price": 7921.32151425, "percent_change_24h": 0.242782560997 } } },
  { "timestamp": "2020-03-13T00:00:00.000Z", "quote": { "USD": { "price": 5032.35707012, "percent_change_24h": -36.47073836017 } } }
] }
```

**OHLCV, same request** ([full response](evidence/ohlcv-historical-btc-2020-03.json))

```json
{ "time_open": "2020-03-12T00:00:00.000Z", "time_close": "2020-03-12T23:59:59.999Z",
  "quote": { "USD": { "open": 7913.61638784, "high": 7929.11601884, "low": 4860.35383012, "close": 4970.78790105 } } }
```

**Fear & Greed, the whole history** ([summary of all pages](evidence/fear-and-greed-historical-all.json))

3 pages of `GET /v3/fear-and-greed/historical` (`start=1`, `501`, `1001`; `limit=500`): 1,187 days from 2023-06-29 to 2026-09-27, with no missing, duplicate or off-midnight days.

```json
{ "status": { "error_code": "0", "error_message": "", "credit_count": 1 } }
```

### What the API made possible, and where it was hard

CMC's daily history, back to 2013, is what makes it possible to stand on any day and see the market as it was at 00:00. It is also small enough to keep whole: every day of five coins fits in the Worker's free storage, so the browser can compare every day with every other day without another call.

What we had to learn by reading raw responses:

- **The same date means different moments.** A daily quote for D is the snapshot at D 00:00. The daily OHLCV row for D is the candle that closes at D 23:59:59.999. In the evidence above, the 2020-03-12 crash appears in the quote for **03-13** 00:00 (−36.5% in 24h), while the OHLCV row labeled **03-12** already contains the whole fall. Putting both on the same day would let the daily range look one day into the future, so OHLCV is aligned to D−1.
- **`time_start` is exclusive.** Asking from 2020-03-01 returns data from 03-02 (see both files). frctlns asks for quotes from one day earlier and for OHLCV from two days earlier.
- **Use `id`, not `symbol`.** `symbol=BTC` also returns unrelated tokens with the same symbol.
- **Fear & Greed must be paged.** It comes newest first, up to 500 rows per page, so finding where it starts means paging to the end. Its `error_code` is the string `"0"`, while the other endpoints return the number `0`.
- **Recent Fear & Greed values arrive late,** so the archive re-fetches the last 10 days, and `/v3/fear-and-greed/latest` is logged to see when each value first appears.
- **The key has an end date** (see Limits). Because frctlns keeps its own archive instead of calling CMC for each view, it keeps working after that.

### Tests

Offline tests with simulated services (Node 22.12 or newer, no network, no key):

```
node test/run.js             # archive, cron, five coins, time alignment, errors, key expiry
node test/engine.js          # no future leakage, strict time, the 50% rule, the overlap measures
node test/moments.js         # the days of a word, attention per coin, FRED, Hacker News counts
node test/compare.js         # comparing through other windows without looking ahead
node test/scene.js           # the windows of a day, their clocks, caching, failures
node test/window-series.js   # the numeric windows
node test/windows.js         # the probes of each source
node test/dates.js           # date arithmetic
node test/ui-walk.js         # the whole app at iPhone size in a headless browser (needs Playwright; set its path in the file)
```

<details>
<summary>Worker endpoints, repository layout, deploy</summary>

| Path | Returns |
|---|---|
| `/` | the app (`public/`) |
| `/api` | the list of endpoints |
| `/series?id=1` | every stored day of one coin, from the archive (no CMC call); ids 1, 1027, 52, 5426, 74 |
| `/scene?day=YYYY-MM-DD` | that day through the other windows, with each window's clock |
| `/window-series?w=…` | every day's value of one numeric window |
| `/moments?q=…` | the days a word left public traces |
| `/talk?q=…&day=…` | daily counts of Hacker News stories with the word in the title, from 7 days before a day to 30 days after |
| `/archive/status` | what the archive holds, what is missing, recent errors |
| `/probe/btc`, `/probe/ohlcv`, `/probe/fng` | raw CMC responses; every Fear & Greed page, summarized (the evidence above) |
| `/probe/*` | raw responses from the other sources |

```
wrangler.toml       Worker config: static assets (public/), KV binding, cron
src/worker.js       CMC calls, the archive, the other windows, cron, API
public/index.html   the page
public/app.js       the screens
public/engine.js    the overlap measures and strict time, as pure functions
evidence/           saved CMC responses
test/               offline tests
```

Deploy: Cloudflare Workers with Git integration (a commit to `main` deploys). Add the secret `CMC_KEY`, create a KV namespace and put its id in `wrangler.toml`, then let the cron fill the archive.

</details>

## Limits

- **The CMC key expires on 2026-10-08.** After that, frctlns keeps working from its archive, but no new days are added, and *Latest* stays on the last stored day. The live CMC probes (`/probe/btc`, `/probe/ohlcv`, `/probe/fng`) stop returning data, and the saved copies in `evidence/` remain.
- **Windows are uneven.** They differ in how far back they go (Attention from 2015-07-01, Fear & Greed from 2023-06-29), in how late they publish, and in whether they are revised later. Earlier days have fewer windows open.
- **Some past days can only be shown as recorded today.** This applies to earthquakes, Hacker News points, the Bitcoin network and recent weather, and these are marked in Explore.
- **Some clocks are still being measured.** frctlns takes each Fear & Greed value at its timestamp (D 00:00 UTC), and uses safe delays for Attention, the Bitcoin network and the weather. When each value really first appears is being logged (`/probe/fng-timing`, `/probe/published`).
- **A word finds traces, not events.**
- frctlns is not a complete record of the world. It is a place to explore time through a few windows, and what it shows are observations, not predictions.

## How it was made

Built through an ongoing collaboration between Shu, GPT (Nova) and Claude (Stella). Ideas, research, implementation, testing and interpretation were developed iteratively across all three.

- Shu shaped the direction and made the final decisions.
- Nova contributed to conceptual development, research and analysis.
- Stella contributed to implementation, testing and documentation.

Data: CoinMarketCap API · Wikimedia · FRED (Federal Reserve Bank of St. Louis) · Blockchain.com · HN Search (Algolia) · Open-Meteo · NASA APOD · USGS · ECB via Frankfurter · X (link only).
