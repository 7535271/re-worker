/* ──────────────────────────────────────────
   RE: — worker (MarketState 正規化フェーズ)
   CMC の生データを「その時点で観測できた世界の状態」に畳む。
   欠測は 0 にせず ABSENT として保持する。

   ── 時間の定義（2026-09-23、probe の実測で確定）──
   MarketState[D] = D日 00:00 UTC の時点で観測できた状態。
     quotes : D日 00:00:00 のスナップショット
     OHLCV  : D-1日の確定足（足は閉じた瞬間 = D日 00:00 に見えるようになる）
     F&G    : D日 00:00 UTC に記録された値
   「D日が終わった時点」という定義もあり得る。RE: は
   「その時点から見えていた世界 → その後」を見るので、起点の側を選んだ。
   ────────────────────────────────────────── */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};
const CMC = "https://pro-api.coinmarketcap.com";
const DAY = 86400000;
const DEFINITION =
  "MarketState[D] = what was observable at 00:00 UTC on day D. " +
  "quotes: the snapshot at D 00:00 / OHLCV: the candle that closed at the end of D-1 / " +
  "Fear & Greed: the value recorded at D 00:00.";

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

/* 上流（CMC）の調子を短くまとめる。キーの期限切れなどが起きたらここに出る。 */
function upstream(r) {
  const st = r.response.status || {};
  return {
    http_status: r.response.http_status,
    error_code: st.error_code ?? null,
    error_message: st.error_message ?? null,
  };
}

/* ── 日付 ── */
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function dayKey(iso) { return String(iso).slice(0, 10); }
function dayStart(ymd) { return Date.parse(ymd + "T00:00:00Z"); }
function shiftDay(ymd, n) { return dayKey(new Date(dayStart(ymd) + n * DAY).toISOString()); }
function isDay(s) {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const t = dayStart(s);
  // 2020-02-30 のような「存在しない日」を弾く
  return Number.isFinite(t) && dayKey(new Date(t).toISOString()) === s;
}
function isMidnight(iso) { return String(iso).endsWith("T00:00:00.000Z"); }
function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
function num(v) { return v === null || v === undefined || v === "" ? null : Number(v); }

/* 観測できた1軸。値があるか、あっても閉じているか、そもそも無いか。 */
function axis(value, state) {
  if (state === "absent") return { state: "absent", value: null };
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { state: "absent", value: null };
  }
  return { state: state || "on", value };
}

/* ── MarketState ──
   ある1日の、RE: が観測できた世界の状態（D日 00:00 UTC 時点）。
   全項目が埋まる必要はない。埋まらない軸は absent のまま持つ。 */
function buildMarketState(day, opts) {
  const q = opts.quote;   // D日 00:00 のスナップショット
  const o = opts.ohlcv;   // D-1日の確定足
  const f = opts.fng;     // D日 00:00 の Fear & Greed

  // volatility は CMC からは来ない。前日の確定足の high/low から出す。
  let volatility = null;
  if (o && o.high != null && o.low != null && o.low !== 0) {
    volatility = (o.high - o.low) / o.low;
  }

  // sentiment は時代で存在可否が変わる。F&G の最古日より前は absent。
  // 最古日は実データから決める（ハードコードしない）。
  const beforeFng = !opts.fngFrom || day < opts.fngFrom;

  return {
    timestamp: day + "T00:00:00Z",
    axes: {
      price:      axis(q ? q.price : (o ? o.close : null), "on"),
      volume:     axis(q ? q.volume : (o ? o.volume : null), "on"),
      market_cap: axis(q ? q.market_cap : (o ? o.market_cap : null), "on"),
      volatility: axis(volatility, "on"),
      change_24h: axis(q ? q.percent_change_24h : null, "on"),
      change_7d:  axis(q ? q.percent_change_7d : null, "on"),
      change_30d: axis(q ? q.percent_change_30d : null, "on"),
      sentiment:  beforeFng ? axis(null, "absent") : axis(f ? f.value : null, "on"),
      attention:  axis(null, "absent"), // 外部ソース未接続。後で Wikimedia が埋める枠
    },
  };
}

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

/* quotes: D日 00:00 のスナップショットを D に置く */
function pickQuotes(data, wantId) {
  const arr = extractRows(data, wantId);
  const map = new Map();
  let offMidnight = 0;
  for (const row of arr) {
    const usd = row.quote && row.quote.USD ? row.quote.USD : null;
    if (!usd || !row.timestamp) continue;
    if (!isMidnight(row.timestamp)) offMidnight++;
    map.set(dayKey(row.timestamp), {
      ts: row.timestamp,
      price: usd.price ?? null,
      volume: usd.volume_24h ?? usd.volume ?? null,
      market_cap: usd.market_cap ?? null,
      percent_change_24h: usd.percent_change_24h ?? null,
      percent_change_7d: usd.percent_change_7d ?? null,
      percent_change_30d: usd.percent_change_30d ?? null,
    });
  }
  return { map, offMidnight };
}

