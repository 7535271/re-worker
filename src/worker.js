/* ──────────────────────────────────────────
   RE: — worker (MarketState 正規化フェーズ)
   CMC の生データを「その時点で観測できた世界の状態」に畳む。
   欠測は 0 にせず ABSENT として保持する。
   ────────────────────────────────────────── */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};
const CMC = "https://pro-api.coinmarketcap.com";

function out(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

/* CMC を叩いて request/response を丸ごと記録して返す（probe と同じ） */
async function hit(env, path, params) {
  const url = new URL(CMC + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const started = new Date().toISOString();
  let status, body;
  try {
    const r = await fetch(url.toString(), {
      headers: { "X-CMC_PRO_API_KEY": env.CMC_KEY, Accept: "application/json" },
    });
    status = r.status;
    const text = await r.text();
    try { body = JSON.parse(text); } catch { body = { _unparsed: text.slice(0, 2000) }; }
  } catch (e) {
    status = -1;
    body = { _fetch_error: String(e && e.message ? e.message : e) };
  }
  return {
    request: { endpoint: path, params, url: url.toString(), at: started },
    response: {
      http_status: status,
      status: body && body.status ? body.status : null,
      data: body && "data" in body ? body.data : body,
    },
  };
}

/* ── 時代境界 ──
   実測で分かった。ここより前は Fear & Greed がそもそも存在しない。
   500件の範囲で最古 2025-05-08 を確認済み。より古い有無は未確定なので、
   「確実に存在する」と言える境界としてこの日を使う。 */
const FNG_KNOWN_FROM = Date.parse("2025-05-08T00:00:00Z");

/* 観測できた1軸。値があるか、あっても閉じているか、そもそも無いか。 */
function axis(value, state) {
  if (state === "absent") return { state: "absent", value: null };
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { state: "absent", value: null };
  }
  return { state: state || "on", value };
}

/* ── MarketState ──
   ある1日の、RE: が観測できた世界の状態。
   全項目が埋まる必要はない。埋まらない軸は absent のまま持つ。 */
function buildMarketState(dayISO, opts) {
  const t = Date.parse(dayISO);
  const q = opts.quote;   // quotes/historical の 1 スナップショット
  const o = opts.ohlcv;   // ohlcv の 1 日分
  const f = opts.fng;     // その日の Fear & Greed 値

  // volatility は CMC からは来ない。high/low から出す。
  let volatility = null;
  if (o && o.high != null && o.low != null && o.low !== 0) {
    volatility = (o.high - o.low) / o.low;
  }

  // sentiment は時代で存在可否が変わる。境界より前は問答無用で absent。
  const sentimentAbsent = t < FNG_KNOWN_FROM;

  return {
    timestamp: dayISO,
    axes: {
      price:      axis(q ? q.price : (o ? o.close : null), "on"),
      volume:     axis(q ? q.volume : (o ? o.volume : null), "on"),
      market_cap: axis(q ? q.market_cap : (o ? o.market_cap : null), "on"),
      volatility: axis(volatility, "on"),
      change_24h: axis(q ? q.percent_change_24h : null, "on"),
      change_7d:  axis(q ? q.percent_change_7d : null, "on"),
      change_30d: axis(q ? q.percent_change_30d : null, "on"),
      sentiment:  sentimentAbsent ? axis(null, "absent") : axis(f, "on"),
      attention:  axis(null, "absent"), // 外部ソース未接続。後で Wikimedia が埋める枠
    },
  };
}

/* 生データを「YYYY-MM-DD → 値」の対応表にする */
function dayKey(iso) { return String(iso).slice(0, 10); }

/* CMC は聞き方で返事の形が変わる。
   symbol=BTC → data: { "BTC": [ {quotes}, {偽トークン}, ... ] }
   id=1       → data: { "1": {quotes} }  または data: {quotes}
   どの形でも、本物（id=1 か、quotes が入っている最初の1件）の行を拾う。 */
function extractRows(data, wantId) {
  if (!data) return [];
  if (Array.isArray(data.quotes)) return data.quotes;

  const candidates = [];
  for (const v of Object.values(data)) {
    if (Array.isArray(v)) candidates.push(...v);
    else if (v && typeof v === "object") candidates.push(v);
  }
  const want = String(wantId);
  const exact = candidates.find(
    (c) => String(c.id) === want && Array.isArray(c.quotes) && c.quotes.length
  );
  if (exact) return exact.quotes;
  const any = candidates.find((c) => Array.isArray(c.quotes) && c.quotes.length);
  return any ? any.quotes : [];
}

function pickQuotes(data, wantId) {
  const arr = extractRows(data, wantId);
  const m = new Map();
  for (const row of arr) {
    const usd = row.quote && row.quote.USD ? row.quote.USD : null;
    if (!usd) continue;
    m.set(dayKey(row.timestamp), {
      price: usd.price ?? null,
      volume: usd.volume_24h ?? usd.volume ?? null,
      market_cap: usd.market_cap ?? null,
      percent_change_24h: usd.percent_change_24h ?? null,
      percent_change_7d: usd.percent_change_7d ?? null,
      percent_change_30d: usd.percent_change_30d ?? null,
    });
  }
  return m;
}

function pickOhlcv(data, wantId) {
  const arr = extractRows(data, wantId);
  const m = new Map();
  for (const row of arr) {
    const usd = row.quote && row.quote.USD ? row.quote.USD : null;
    if (!usd) continue;
    const stamp = usd.timestamp || row.time_close || row.time_open;
    m.set(dayKey(stamp), {
      high: usd.high ?? null, low: usd.low ?? null,
      close: usd.close ?? null, volume: usd.volume ?? null,
      market_cap: usd.market_cap ?? null,
    });
  }
  return m;
}

function pickFng(data) {
  const arr = Array.isArray(data) ? data : [];
  const m = new Map();
  for (const row of arr) {
    const secs = Number(row.timestamp);
    if (!secs) continue;
    m.set(dayKey(new Date(secs * 1000).toISOString()), Number(row.value));
  }
  return m;
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname;
    if (!env.CMC_KEY) return out({ error: "CMC_KEY not set in Secrets" }, 400);

    try {
      if (p === "/" || p === "") {
        return out({
          endpoints: [
            "/probe/btc, /probe/ohlcv, /probe/fng — 生レスポンス確認",
            "/state?id=1&start=2020-03-01&end=2020-03-31 — MarketState を組んで返す",
          ],
          note: "id=1 が本物の Bitcoin。symbol=BTC は偽トークンが混ざるので必ず id 指定。",
        });
      }

      if (p === "/probe/btc") {
        return out(await hit(env, "/v3/cryptocurrency/quotes/historical",
          { id: 1, time_start: "2020-03-01", time_end: "2020-03-31", interval: "daily", convert: "USD" }));
      }
      if (p === "/probe/ohlcv") {
        return out(await hit(env, "/v2/cryptocurrency/ohlcv/historical",
          { id: 1, time_start: "2020-03-01", time_end: "2020-03-31", interval: "daily", convert: "USD" }));
      }
      if (p === "/probe/fng") {
        const r = await hit(env, "/v3/fear-and-greed/historical", { start: 1, limit: 500 });
        const d = r.response.data;
        let oldest = null, newest = null, n = 0;
        if (Array.isArray(d) && d.length) {
          n = d.length; oldest = d[d.length - 1].timestamp; newest = d[0].timestamp;
        }
        return out({ ...r, _summary: { count: n, oldest, newest } });
      }

      /* ── MarketState を組む ── */
      if (p === "/state") {
        const id = url.searchParams.get("id") || "1";     // 既定は本物の Bitcoin
        const start = url.searchParams.get("start") || "2020-03-01";
        const end = url.searchParams.get("end") || "2020-03-31";

        const [q, o, f] = await Promise.all([
          hit(env, "/v3/cryptocurrency/quotes/historical",
            { id, time_start: start, time_end: end, interval: "daily", convert: "USD" }),
          hit(env, "/v2/cryptocurrency/ohlcv/historical",
            { id, time_start: start, time_end: end, interval: "daily", convert: "USD" }),
          hit(env, "/v3/fear-and-greed/historical", { start: 1, limit: 500 }),
        ]);

        const qi = pickQuotes(q.response.data, id);
        const oi = pickOhlcv(o.response.data, id);
        const fi = pickFng(f.response.data);

        const days = [...qi.keys()].sort();
        const states = days.map((day) =>
          buildMarketState(day + "T00:00:00Z", {
            quote: qi.get(day) || null,
            ohlcv: oi.get(day) || null,
            fng: fi.has(day) ? fi.get(day) : null,
          })
        );

        // どの軸がどれだけ埋まったか（時代で sentiment が absent に寄るのが見える）
        const axis_summary = {};
        for (const s of states) {
          for (const [k, a] of Object.entries(s.axes)) {
            axis_summary[k] = axis_summary[k] || { on: 0, off: 0, absent: 0 };
            axis_summary[k][a.state]++;
          }
        }

        return out({
          meta: {
            id, start, end, days: states.length,
            credits: {
              quotes: q.response.status && q.response.status.credit_count,
              ohlcv: o.response.status && o.response.status.credit_count,
              fng: f.response.status && f.response.status.credit_count,
            },
          },
          axis_summary,
          sample: states[0] || null,
          states,
        });
      }

      return out({ error: "not found", try: "/" }, 404);
    } catch (e) {
      return out({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