/* OHLCV: 足は閉じた瞬間に見えるようになる。
   3/1 の足（3/1 00:00〜23:59:59.999）は 3/2 00:00 に確定する → MarketState[3/2] に置く。 */
function pickOhlcv(data, wantId) {
  const arr = extractRows(data, wantId);
  const map = new Map();
  for (const row of arr) {
    const usd = row.quote && row.quote.USD ? row.quote.USD : null;
    if (!usd) continue;
    const candle = row.time_open ? dayKey(row.time_open)
      : row.time_close ? dayKey(row.time_close) : null;
    if (!candle || !isDay(candle)) continue;
    map.set(shiftDay(candle, 1), {
      candle,
      high: usd.high ?? null, low: usd.low ?? null,
      close: usd.close ?? null, volume: usd.volume ?? null,
      market_cap: usd.market_cap ?? null,
    });
  }
  return map;
}

/* ── Fear & Greed ──
   新しい順に 500 件ずつしか返らない。最古日を知るには最後までページを送る。
   1ページ 1 クレジット。 */
const FNG_LIMIT = 500;
const FNG_MAX_PAGES = 20;

async function fetchAllFng(env) {
  const rows = [];
  const pages = [];
  let credits = 0;
  for (let i = 0; i < FNG_MAX_PAGES; i++) {
    const start = i * FNG_LIMIT + 1;
    const r = await hit(env, "/v3/fear-and-greed/historical", { start, limit: FNG_LIMIT });
    const st = r.response.status;
    const d = r.response.data;
    const n = Array.isArray(d) ? d.length : 0;
    credits += Number(st && st.credit_count) || 0;
    pages.push({ request: r.request, http_status: r.response.http_status, status: st, count: n });
    if (n) rows.push(...d);
    if (n < FNG_LIMIT) break;
  }
  return { rows, pages, credits };
}

/* 日付ごとに並べて、欠け・重複・00:00 ちょうどじゃない記録を洗い出す。
   ここでは直さない。見えるようにするだけ（直し方は実データを見てから決める）。 */
function analyzeFng(rows) {
  const byDay = new Map();
  const seen = new Set();
  const offMidnight = [];
  let exactRepeats = 0;
  for (const row of rows) {
    const secs = Number(row && row.timestamp);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    const ts = new Date(secs * 1000).toISOString();
    if (seen.has(ts)) { exactRepeats++; continue; } // ページの境目で同じ行が2回来た場合
    seen.add(ts);
    if (!isMidnight(ts)) offMidnight.push(ts);
    const day = dayKey(ts);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push({ ts, value: num(row.value), label: row.value_classification ?? null });
  }
  const keys = [...byDay.keys()].sort();
  const oldest = keys.length ? keys[0] : null;
  const newest = keys.length ? keys[keys.length - 1] : null;

  // 1日に2件以上あったら、その日の 00:00 に一番近い記録を採る（定義に合わせる）
  const pick = new Map();
  const duplicates = [];
  for (const day of keys) {
    const list = byDay.get(day);
    if (list.length > 1) duplicates.push({ day, entries: list });
    const t0 = dayStart(day);
    let best = list[0];
    for (const e of list) {
      if (Math.abs(Date.parse(e.ts) - t0) < Math.abs(Date.parse(best.ts) - t0)) best = e;
    }
    pick.set(day, best);
  }

  const missing = [];
  if (oldest) {
    for (let t = dayStart(oldest); t <= dayStart(newest); t += DAY) {
      const k = dayKey(new Date(t).toISOString());
      if (!byDay.has(k)) missing.push(k);
    }
  }
  return { pick, oldest, newest, days: keys.length, missing, duplicates, offMidnight, exactRepeats };
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
          name: "RE: — A Temporal Exploration Playground (worker)",
          definition: DEFINITION,
          endpoints: [
            "/state?id=1&start=YYYY-MM-DD&end=YYYY-MM-DD — MarketState for every day from start to end (both inclusive; start and end are required)",
            "/probe/btc, /probe/ohlcv — raw CMC responses (evidence)",
            "/probe/fng — every Fear & Greed page, with oldest/newest, missing and duplicate days (?raw=1 for every row)",
          ],
          note: "id=1 is the real Bitcoin. symbol=BTC also returns unrelated tokens with the same symbol, so always use id.",
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
        const fr = await fetchAllFng(env);
        const fa = analyzeFng(fr.rows);
        const cap = (arr, n) => ({ count: arr.length, items: arr.slice(0, n) });
        const body = {
          _summary: {
            count: fr.rows.length,
            distinct_days: fa.days,
            oldest: fa.oldest,
            newest: fa.newest,
            span_days: fa.oldest ? (dayStart(fa.newest) - dayStart(fa.oldest)) / DAY + 1 : 0,
            missing_days: cap(fa.missing, 200),
            duplicate_days: cap(fa.duplicates, 50),
            off_midnight: cap(fa.offMidnight, 50),
            exact_repeats: fa.exactRepeats,
            pages: fr.pages.length,
            credits: fr.credits,
          },
          pages: fr.pages,
          newest_rows: fr.rows.slice(0, 2),
          oldest_rows: fr.rows.slice(-2),
        };
        if (url.searchParams.get("raw") === "1") body.rows = fr.rows;
        return out(body);
      }

      /* ── MarketState を組む ── */
      if (p === "/state") {
        const sp = url.searchParams;
        const id = sp.get("id") || "1"; // 既定は本物の Bitcoin（既定を使ったことは meta.defaults に出す）
        const start = sp.get("start");
        const end = sp.get("end");

        // 入力の欠測も黙って埋めない。無い・形が違う・逆順なら 400 で返す。
        const problems = [];
        if (!/^\d+$/.test(id)) problems.push("id must be a numeric CMC id (1 = Bitcoin)");
        if (!isDay(start)) problems.push("start is required as YYYY-MM-DD");
        if (!isDay(end)) problems.push("end is required as YYYY-MM-DD");
        if (!problems.length && start > end) problems.push("start must be on or before end");
        if (problems.length) {
          return out({
            error: "bad parameters",
            problems,
            received: { id: sp.get("id"), start, end },
            raw_query: decodeSafe(url.search),
            example: "/state?id=1&start=2020-03-01&end=2020-03-31",
          }, 400);
        }

        // CMC の time_start は「その日を含まない」（実測）。
        // start 当日を含めるため、quotes は1日前から、OHLCV は前日の足が要るので2日前から取る。
        const [qr, orr, fr] = await Promise.all([
          hit(env, "/v3/cryptocurrency/quotes/historical",
            { id, time_start: shiftDay(start, -1), time_end: end, interval: "daily", convert: "USD" }),
          hit(env, "/v2/cryptocurrency/ohlcv/historical",
            { id, time_start: shiftDay(start, -2), time_end: shiftDay(end, -1), interval: "daily", convert: "USD" }),
          fetchAllFng(env),
        ]);

        const qp = pickQuotes(qr.response.data, id);
        const qi = qp.map;
        const oi = pickOhlcv(orr.response.data, id);
        const fa = analyzeFng(fr.rows);

        const days = [...qi.keys()].filter((d) => d >= start && d <= end).sort();
        const states = days.map((day) =>
          buildMarketState(day, {
            quote: qi.get(day) || null,
            ohlcv: oi.get(day) || null,
            fng: fa.pick.get(day) || null,
            fngFrom: fa.oldest,
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

        // 最初の1日だけ、どの生データから組んだかを添える（時間の対応を目で確かめる用）
        let sample = null;
        if (days.length) {
          const d0 = days[0];
          const q0 = qi.get(d0), o0 = oi.get(d0), f0 = fa.pick.get(d0);
          sample = {
            ...states[0],
            _trace: {
              quote_snapshot: q0 ? q0.ts : null,
              ohlcv_candle: o0 ? o0.candle : null,
              fng_recorded: f0 ? f0.ts : null,
            },
          };
        }

        return out({
          meta: {
            id, start, end, days: states.length,
            defaults: sp.get("id") ? [] : ["id"],
            definition: DEFINITION,
            credits: {
              quotes: qr.response.status && qr.response.status.credit_count,
              ohlcv: orr.response.status && orr.response.status.credit_count,
              fng: fr.credits,
            },
            upstream: { quotes: upstream(qr), ohlcv: upstream(orr), fng_pages: fr.pages.length },
            fng: {
              from: fa.oldest,
              to: fa.newest,
              gaps_in_range: fa.missing.filter((d) => d >= start && d <= end),
            },
            quotes_off_midnight: qp.offMidnight,
          },
          axis_summary,
          sample,
          states,
        });
      }

      return out({ error: "not found", try: "/" }, 404);
    } catch (e) {
      return out({ error: String(e && e.message ? e.message : e) }, 500);
    }
  },
};
