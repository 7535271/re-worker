/* ──────────────────────────────────────────
   RE: — worker (v3: 観測の倉庫)
   CMC の生データを「その時点で観測できた世界の状態」に畳む。
   欠測は 0 にせず ABSENT として保持する。

   ── 時間の定義（2026-09-23、probe の実測で確定）──
   MarketState[D] = D日 00:00 UTC の時点で観測できた状態。
     quotes : D日 00:00:00 のスナップショット
     OHLCV  : D-1日の確定足（足は閉じた瞬間 = D日 00:00 に見えるようになる）
     F&G    : D日 00:00 UTC の記録。timestamp を観測時点として採用（暫定）。
              実際にいつ API に出て、どの時点の値と一致するかは
              /probe/fng-timing で測っている（2026-09-25〜）
   「D日が終わった時点」という定義もあり得る。RE: は
   「その時点から見えていた世界 → その後」を見るので、起点の側を選んだ。

   ── 観測の倉庫（Workers KV、2026-09-25）──
   一度取った過去を KV にしまい、/series はそこから返す（CMC を叩かない）。
     series:v1:<id>:<年>  1年1箱。軸ごとの列（配列）で持つ
     meta:v1:<id>         どの年があるか、補充の進み具合、最近のエラー
     fng-timing:v1        F&G がいつ API に出たかの観測ログ
   cron（毎時 5分・35分）が、足りない年を新しい順に1年ずつ埋める。
   埋まったら、直近 TAIL_DAYS 日だけを1時間ごとに取り直して差し込む。
   過去の年の箱は、埋まったら基本もう触らない。
   取れなかった値で、しまってある観測を消さない（欠測を 0 にしないのと同じ）。
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
const FNG_TIME_NOTE =
  "For now RE: takes the Fear & Greed timestamp (D 00:00 UTC) as the moment of observation. " +
  "/probe/fng-timing checks this against what the API actually shows over time.";

const AXES = [
  "price", "volume", "market_cap", "volatility",
  "change_24h", "change_7d", "change_30d",
  "sentiment", "attention",
];
const MARKET_AXES = AXES.slice(0, 7); // quotes と OHLCV から来る軸

/* ── 倉庫の設定 ── */
const ARCHIVE_IDS = ["1"];      // 倉庫に置く資産（1 = 本物の Bitcoin）
const ARCHIVE_V = "v1";         // 箱の形を変えたら v2 にして作り直す
const FIRST_YEAR = 2013;        // CMC の日次は 2013年4月から
const TAIL_DAYS = 10;           // 直近この日数は、値が後から届くことがあるので取り直す
const REFRESH_EVERY_MIN = 55;   // cron: 直近の取り直しはこれより頻繁にしない
const MANUAL_REFRESH_MIN = 10;  // /archive/step: 同上（連打しても無駄撃ちしない）
const CRON = "5,35 * * * *";    // wrangler.toml と同じもの（表示用）
const TIMING_KEY = "fng-timing:v1";
const MAX_LIVE = 1500;          // F&G latest の記録の上限（2日より古いものは 00:00 前後だけ残す）
const MAX_FIRST_SEEN = 180;
const MAX_REVISIONS = 100;
const ARCHIVE_LAYOUT =
  "years[i] is one calendar year. years[i].axes[axis][j] is the value on day (years[i].from + j days). " +
  "null = ABSENT (nothing was observable). An axis that is ABSENT for the whole year is stored as null instead of an array.";

function out(o, status = 200) {
  return new Response(JSON.stringify(o, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

function nowMs() { return Date.now(); }
function iso(ms) { return new Date(ms).toISOString(); }

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
/* error_code は数値の 0 のときと、文字列の "0" のときがある（F&G だけ文字列） */
function isOk(r) {
  if (!r || r.response.http_status !== 200) return false;
  const st = r.response.status;
  return !st || st.error_code === null || st.error_code === undefined || Number(st.error_code) === 0;
}
function creditsOf(r) {
  return Number(r && r.response.status && r.response.status.credit_count) || 0;
}

/* ── 日付 ──
   日付は「1970-01-01 から何日目か」の整数で計算する（Date を作らないので速い。
   無料プランの CPU 10ms に収めるため）。 */
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function dayKey(isoString) { return String(isoString).slice(0, 10); }
function dayNum(ymd) {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY;
}
/* 何日目か → "YYYY-MM-DD"（Howard Hinnant の civil_from_days） */
function ymdOf(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}
function dayStart(ymd) { return dayNum(ymd) * DAY; }
function shiftDay(ymd, n) { return ymdOf(dayNum(ymd) + n); }
function daysBetween(a, b) { return dayNum(b) - dayNum(a); }
function isDay(s) {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const n = dayNum(s);
  // 2020-02-30 のような「存在しない日」を弾く
  return Number.isFinite(n) && ymdOf(n) === s;
}
function isMidnight(isoString) { return String(isoString).endsWith("T00:00:00.000Z"); }
function decodeSafe(s) { try { return decodeURIComponent(s); } catch { return s; } }
function num(v) { return v === null || v === undefined || v === "" ? null : Number(v); }
function fin(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
/* 最初に「ちゃんとした数」だったものを採る。無ければ null（0 にはしない） */
function firstNum(...vals) {
  for (const v of vals) {
    const n = fin(typeof v === "string" && v !== "" ? Number(v) : v);
    if (n !== null) return n;
  }
  return null;
}
/* 秒でもミリ秒でも ISO 文字列でも、ミリ秒にそろえる */
function toMs(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v);
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/* 観測できた1軸。値があるか、あっても閉じているか、そもそも無いか。 */
function axis(value, state) {
  if (state === "absent") return { state: "absent", value: null };
  if (value === null || value === undefined || Number.isNaN(value)) {
    return { state: "absent", value: null };
  }
  return { state: state || "on", value };
}

/* ── ある1日の軸の値（D日 00:00 UTC 時点）──
   /state も倉庫も、必ずここを通す（2つの道で答えが食い違わないように）。
   無い軸は null（= ABSENT）。 */
function axesValues(day, src) {
  const q = src.quote || null;   // D日 00:00 のスナップショット
  const o = src.ohlcv || null;   // D-1日の確定足
  const f = src.fng || null;     // D日 00:00 の Fear & Greed

  // volatility は CMC からは来ない。前日の確定足の high/low から出す。
  let volatility = null;
  if (o && o.high != null && o.low != null && o.low !== 0) {
    volatility = (o.high - o.low) / o.low;
  }

  return {
    // quotes が無い日は、前日の確定足で代わりにする（どちらも D日 00:00 時点の値）
    price:      firstNum(q && q.price, o && o.close),
    volume:     firstNum(q && q.volume, o && o.volume),
    market_cap: firstNum(q && q.market_cap, o && o.market_cap),
    volatility: fin(volatility),
    change_24h: firstNum(q && q.percent_change_24h),
    change_7d:  firstNum(q && q.percent_change_7d),
    change_30d: firstNum(q && q.percent_change_30d),
    sentiment:  firstNum(f && f.value),
    attention:  null, // 外部ソース未接続。後で Wikimedia が埋める枠
  };
}

/* ── MarketState ──
   ある1日の、RE: が観測できた世界の状態（D日 00:00 UTC 時点）。
   全項目が埋まる必要はない。埋まらない軸は absent のまま持つ。 */
function buildMarketState(day, src) {
  const v = axesValues(day, src);
  const axes = {};
  for (const k of AXES) axes[k] = axis(v[k], "on");
  return { timestamp: day + "T00:00:00Z", axes };
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
    if (!candle || !YMD.test(candle)) continue;
    map.set(shiftDay(candle, 1), {
      candle,
      high: usd.high ?? null, low: usd.low ?? null,
      close: usd.close ?? null, volume: usd.volume ?? null,
      market_cap: usd.market_cap ?? null,
    });
  }
  return map;
}

/* CMC の time_start は「その日を含まない」（実測）。
   from 当日を含めるため、quotes は1日前から、OHLCV は前日の足が要るので2日前から取る。
   OHLCV の time_end は1日余分に取る（含む・含まないのどちらでも最後の日が欠けないように。
   余った足は範囲外の日に置かれて使われない）。 */
function fetchQuotes(env, id, from, to) {
  return hit(env, "/v3/cryptocurrency/quotes/historical",
    { id, time_start: shiftDay(from, -1), time_end: to, interval: "daily", convert: "USD" });
}
function fetchOhlcv(env, id, from, to) {
  return hit(env, "/v2/cryptocurrency/ohlcv/historical",
    { id, time_start: shiftDay(from, -2), time_end: to, interval: "daily", convert: "USD" });
}

/* ── Fear & Greed ──
   新しい順に最大 500 件ずつしか返らない。1ページ 1 クレジット。
   until を渡すと、その日まで遡れた時点で止める（null なら最後まで）。 */
const FNG_LIMIT = 500;
const FNG_MAX_PAGES = 20;

function fngDay(row) {
  const secs = Number(row && row.timestamp);
  return Number.isFinite(secs) && secs > 0 ? dayKey(new Date(secs * 1000).toISOString()) : null;
}

async function fetchFng(env, opts = {}) {
  const limit = opts.limit || FNG_LIMIT;
  const until = opts.until || null;
  const rows = [];
  const pages = [];
  let credits = 0, ok = true, reachedEnd = false, error = null;
  for (let i = 0; i < FNG_MAX_PAGES; i++) {
    const r = await hit(env, "/v3/fear-and-greed/historical", { start: i * limit + 1, limit });
    const st = r.response.status;
    const d = r.response.data;
    const n = Array.isArray(d) ? d.length : 0;
    credits += creditsOf(r);
    pages.push({ request: r.request, http_status: r.response.http_status, status: st, count: n });
    if (!isOk(r) || !Array.isArray(d)) {
      ok = false;
      error = isOk(r) ? { ...upstream(r), note: "unexpected response shape" } : upstream(r);
      break;
    }
    rows.push(...d);
    if (n < limit) { reachedEnd = true; break; }
    if (until) {
      const oldest = fngDay(d[n - 1]);
      if (oldest && oldest <= until) break;
    }
  }
  return { rows, pages, credits, ok, reachedEnd, error };
}
function fetchAllFng(env) { return fetchFng(env, { limit: FNG_LIMIT }); }

/* 日付ごとに並べて、欠け・重複・00:00 ちょうどじゃない記録を洗い出す。
   ここでは直さない。見えるようにするだけ（直し方は実データを見てから決める）。 */
/* 採った1件。ts（ISO 文字列）は要るときだけ作る */
class FngPick {
  constructor(secs, value, label) { this.secs = secs; this.value = value; this.label = label; }
  get ts() { return iso(this.secs * 1000); }
}
function analyzeFng(rows) {
  const byDay = new Map(); // 何日目か → その日の記録
  const seen = new Set();
  const offMidnight = [];
  let exactRepeats = 0;
  for (const row of rows) {
    const secs = Number(row && row.timestamp);
    if (!Number.isFinite(secs) || secs <= 0) continue;
    if (seen.has(secs)) { exactRepeats++; continue; } // ページの境目で同じ行が2回来た場合
    seen.add(secs);
    if (secs % 86400 !== 0) offMidnight.push(iso(secs * 1000));
    const dn = Math.floor(secs / 86400);
    let list = byDay.get(dn);
    if (!list) byDay.set(dn, (list = []));
    list.push(new FngPick(secs, num(row.value), row.value_classification ?? null));
  }
  const nums = [...byDay.keys()].sort((a, b) => a - b);
  const oldest = nums.length ? ymdOf(nums[0]) : null;
  const newest = nums.length ? ymdOf(nums[nums.length - 1]) : null;

  // 1日に2件以上あったら、その日の 00:00 に一番近い記録を採る（定義に合わせる）
  const pick = new Map();
  const duplicates = [];
  for (const dn of nums) {
    const list = byDay.get(dn);
    const day = ymdOf(dn);
    const t0 = dn * 86400;
    let best = list[0];
    for (const e of list) if (Math.abs(e.secs - t0) < Math.abs(best.secs - t0)) best = e;
    if (list.length > 1) duplicates.push({ day, entries: list.map((e) => ({ ts: e.ts, value: e.value, label: e.label })) });
    pick.set(day, best);
  }

  const missing = [];
  if (nums.length) {
    for (let dn = nums[0]; dn <= nums[nums.length - 1]; dn++) if (!byDay.has(dn)) missing.push(ymdOf(dn));
  }
  return { pick, oldest, newest, days: nums.length, missing, duplicates, offMidnight, exactRepeats };
}

/* ──────────────────────────────────────────
   観測の倉庫（KV）
   ────────────────────────────────────────── */
const metaKey = (id) => `meta:${ARCHIVE_V}:${id}`;
const boxKey = (id, y) => `series:${ARCHIVE_V}:${id}:${y}`;

async function kvJson(ns, key) {
  const s = await ns.get(key);
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function newMeta(id) {
  return {
    v: 1, id, years: {}, backoff: {}, fng_from: null, last_on: {}, complete: false,
    tail_from: null, last_refresh_at: null, last_refresh_ok_at: null, last_step: null, errors: [],
  };
}

function note(meta, at, where, info) {
  meta.errors.unshift({ at, where, ...info });
  if (meta.errors.length > 10) meta.errors.length = 10;
}

/* 失敗した年は少し待ってから（30分 → 1時間 → 2時間 … 最大12時間） */
function backOff(meta, year, now) {
  const prev = meta.backoff[year];
  const n = prev ? prev.n + 1 : 1;
  const waitMin = Math.min(12 * 60, 30 * 2 ** (n - 1));
  meta.backoff[year] = { n, until: iso(now + waitMin * 60000) };
}

function boxDays(box) { return daysBetween(box.from, box.to) + 1; }

/* 丸ごと null の列は null 1つにする（その年はずっと ABSENT） */
function collapse(box) {
  for (const k of AXES) {
    const col = box.axes[k];
    if (Array.isArray(col) && col.every((x) => x === null)) box.axes[k] = null;
  }
}

/* その年を作り直す必要があるか */
function yearNeedsBuild(e, year, curYear, today, now) {
  if (!e) return true;
  if (e.empty) return year === curYear && now - Date.parse(e.checked_at) > 3600e3;
  if (year < curYear) return e.to < `${year}-12-31`;
  return e.to < shiftDay(today, -TAIL_DAYS);
}
function missingYears(meta, curYear, today, now) {
  const list = [];
  for (let y = curYear; y >= FIRST_YEAR; y--) {
    if (yearNeedsBuild(meta.years[y], y, curYear, today, now)) list.push(y);
  }
  return list;
}
/* 新しい年から順に。待ち時間中の年は飛ばす */
function nextYear(meta, curYear, today, now) {
  for (const y of missingYears(meta, curYear, today, now)) {
    const b = meta.backoff[y];
    if (b && Date.parse(b.until) > now) continue;
    return y;
  }
  return null;
}

/* 軸ごとに「最後に値があった日」（sentiment が何日遅れで届くかもここで見える） */
function updateLastOn(meta, boxes) {
  const sorted = [...boxes].sort((a, b) => b.year - a.year);
  for (const k of AXES) {
    let found = null;
    for (const b of sorted) {
      const col = b.axes[k];
      if (!col) continue;
      for (let j = col.length - 1; j >= 0; j--) {
        if (col[j] !== null) { found = shiftDay(b.from, j); break; }
      }
      if (found) break;
    }
    if (found && (!meta.last_on[k] || found > meta.last_on[k])) meta.last_on[k] = found;
    else if (!(k in meta.last_on)) meta.last_on[k] = null;
  }
}

/* 1年ぶんを CMC から取って、箱を丸ごと作る */
async function buildYear(env, ns, meta, id, year, today, now) {
  const curYear = Number(today.slice(0, 4));
  const from = `${year}-01-01`;
  const to = year < curYear ? `${year}-12-31` : today;
  const needFng = !(meta.fng_from && to < meta.fng_from); // F&G の時代より前なら取らない
  const at = iso(now);

  const [qr, orr, fr] = await Promise.all([
    fetchQuotes(env, id, from, to),
    fetchOhlcv(env, id, from, to),
    needFng ? fetchFng(env, { until: from }) : null,
  ]);
  const credits = creditsOf(qr) + creditsOf(orr) + (fr ? fr.credits : 0);

  // どれか1つでも取れなかったら、箱は書かない（取れなかった = ABSENT ではないので）
  const bad = [];
  if (!isOk(qr)) bad.push(["quotes", upstream(qr)]);
  if (!isOk(orr)) bad.push(["ohlcv", upstream(orr)]);
  if (fr && !fr.ok) bad.push(["fng", fr.error]);
  if (bad.length) {
    for (const [src, info] of bad) note(meta, at, `build ${year} / ${src}`, info);
    backOff(meta, year, now);
    return { did: "build failed (nothing was written; will retry later)", year, credits };
  }

  const q = pickQuotes(qr.response.data, id).map;
  const o = pickOhlcv(orr.response.data, id);
  let f = null;
  if (fr) {
    const fa = analyzeFng(fr.rows);
    f = fa.pick;
    if (fr.reachedEnd && fa.oldest) meta.fng_from = fa.oldest; // 最後まで遡れたときだけ、時代の始まりが分かる
  }

  const n = daysBetween(from, to) + 1;
  const n0 = dayNum(from);
  const cols = {};
  for (const k of AXES) cols[k] = new Array(n);
  let first = -1, last = -1;
  for (let i = 0; i < n; i++) {
    const d = ymdOf(n0 + i);
    const v = axesValues(d, { quote: q.get(d), ohlcv: o.get(d), fng: f ? f.get(d) : null });
    let any = false;
    for (const k of AXES) { cols[k][i] = v[k]; if (v[k] !== null) any = true; }
    if (any) { if (first < 0) first = i; last = i; }
  }

  if (first < 0) {
    const prev = meta.years[year];
    if (prev && !prev.empty && prev.days > 0) {
      note(meta, at, `build ${year}`, { note: "CMC returned no rows for a year that already has data; kept the stored box" });
      backOff(meta, year, now);
      return { did: "kept the stored box (CMC returned nothing)", year, credits };
    }
    meta.years[year] = { empty: true, checked_at: at };
    delete meta.backoff[year];
    return { did: "no data in this year", year, credits };
  }

  // 資産が生まれる前の日は箱に入れない。今年は、まだ値が来ていない末尾の日も入れない。
  // 過去の年は 12/31 まで持つ（末尾に欠けがあってもその日は ABSENT として残す）。
  const end = year < curYear ? n - 1 : last;
  const box = {
    v: 1, id, year,
    from: shiftDay(from, first), to: shiftDay(from, end),
    axes: {}, built_at: at, refreshed_at: at,
  };
  for (const k of AXES) box.axes[k] = cols[k].slice(first, end + 1);
  collapse(box);
  const text = JSON.stringify(box);
  await ns.put(boxKey(id, year), text);

  meta.years[year] = {
    from: box.from, to: box.to, days: end - first + 1,
    built_at: at, refreshed_at: at, bytes: text.length,
  };
  delete meta.backoff[year];
  if (year === curYear) updateLastOn(meta, [box]);
  return { did: "built a year", year, from: box.from, to: box.to, days: end - first + 1, credits };
}

/* 1日ぶんの値を箱に差し込む。null は差し込まない（しまってある観測を消さない） */
function spliceDay(box, day, use) {
  const idx = daysBetween(box.from, day);
  if (idx < 0) return 0;
  let changes = 0;
  let len = boxDays(box);
  if (idx >= len) {
    box.to = day;
    len = idx + 1;
    changes++;
    for (const k of AXES) {
      const col = box.axes[k];
      if (col) while (col.length < len) col.push(null);
    }
  }
  for (const k of Object.keys(use)) {
    const v = use[k];
    if (v === null || v === undefined) continue;
    let col = box.axes[k];
    if (!col) col = box.axes[k] = new Array(len).fill(null);
    if (col[idx] !== v) { col[idx] = v; changes++; }
  }
  return changes;
}

/* 直近 TAIL_DAYS 日だけ取り直して、今の年（年明けは去年も）の箱に差し込む */
async function refreshTail(env, ns, meta, id, today, now) {
  const at = iso(now);
  const from = shiftDay(today, -TAIL_DAYS);
  meta.last_refresh_at = at;
  meta.tail_from = from;

  const [qr, orr, fr] = await Promise.all([
    fetchQuotes(env, id, from, today),
    fetchOhlcv(env, id, from, today),
    fetchFng(env, { until: from, limit: 40 }),
  ]);
  const credits = creditsOf(qr) + creditsOf(orr) + fr.credits;
  const marketOk = isOk(qr) && isOk(orr);
  if (!isOk(qr)) note(meta, at, "refresh / quotes", upstream(qr));
  if (!isOk(orr)) note(meta, at, "refresh / ohlcv", upstream(orr));
  if (!fr.ok) note(meta, at, "refresh / fng", fr.error);
  if (!marketOk && !fr.ok) return { did: "refresh failed (kept everything as it was)", credits };

  const q = marketOk ? pickQuotes(qr.response.data, id).map : null;
  const o = marketOk ? pickOhlcv(orr.response.data, id) : null;
  const f = fr.ok ? analyzeFng(fr.rows).pick : null;

  // 取れた側の軸だけを使う（片方が失敗したら、その軸には触らない）
  const byYear = new Map();
  for (let d = from; d <= today; d = shiftDay(d, 1)) {
    const v = axesValues(d, { quote: q ? q.get(d) : null, ohlcv: o ? o.get(d) : null, fng: f ? f.get(d) : null });
    const use = {};
    let any = false;
    if (marketOk) for (const k of MARKET_AXES) { use[k] = v[k]; if (v[k] !== null) any = true; }
    if (f) { use.sentiment = v.sentiment; if (v.sentiment !== null) any = true; }
    if (!any) continue;
    const y = Number(d.slice(0, 4));
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push([d, use]);
  }

  let changed = 0;
  const touched = [];
  for (const [y, list] of byYear) {
    const e = meta.years[y];
    if (!e || e.empty) continue; // その年は補充のほうで作る
    const box = await kvJson(ns, boxKey(id, y));
    if (!box) continue;
    if (list[0][0] > shiftDay(box.to, 1)) {
      // 間が空いている。ここで足すと、取っていない日が ABSENT に見えてしまうので足さない
      note(meta, at, `refresh ${y}`, { note: `gap between ${box.to} and ${list[0][0]}; this year will be rebuilt` });
      continue;
    }
    let c = 0;
    for (const [d, use] of list) c += spliceDay(box, d, use);
    if (!c) continue; // 何も変わっていなければ書かない
    collapse(box);
    box.refreshed_at = at;
    const text = JSON.stringify(box);
    await ns.put(boxKey(id, y), text);
    meta.years[y] = { ...e, to: box.to, days: boxDays(box), refreshed_at: at, bytes: text.length };
    changed += c;
    touched.push(box);
  }
  if (touched.length) updateLastOn(meta, touched);
  if (marketOk && fr.ok) meta.last_refresh_ok_at = at;
  return { did: "refreshed recent days", from, to: today, changed, credits };
}

/* 1回ぶんの仕事：足りない年があれば1年作る。無ければ直近を取り直す（間隔を守って） */
async function archiveStep(env, id, now, mode) {
  const ns = env.RE_CACHE;
  const today = dayKey(iso(now));
  const curYear = Number(today.slice(0, 4));
  const meta = (await kvJson(ns, metaKey(id))) || newMeta(id);
  if (!meta.backoff) meta.backoff = {};

  let r;
  const y = nextYear(meta, curYear, today, now);
  if (y !== null) {
    r = await buildYear(env, ns, meta, id, y, today, now);
  } else {
    // 日付が変わって最初の1回は必ず取り直す（新しい日の 00:00 を早く倉庫に入れる）
    const gap = (mode === "manual" ? MANUAL_REFRESH_MIN : REFRESH_EVERY_MIN) * 60000;
    const last = meta.last_refresh_at ? Date.parse(meta.last_refresh_at) : 0;
    const newDay = !meta.last_refresh_at || meta.last_refresh_at.slice(0, 10) < today;
    if (!newDay && now - last < gap) {
      const missing = missingYears(meta, curYear, today, now);
      return {
        id, did: "nothing to do right now",
        note: `recent days were refreshed ${Math.floor((now - last) / 60000)} min ago`,
        complete: missing.length === 0, missing_years: missing,
      };
    }
    r = await refreshTail(env, ns, meta, id, today, now);
  }

  const missing = missingYears(meta, curYear, today, now);
  meta.complete = missing.length === 0;
  meta.last_step = { at: iso(now), mode, ...r };
  await ns.put(metaKey(id), JSON.stringify(meta));
  return { id, ...r, complete: meta.complete, missing_years: missing };
}

/* /series: 箱を開けずに（JSON を解かずに）文字列のままつないで返す。CPU をほぼ使わない */
async function series(env, url) {
  const ns = env.RE_CACHE;
  const sp = url.searchParams;
  const id = sp.get("id") || "1";
  if (!ARCHIVE_IDS.includes(id)) {
    return out({ error: "this id is not in the archive", archived_ids: ARCHIVE_IDS }, 400);
  }
  const yf = sp.get("from"), yt = sp.get("to");
  const problems = [];
  if (yf !== null && !/^\d{4}$/.test(yf)) problems.push("from must be a year like 2020");
  if (yt !== null && !/^\d{4}$/.test(yt)) problems.push("to must be a year like 2024");
  if (problems.length) return out({ error: "bad parameters", problems, raw_query: decodeSafe(url.search) }, 400);

  const meta = await kvJson(ns, metaKey(id));
  if (!meta) return out({ error: "the archive for this id is still empty", see: "/archive/status" }, 404);

  const years = Object.keys(meta.years)
    .filter((y) => !meta.years[y].empty)
    .map(Number)
    .filter((y) => (yf === null || y >= Number(yf)) && (yt === null || y <= Number(yt)))
    .sort((a, b) => a - b);
  const texts = await Promise.all(years.map((y) => ns.get(boxKey(id, y))));
  const boxes = texts.filter(Boolean);

  const now = nowMs();
  const today = dayKey(iso(now));
  const missing = missingYears(meta, Number(today.slice(0, 4)), today, now);
  const head = {
    id,
    definition: DEFINITION,
    axes: AXES,
    layout: ARCHIVE_LAYOUT,
    complete: missing.length === 0,
    missing_years: missing,
    last_on: meta.last_on,
    fng_from: meta.fng_from,
    recent_days_may_change_from: meta.tail_from,
    last_refresh_ok_at: meta.last_refresh_ok_at,
    fng_time_note: FNG_TIME_NOTE,
  };
  const body = `{"meta":${JSON.stringify(head)},"years":[${boxes.join(",")}]}`;
  return new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...CORS },
  });
}

async function archiveStatus(env) {
  const ns = env.RE_CACHE;
  const now = nowMs();
  const today = dayKey(iso(now));
  const curYear = Number(today.slice(0, 4));
  const archives = [];
  for (const id of ARCHIVE_IDS) {
    const meta = await kvJson(ns, metaKey(id));
    if (!meta) {
      archives.push({ id, state: "empty so far — the cron fills it at :05 and :35 every hour, or open /archive/step" });
      continue;
    }
    const missing = missingYears(meta, curYear, today, now);
    archives.push({
      id,
      complete: missing.length === 0,
      missing_years: missing,
      years: Object.keys(meta.years).map(Number).sort((a, b) => a - b).map((y) => {
        const e = meta.years[y];
        return e.empty ? `${y}: no data` : `${y}: ${e.from} → ${e.to} (${e.days} days)`;
      }),
      last_on: meta.last_on,
      fng_from: meta.fng_from,
      recent_days_may_change_from: meta.tail_from,
      last_refresh_at: meta.last_refresh_at,
      last_refresh_ok_at: meta.last_refresh_ok_at,
      last_step: meta.last_step,
      waiting_to_retry: meta.backoff,
      errors: meta.errors,
    });
  }
  const log = await kvJson(ns, TIMING_KEY);
  return {
    storage: "connected",
    cron: CRON,
    archives,
    fng_timing: log
      ? { since: log.started_at, live_readings: log.live.length, days_seen: Object.keys(log.first_seen).length,
          revisions: log.revisions.length, last_error: log.errors[0] || null, details: "/probe/fng-timing" }
      : "no readings yet (the cron writes the first one)",
  };
}

/* ──────────────────────────────────────────
   F&G がいつ API に出るかの観測（cron ごと）
   ・latest: そのとき生きている指数の値と、計算された時刻（update_time）
   ・historical の最新5件: 各日の値が「最初に見えた時刻」と、その後の書き換え
   相関から逆算するのではなく、API が実際に見せたものを時刻つきで残す。
   ────────────────────────────────────────── */
async function observeFng(env) {
  const ns = env.RE_CACHE;
  const [lr, hr] = await Promise.all([
    hit(env, "/v3/fear-and-greed/latest", {}),
    hit(env, "/v3/fear-and-greed/historical", { start: 1, limit: 5 }),
  ]);
  const at = nowMs();
  const log = (await kvJson(ns, TIMING_KEY)) ||
    { v: 1, started_at: iso(at), live: [], first_seen: {}, revisions: [], errors: [], hist_ok_at: null };

  const ld = lr.response.data;
  if (isOk(lr) && ld && typeof ld === "object" && !Array.isArray(ld) && ld.value !== undefined) {
    const upd = toMs(ld.update_time);
    log.live.push([Math.round(at / 1000), num(ld.value), upd ? Math.round(upd / 1000) : null]);
    // 比べるのに要るのは 00:00 前後の値だけ。2日より古い昼間の記録は捨てて、ログを小さく保つ
    const nearMidnight = (s) => { const m = (s * 1000) % DAY; return m <= 40 * 60000 || m >= DAY - 40 * 60000; };
    log.live = log.live.filter(([s]) => s * 1000 >= at - 2 * DAY || nearMidnight(s));
    if (log.live.length > MAX_LIVE) log.live.splice(0, log.live.length - MAX_LIVE);
  } else {
    log.errors.unshift({ at: iso(at), where: "latest", ...upstream(lr) });
  }

  const hd = hr.response.data;
  if (isOk(hr) && Array.isArray(hd)) {
    const firstOk = !log.hist_ok_at; // 最初に取れた回の行は「記録を始める前から出ていた」
    for (const row of hd) {
      const secs = Number(row && row.timestamp);
      if (!Number.isFinite(secs) || secs <= 0) continue;
      const ts = iso(secs * 1000);
      const day = dayKey(ts);
      const v = num(row.value);
      const fs = log.first_seen[day];
      if (!fs) {
        log.first_seen[day] = firstOk
          ? { at: iso(at), ts, value: v, pre: true }
          : { at: iso(at), after: log.hist_ok_at, ts, value: v };
      } else {
        const lastV = fs.last !== undefined ? fs.last : fs.value;
        if (lastV !== v) {
          log.revisions.push({ day, at: iso(at), from: lastV, to: v });
          if (log.revisions.length > MAX_REVISIONS) log.revisions.splice(0, log.revisions.length - MAX_REVISIONS);
          fs.last = v;
        }
      }
    }
    log.hist_ok_at = iso(at);
    const days = Object.keys(log.first_seen).sort();
    for (const d of days.slice(0, Math.max(0, days.length - MAX_FIRST_SEEN))) delete log.first_seen[d];
  } else {
    log.errors.unshift({ at: iso(at), where: "historical", ...upstream(hr) });
  }
  if (log.errors.length > 10) log.errors.length = 10;
  await ns.put(TIMING_KEY, JSON.stringify(log));
}

function analyzeTiming(log) {
  if (!log) {
    return { note: "no readings yet — the cron writes them at :05 and :35 every hour", definition_now: FNG_TIME_NOTE };
  }
  // 同じ update_time の読み取りは同じ計算。最初に見た1回だけ使う
  const comps = new Map();
  for (const [atS, value, updS] of log.live) {
    const t = (updS || atS) * 1000;
    if (!comps.has(t)) comps.set(t, { t, value, seen: atS * 1000 });
  }
  const list = [...comps.values()].sort((a, b) => a.t - b.t);
  const nearest = (target) => {
    let best = null;
    for (const c of list) {
      const d = Math.abs(c.t - target);
      if (d <= 20 * 60000 && (!best || d < Math.abs(best.t - target))) best = c;
    }
    return best;
  };
  const view = (c) => (c ? { value: c.value, computed_at: iso(c.t), seen_at: iso(c.seen) } : null);

  const minutes = {};
  for (const c of list) {
    const m = String(new Date(c.t).getUTCMinutes());
    minutes[m] = (minutes[m] || 0) + 1;
  }

  const tally = {};
  const lags = [];
  const rows = [];
  for (const day of Object.keys(log.first_seen).sort()) {
    const fs = log.first_seen[day];
    const t0 = dayStart(day);
    const near = { "D-1 00:00": nearest(t0 - DAY), "D 00:00": nearest(t0), "D+1 00:00": nearest(t0 + DAY) };
    const matches = Object.keys(near).filter((k) => near[k] && near[k].value === fs.value);
    let verdict;
    if (!near["D 00:00"] || !near["D+1 00:00"]) verdict = "waiting";
    else if (matches.length === 1) verdict = matches[0];
    else if (matches.length > 1) verdict = "tie";
    else verdict = "none";
    tally[verdict] = (tally[verdict] || 0) + 1;

    let appeared;
    if (fs.pre) appeared = "already in the API when logging started";
    else {
      const lag = Math.round(((Date.parse(fs.at) - t0) / 3600e3) * 100) / 100;
      lags.push(lag);
      appeared = { after: fs.after || null, by: fs.at, hours_after_D_00_00: lag };
    }
    const row = {
      day,
      value: fs.value,
      appeared,
      live: { "D-1 00:00": view(near["D-1 00:00"]), "D 00:00": view(near["D 00:00"]), "D+1 00:00": view(near["D+1 00:00"]) },
      historical_value_equals_live_at: verdict,
    };
    if (fs.last !== undefined && fs.last !== fs.value) row.revised_to = fs.last;
    rows.push(row);
  }
  lags.sort((a, b) => a - b);
  return {
    _summary: {
      logging_since: log.started_at,
      live_readings: log.live.length,
      days: rows.length,
      verdicts: tally,
      publication_lag_hours: lags.length
        ? { min: lags[0], median: lags[Math.floor(lags.length / 2)], max: lags[lags.length - 1], days: lags.length }
        : null,
      live_update_minute_of_hour: minutes,
      revisions: log.revisions.length,
    },
    how_to_read:
      "For each day D, value is what /v3/fear-and-greed/historical lists for D (timestamp D 00:00 UTC). " +
      "live shows the live index (/v3/fear-and-greed/latest) computed nearest to D-1 00:00, D 00:00 and D+1 00:00, as RE: saw it. " +
      "historical_value_equals_live_at: 'D 00:00' = the listed value is the index as it stood at the start of D; " +
      "'D+1 00:00' = it is the value at the end of D; 'tie' = the index did not move, so this day cannot tell; " +
      "'none' = matches none of them; 'waiting' = RE: does not have both readings yet. " +
      "appeared = when the value first showed up in the historical list (RE: looks every 30 minutes).",
    definition_now: FNG_TIME_NOTE,
    days: rows.slice(-30).reverse(),
    revisions: log.revisions.slice(-20),
    errors: log.errors.slice(0, 5),
  };
}

/* ──────────────────────────────────────────
   他の窓の probe（2026-09-26〜）
   CMC のときと同じ。組み込む前に、まずその窓が何を見せてくれるかを実際に叩いて見る。
   ・/probe/wiki      Wikipedia の閲覧数（記事ごとの日次、他言語、リダイレクト、全体量）
   ・/probe/wiki-top  Wikipedia のその日の人気記事（いつから、何件、国・言語で変わるか、公開の遅れ）
   ・/probe/gdelt     GDELT の報道量（どこまで遡れるか。5秒に1回の制限があるので間を空けて叩く）
   ────────────────────────────────────────── */
const UA = "RE-TemporalPlayground/0.3 (+https://github.com/7535271/re-worker)";
const WIKI = "https://wikimedia.org/api/rest_v1/metrics/pageviews";
const GDELT = "https://api.gdeltproject.org/api/v2/doc/doc";

/* 外の窓を叩いて、リクエストと返事（状態・一部のヘッダ・かかった時間・中身）を記録する */
async function look(url, opts = {}) {
  const at = new Date().toISOString();
  const t0 = Date.now();
  let status = -1, body = null, text = null;
  const headers = {};
  // 返事が来ない窓もある。待ち続けずに、時間切れも観測として記録する
  const ctl = opts.timeoutMs ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), opts.timeoutMs) : null;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, "Api-User-Agent": UA, Accept: "application/json" }, ...(ctl ? { signal: ctl.signal } : {}) });
    status = r.status;
    for (const k of ["content-type", "cache-control", "age", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "ratelimit", "ratelimit-policy"]) {
      const v = r.headers.get(k);
      if (v) headers[k] = v;
    }
    const t = await r.text();
    try { body = JSON.parse(t); } catch { text = t.slice(0, 600); }
  } catch (e) {
    text = ctl && ctl.signal.aborted ? `no answer within ${opts.timeoutMs / 1000} s (timed out)` : String(e && e.message ? e.message : e);
  }
  if (timer) clearTimeout(timer);
  return { request: { url, at }, response: { http_status: status, ms: Date.now() - t0, headers, body, text } };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ymdCompact = (d) => d.replace(/-/g, "");

/* 日次の並び（Wikipedia の per-article / aggregate）を要約する */
function wikiSeries(r, today) {
  const b = r.response.body;
  const items = b && Array.isArray(b.items) ? b.items : [];
  if (!items.length) return { http_status: r.response.http_status, items: 0, error: b && (b.title || b.detail) ? { title: b.title, detail: b.detail } : r.response.text };
  // 日付は整数（何日目か）で扱う。4,000日以上あっても CPU を食わないように
  const n = items.length;
  const dn = new Float64Array(n), views = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ts = String(items[i].timestamp);
    dn[i] = Date.UTC(+ts.slice(0, 4), +ts.slice(4, 6) - 1, +ts.slice(6, 8)) / DAY;
    views[i] = typeof items[i].views === "number" ? items[i].views : NaN;
  }
  const missing = [];
  let missingCount = 0, zero = 0, peak = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) for (let d = dn[i - 1] + 1; d < dn[i]; d++) { missingCount++; if (missing.length < 30) missing.push(ymdOf(d)); }
    if (views[i] === 0) zero++;
    if (views[i] > views[peak]) peak = i;
  }
  const sorted = views.filter((v) => !Number.isNaN(v)).sort();
  const at = (i) => ({ day: ymdOf(dn[i]), views: views[i] });
  const last = ymdOf(dn[n - 1]);
  return {
    http_status: r.response.http_status,
    items: n,
    first: ymdOf(dn[0]), last,
    newest_is_days_before_today: daysBetween(last, today),
    missing_days: { count: missingCount, items: missing },
    zero_view_days: zero,
    views: { min: sorted[0], median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] },
    peak_day: at(peak),
    fields: Object.keys(items[0]),
    timestamp_example: items[0].timestamp,
    first_items: [0, 1, 2].filter((i) => i < n).map(at),
    last_items: [n - 3, n - 2, n - 1].filter((i) => i >= 0).map(at),
  };
}

/* その日の人気記事の一覧を要約する */
function wikiTop(r, n = 15) {
  const b = r.response.body;
  const item = b && Array.isArray(b.items) ? b.items[0] : null;
  const arts = item && Array.isArray(item.articles) ? item.articles : null;
  if (!arts) return { http_status: r.response.http_status, articles: 0, error: b && (b.title || b.detail) ? { title: b.title, detail: b.detail } : r.response.text };
  return {
    http_status: r.response.http_status,
    articles: arts.length,
    fields: Object.keys(arts[0] || {}),
    top: arts.slice(0, n).map((a) => ({ rank: a.rank, article: a.article, views: a.views ?? a.views_ceil, ...(a.project ? { project: a.project } : {}) })),
  };
}

async function probeWiki() {
  const today = dayKey(iso(nowMs()));
  const calls = {
    bitcoin_en: `${WIKI}/per-article/en.wikipedia/all-access/user/Bitcoin/daily/20150601/${ymdCompact(today)}`,
    bitcoin_en_all_agents_2020_03: `${WIKI}/per-article/en.wikipedia/all-access/all-agents/Bitcoin/daily/20200301/20200331`,
    bitcoin_en_user_2020_03: `${WIKI}/per-article/en.wikipedia/all-access/user/Bitcoin/daily/20200301/20200331`,
    redirect_BTC_en_2020_03: `${WIKI}/per-article/en.wikipedia/all-access/user/BTC/daily/20200301/20200331`,
    bitcoin_ja_2020_03: `${WIKI}/per-article/ja.wikipedia/all-access/user/${encodeURIComponent("ビットコイン")}/daily/20200301/20200331`,
    aggregate_en_2020_03: `${WIKI}/aggregate/en.wikipedia/all-access/user/daily/20200301/20200331`,
  };
  const keys = Object.keys(calls);
  const res = await Promise.all(keys.map((k) => look(calls[k])));
  const summary = {};
  keys.forEach((k, i) => { summary[k] = wikiSeries(res[i], today); });
  const trim = (r) => ({ request: r.request, response: { http_status: r.response.http_status, ms: r.response.ms, headers: r.response.headers, text: r.response.text } });
  return {
    _summary: summary,
    notes: [
      "bitcoin_en asks from 2015-06-01 on purpose, to see where the data really starts.",
      "user vs all-agents (2020-03) shows how much of the traffic the API counts as people.",
      "BTC is a redirect to Bitcoin: its views are counted separately, not merged.",
      "aggregate_en is all of English Wikipedia per day — the size of the whole room the Bitcoin article sits in.",
    ],
    calls: keys.map((k, i) => ({ name: k, ...trim(res[i]) })),
  };
}

async function probeWikiTop() {
  const today = dayKey(iso(nowMs()));
  const slash = (d) => d.replace(/-/g, "/");
  const recent = [1, 2, 3].map((n) => shiftDay(today, -n));
  const calls = {
    en_2020_03_12: `${WIKI}/top/en.wikipedia/all-access/2020/03/12`,
    ja_2020_03_12: `${WIKI}/top/ja.wikipedia/all-access/2020/03/12`,
    en_2015_07_01: `${WIKI}/top/en.wikipedia/all-access/2015/07/01`,
    en_2015_06_30: `${WIKI}/top/en.wikipedia/all-access/2015/06/30`,
    country_JP_2024_01_01: `${WIKI}/top-per-country/JP/all-access/2024/01/01`,
    country_JP_2020_03_12: `${WIKI}/top-per-country/JP/all-access/2020/03/12`,
  };
  for (const d of recent) calls[`en_${d.replace(/-/g, "_")}`] = `${WIKI}/top/en.wikipedia/all-access/${slash(d)}`;
  const keys = Object.keys(calls);
  const res = await Promise.all(keys.map((k) => look(calls[k])));
  const summary = {};
  keys.forEach((k, i) => { summary[k] = wikiTop(res[i], k.startsWith("en_2015") || k.startsWith("en_20") && !k.includes("2020") ? 5 : 15); });
  const newest = recent.find((d) => (summary[`en_${d.replace(/-/g, "_")}`] || {}).articles > 0) || null;
  return {
    _summary: { newest_top_list: newest, ...summary },
    notes: [
      "en_2015_07_01 and en_2015_06_30 check where the daily top lists begin.",
      "The last three en_ entries check how many days late the newest top list is.",
      "country_JP asks which pages people in Japan read (across all projects), in 2024 and in 2020.",
    ],
    calls: keys.map((k, i) => ({ name: k, request: res[i].request, response: { http_status: res[i].response.http_status, ms: res[i].response.ms, headers: res[i].response.headers, text: res[i].response.text } })),
  };
}

/* GDELT の報道量の時系列を要約する */
function gdeltTimeline(r) {
  const b = r.response.body;
  const tl = b && Array.isArray(b.timeline) ? b.timeline : null;
  if (!tl) return { http_status: r.response.http_status, points: 0, text: r.response.text, keys: b ? Object.keys(b) : null };
  return {
    http_status: r.response.http_status,
    series: tl.map((s) => {
      const data = Array.isArray(s.data) ? s.data : [];
      const step = data.length > 1 ? (Date.parse(gdeltIso(data[1].date)) - Date.parse(gdeltIso(data[0].date))) / 60000 : null;
      return {
        name: s.series,
        points: data.length,
        first: data[0] ? data[0].date : null,
        last: data.length ? data[data.length - 1].date : null,
        step_minutes: step,
        fields: data[0] ? Object.keys(data[0]) : [],
        first_items: data.slice(0, 3),
        last_items: data.slice(-2),
      };
    }),
  };
}
function gdeltIso(d) { const s = String(d || ""); return s.length >= 15 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z` : s; }

async function probeGdelt(only) {
  const q = (params) => `${GDELT}?${new URLSearchParams({ query: "bitcoin", mode: "timelinevolraw", format: "json", ...params })}`;
  let calls = [
    ["before_2017", q({ startdatetime: "20161201000000", enddatetime: "20161231235959" })],
    ["2017_01", q({ startdatetime: "20170101000000", enddatetime: "20170131235959" })],
    ["2020_03", q({ startdatetime: "20200301000000", enddatetime: "20200331235959" })],
    ["last_7_days", q({ timespan: "7d" })],
  ];
  if (only) calls = calls.filter((c) => c[0] === only); // ?only=2020_03 などで1回だけ（待ち時間なし）
  const out = [];
  for (let i = 0; i < calls.length; i++) {
    if (i) await wait(5500); // GDELT は 5 秒に 1 回まで（待っている時間は CPU に数えない）
    const r = await look(calls[i][1], { timeoutMs: 12000 });
    out.push({ name: calls[i][0], summary: gdeltTimeline(r), request: r.request, response: { http_status: r.response.http_status, ms: r.response.ms, headers: r.response.headers } });
  }
  return {
    _summary: Object.fromEntries(out.map((o) => [o.name, o.summary])),
    notes: [
      "Query 'bitcoin', mode timelinevolraw (number of matching articles over time).",
      "before_2017 vs 2017_01 checks where the searchable archive starts; 2020_03 checks a month we already look at in RE:.",
      "Calls are spaced 5.5 s apart because GDELT allows one request every 5 seconds per IP (Cloudflare IPs are shared, so a 429 is itself an observation).",
    ],
    calls: out.map((o) => ({ name: o.name, request: o.request, response: o.response })),
  };
}

/* ── ノヴァの地図にある窓（2026-09-26）。どれもキー不要か、お試しキー ── */
const OPEN_METEO = "https://archive-api.open-meteo.com/v1/archive";
const USGS = "https://earthquake.usgs.gov/fdsnws/event/1";
const FRANKFURTER = "https://api.frankfurter.dev/v1";
const FRANKFURTER_OLD = "https://api.frankfurter.app";
const CHAIN = "https://api.blockchain.info/charts";
const APOD = "https://api.nasa.gov/planetary/apod";
const HN = "https://hn.algolia.com/api/v1";

const callOut = (name, r) => ({ name, request: r.request, response: { http_status: r.response.http_status, ms: r.response.ms, headers: r.response.headers, text: r.response.text } });
async function runCalls(calls, summarize) {
  const keys = Object.keys(calls);
  const res = await Promise.all(keys.map((k) => look(calls[k])));
  const _summary = {};
  keys.forEach((k, i) => { _summary[k] = summarize(res[i], k); });
  return { _summary, calls: keys.map((k, i) => callOut(k, res[i])) };
}
const errOf = (r) => {
  const b = r.response.body;
  if (b && typeof b === "object") {
    // 文章になっている理由を先に採る（Open-Meteo は error: true と reason: "…" を別々に返す）
    for (const k of ["reason", "msg", "message", "detail", "title", "error"]) {
      const e = b[k];
      if (typeof e === "string" && e) return e.slice(0, 300);
      if (e && typeof e === "object") return e;
    }
  }
  return r.response.text;
};

/* ☁️ Open-Meteo：天気。1940年から？ 直近は何日遅れ？ 14年分を1回で取れる？ */
async function probeWeather() {
  const today = dayKey(iso(nowMs()));
  const daily = "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code";
  const q = (s, e) => `${OPEN_METEO}?${new URLSearchParams({ latitude: "35.68", longitude: "139.69", start_date: s, end_date: e, daily, timezone: "UTC" })}`;
  const r = await runCalls({
    before_1940: q("1939-12-25", "1940-01-05"),
    d_2020_03_06_to_12: q("2020-03-06", "2020-03-12"),
    last_14_days: q(shiftDay(today, -14), today),
    from_2013_to_today: q("2013-04-28", today),
  }, (res) => {
    const b = res.response.body;
    const d = b && b.daily;
    if (!d || !Array.isArray(d.time)) return { http_status: res.response.http_status, error: errOf(res) };
    const vars = Object.keys(d).filter((k) => k !== "time");
    const perVar = {};
    for (const v of vars) {
      const col = d[v] || [];
      let nulls = 0, lastOn = null;
      for (let i = 0; i < col.length; i++) { if (col[i] === null || col[i] === undefined) nulls++; else lastOn = d.time[i]; }
      perVar[v] = { nulls, last_with_value: lastOn };
    }
    return {
      http_status: res.response.http_status,
      days: d.time.length, first: d.time[0], last: d.time[d.time.length - 1],
      timezone: b.timezone, utc_offset_seconds: b.utc_offset_seconds, units: b.daily_units,
      variables: perVar,
      sample: d.time.slice(0, 3).map((t, i) => Object.fromEntries([["day", t], ...vars.map((v) => [v, d[v][i]])])),
    };
  });
  return { place: "Tokyo (35.68, 139.69) — only to see how the window behaves; the place is still to be decided", ...r };
}

/* 🌋 USGS：地震。1日の件数と大きい順。後から書き換わるか（updated） */
async function probeQuakes() {
  const today = dayKey(iso(nowMs()));
  const p = (o) => new URLSearchParams({ format: "geojson", minmagnitude: "4.5", ...o });
  return runCalls({
    count_2020_03_12: `${USGS}/count?${p({ starttime: "2020-03-12", endtime: "2020-03-13" })}`,
    biggest_2020_03_12: `${USGS}/query?${p({ starttime: "2020-03-12", endtime: "2020-03-13", orderby: "magnitude", limit: "5" })}`,
    count_2013: `${USGS}/count?${p({ starttime: "2013-01-01", endtime: "2014-01-01" })}`,
    latest_since_yesterday: `${USGS}/query?${p({ starttime: shiftDay(today, -1), orderby: "time", limit: "5" })}`,
  }, (res) => {
    const b = res.response.body;
    if (b && typeof b.count === "number" && !b.features) return { http_status: res.response.http_status, count: b.count, maxAllowed: b.maxAllowed };
    if (!b || !Array.isArray(b.features)) return { http_status: res.response.http_status, error: errOf(res) };
    return {
      http_status: res.response.http_status,
      count: b.metadata ? b.metadata.count : b.features.length,
      generated: b.metadata && b.metadata.generated ? iso(b.metadata.generated) : null,
      events: b.features.map((f) => ({
        mag: f.properties.mag, place: f.properties.place, time: iso(f.properties.time),
        updated: f.properties.updated ? iso(f.properties.updated) : null, status: f.properties.status, type: f.properties.type,
      })),
    };
  });
}

/* 💱 ECB の為替（Frankfurter）。1999年から？ 土日の抜け方、最新はいつの値？ */
async function probeFx() {
  return runCalls({
    d_2020_03_06_to_12: `${FRANKFURTER}/2020-03-06..2020-03-12?base=USD&symbols=JPY,EUR`,
    first_days_1999: `${FRANKFURTER}/1999-01-01..1999-01-08?base=EUR&symbols=USD,JPY`,
    latest: `${FRANKFURTER}/latest?base=USD&symbols=JPY,EUR`,
    latest_old_domain: `${FRANKFURTER_OLD}/latest?from=USD&to=JPY`,
  }, (res) => {
    const b = res.response.body;
    if (!b || !b.rates) return { http_status: res.response.http_status, error: errOf(res) };
    const dated = Object.values(b.rates).some((v) => v && typeof v === "object");
    return {
      http_status: res.response.http_status,
      base: b.base, start_date: b.start_date, end_date: b.end_date, date: b.date,
      days_listed: dated ? Object.keys(b.rates) : null,
      rates: dated ? Object.fromEntries(Object.entries(b.rates).slice(0, 7)) : b.rates,
    };
  });
}

/* ⛏️ Blockchain.com：Bitcoin のネットワークそのもの。いつから？ 毎日？ 時刻は 00:00 UTC？ */
async function probeChain() {
  return runCalls({
    n_transactions_all: `${CHAIN}/n-transactions?timespan=all&format=json&sampled=false`,
    hash_rate_all: `${CHAIN}/hash-rate?timespan=all&format=json&sampled=false`,
    n_transactions_2020_03: `${CHAIN}/n-transactions?start=2020-03-01&timespan=15days&format=json&sampled=false`,
  }, (res) => {
    const b = res.response.body;
    const v = b && Array.isArray(b.values) ? b.values : null;
    if (!v) return { http_status: res.response.http_status, error: errOf(res) };
    const steps = {};
    let offMidnight = 0;
    for (let i = 0; i < v.length; i++) {
      if (v[i].x % 86400 !== 0) offMidnight++;
      if (i) { const s = Math.round((v[i].x - v[i - 1].x) / 86400); steps[s] = (steps[s] || 0) + 1; }
    }
    return {
      http_status: res.response.http_status,
      name: b.name, unit: b.unit, period: b.period, description: b.description,
      points: v.length,
      first: v.length ? iso(v[0].x * 1000) : null, last: v.length ? iso(v[v.length - 1].x * 1000) : null,
      step_days: steps, not_at_00_00_utc: offMidnight,
      first_items: v.slice(0, 3).map((p) => ({ t: iso(p.x * 1000), y: p.y })),
      last_items: v.slice(-3).map((p) => ({ t: iso(p.x * 1000), y: p.y })),
    };
  });
}

/* 🌌 NASA APOD：その日の宇宙の一枚。1995-06-16 から？ お試しキーの残り回数、著作権の表示 */
async function probeApod() {
  return runCalls({
    d_2020_03_12: `${APOD}?api_key=DEMO_KEY&date=2020-03-12`,
    first_day_1995_06_16: `${APOD}?api_key=DEMO_KEY&date=1995-06-16`,
    before_1995_06_15: `${APOD}?api_key=DEMO_KEY&date=1995-06-15`,
    today: `${APOD}?api_key=DEMO_KEY`,
  }, (res) => {
    const b = res.response.body;
    if (!b || !b.date) return { http_status: res.response.http_status, error: errOf(res), rate_limit_remaining: res.response.headers["x-ratelimit-remaining"] ?? null };
    return {
      http_status: res.response.http_status,
      date: b.date, title: b.title, media_type: b.media_type, copyright: b.copyright ?? null,
      url: b.url, has_hd: !!b.hdurl, explanation_start: (b.explanation || "").slice(0, 160),
      rate_limit_remaining: res.response.headers["x-ratelimit-remaining"] ?? null,
    };
  });
}

/* 💬 Hacker News（Algolia）：その日の話題。点数順に並ぶ？ いつから？ */
async function probeHn() {
  const day = (d) => [Date.parse(d + "T00:00:00Z") / 1000, Date.parse(d + "T00:00:00Z") / 1000 + 86400];
  const [a, b] = day("2020-03-12");
  const p = (o) => new URLSearchParams({ tags: "story", hitsPerPage: "10", ...o });
  return runCalls({
    top_2020_03_12: `${HN}/search?${p({ numericFilters: `created_at_i>=${a},created_at_i<${b}` })}`,
    bitcoin_2020_03_12: `${HN}/search?${p({ query: "bitcoin", numericFilters: `created_at_i>=${a},created_at_i<${b}`, hitsPerPage: "5" })}`,
    before_2007: `${HN}/search_by_date?${p({ numericFilters: "created_at_i<1167609600", hitsPerPage: "5" })}`,
  }, (res) => {
    const body = res.response.body;
    if (!body || !Array.isArray(body.hits)) return { http_status: res.response.http_status, error: errOf(res) };
    return {
      http_status: res.response.http_status,
      nbHits: body.nbHits,
      hits: body.hits.map((h) => ({ title: h.title, points: h.points, comments: h.num_comments, created_at: h.created_at, site: h.url ? (() => { try { return new URL(h.url).host; } catch { return null; } })() : null })),
    };
  });
}

/* ──────────────────────────────────────────
   /scene?day=YYYY-MM-DD — その日を、いくつもの窓から覗いた「景色」
   ・どれも「その日そのもの」を表すもの。ほとんどは、その日が終わってから決まった
     （D に立ったとき D 自身の景色を見せるかどうかは、画面の側で決める）
   ・窓ごとに時代がある。窓が開く前の日は ABSENT（理由つき）。取れなかった窓も ABSENT（0 にしない）
   ・過去の日の景色は変わらないので、倉庫（KV）にしまって使い回す
   ・窓ごとの「時間の性質」（ノヴァの3つ：観測・公開・改訂）は WINDOW_TIME にまとめて、返事の先頭に付ける
   ────────────────────────────────────────── */
const SCENE_V = "v2";
const WINDOW_FROM = { wikipedia: "2015-07-01", hacker_news: "2006-10-09", apod: "1995-06-16", fx: "1999-01-04", bitcoin_network: "2009-01-03", weather: "1940-01-01" };

/* 窓の時間の性質（ノヴァの4つの時間：起きた → 見えた → 公開された → 書き換わった）
   ・as_of_lag = D 00:00 UTC に立ったとき、その窓で「公開済み」だった一番新しい日は D − 何日か。
     まだ測っていない窓は安全側（2日）。/probe/published で実測中
   ・value_status = 見せている値の状態。as_published（公開されたまま変わらない）／current（今も変わり続けていて、今の値を見せる）
     ／revised（あとから書き換わる。今の値を見せる）。AS OF の画面でも、値そのものはこの状態のまま（ノヴァの二軸） */
const WINDOW_TIME = {
  // 4つの時間は型紙。窓が持っているものだけ書く（2026-09-27、ノヴァ）
  wikipedia_en: { event: "people reading during the UTC day", observation: "counted by Wikimedia as it happens", publication: "about a day after the day ends (being measured: /probe/published)", value_status: "as_published", as_of_lag: 2 },
  wikipedia_ja: { event: "people reading during the UTC day", observation: "counted by Wikimedia as it happens", publication: "about a day after the day ends (being measured: /probe/published)", value_status: "as_published", as_of_lag: 2 },
  hacker_news: { event: "stories posted during the UTC day", publication: "the moment they are posted", revision: "points and comments keep changing; RE: can only read today's values", value_status: "current", as_of_lag: 1 },
  apod: { publication: "one picture per date, US Eastern time (before 00:00 UTC of the next day)", value_status: "as_published", as_of_lag: 1 },
  earthquakes: { event: "earthquakes during the UTC day", observation: "detected within minutes", publication: "within about an hour of each event", revision: "magnitudes and locations are revised, sometimes years later; RE: can only read today's values", value_status: "revised", as_of_lag: 1 },
  fx: { event: "the ECB sets one reference rate per business day", publication: "that day, about 16:00 CET", value_status: "as_published", as_of_lag: 1 },
  bitcoin_network: { event: "blocks and transactions during the UTC day", observation: "public on the chain as it happens; the hash rate is estimated from how fast blocks were found", publication: "daily chart values from Blockchain.com; when a day appears is being measured (/probe/published)", value_status: "current", as_of_lag: 2 },
  weather: { event: "the weather during the UTC day at one place", observation: "felt and measured there as it happens", publication: "Open-Meteo Best Match: ECMWF IFS every 6 hours without delay (2017 on), ERA5 about 5 days later (1940 on); being measured: /probe/published", revision: "recent values can change when ERA5 arrives; days before 2017 are a reconstruction made years later", value_status: "revised", as_of_lag: 2 },
  x: { event: "posts during the UTC day", publication: "the moment they are posted", revision: "posts can be deleted or edited later", value_status: "current", as_of_lag: 1 },
};
const WIKI_SKIP = /^(Main_Page|Special:|Wikipedia:|User:|User_talk:|Portal:|File:|Help:|Template:|Category:|Talk:|Draft:|MediaWiki:|Module:|メインページ$|特別:|利用者:|ファイル:|ヘルプ:|ノート:|ポータル:|プロジェクト:|-$)/;

function absent(reason) { return { state: "absent", reason }; }
function failed(r) {
  const why = r.response.text || (r.response.body && (r.response.body.reason || r.response.body.msg || r.response.body.title)) || `HTTP ${r.response.http_status}`;
  return absent(`could not be read this time: ${String(why).slice(0, 160)}`);
}
function htmlText(s) {
  return String(s || "").replace(/<[^>]*>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();
}

async function sceneWikipedia(day, lang) {
  if (day < WINDOW_FROM.wikipedia) return absent(`this window opens on ${WINDOW_FROM.wikipedia}`);
  const r = await look(`${WIKI}/top/${lang}.wikipedia/all-access/${day.replace(/-/g, "/")}`, { timeoutMs: 8000 });
  const arts = r.response.body && r.response.body.items && r.response.body.items[0] && r.response.body.items[0].articles;
  if (!Array.isArray(arts)) return r.response.http_status === 404 ? absent("not published yet (about a day late)") : failed(r);
  const items = arts.filter((a) => !WIKI_SKIP.test(a.article)).slice(0, 10).map((a) => ({
    title: a.article.replace(/_/g, " "), views: a.views, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(a.article)}`,
  }));
  return { state: "on", source: `Wikimedia pageviews, most-read ${lang}.wikipedia pages (site pages removed)`, known: "after the day ends (about a day later)", items };
}

async function sceneHackerNews(day) {
  if (day < WINDOW_FROM.hacker_news) return absent(`this window opens on ${WINDOW_FROM.hacker_news}`);
  const a = Date.parse(day + "T00:00:00Z") / 1000;
  const q = new URLSearchParams({ tags: "story", hitsPerPage: "5", numericFilters: `created_at_i>=${a},created_at_i<${a + 86400}` });
  const r = await look(`${HN}/search?${q}`, { timeoutMs: 8000 });
  const hits = r.response.body && r.response.body.hits;
  if (!Array.isArray(hits)) return failed(r);
  return {
    state: "on", source: "Hacker News via Algolia, stories of the day by points", known: "during and after the day (points keep changing)",
    items: hits.map((h) => ({ title: h.title, points: h.points, comments: h.num_comments, url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`, hn_url: `https://news.ycombinator.com/item?id=${h.objectID}` })),
  };
}

/* NASA APOD はキーを使わずに、その日のページ（静的な HTML）から題名と credit を読む */
async function sceneApod(day) {
  if (day < WINDOW_FROM.apod) return absent(`this window opens on ${WINDOW_FROM.apod}`);
  const page = `https://apod.nasa.gov/apod/ap${day.slice(2, 4)}${day.slice(5, 7)}${day.slice(8, 10)}.html`;
  const res = await fetchText(page, 8000);
  if (!res.ok) return res.status === 404 ? absent("no picture page for this day") : absent(`could not be read this time: ${res.error || "HTTP " + res.status}`);
  const t = (res.text.match(/<title>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const title = htmlText(t).replace(/^APOD:\s*\d{4}\s+\w+\s+\d{1,2}\s*-\s*/i, "");
  const cm = res.text.match(/(Credit|Copyright)[\s\S]{0,400}?(<\/center>|<\/p>|<p>)/i);
  const credit = cm ? htmlText(cm[0]).replace(/\s*(Explanation|Tomorrow's picture).*$/i, "").replace(/\s+:/g, ":").slice(0, 160) : null;
  return { state: "on", source: "NASA Astronomy Picture of the Day (page link; images belong to their credited owners)", known: "published that day (US time)", title: title || null, credit, page_url: page };
}
async function fetchText(url, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl.signal });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } catch (e) {
    return { ok: false, status: -1, error: ctl.signal.aborted ? `no answer within ${timeoutMs / 1000} s` : String(e && e.message ? e.message : e) };
  } finally { clearTimeout(timer); }
}

async function sceneQuakes(day) {
  const p = (o) => new URLSearchParams({ format: "geojson", minmagnitude: "4.5", starttime: day, endtime: shiftDay(day, 1), ...o });
  const [c, q] = await Promise.all([
    look(`${USGS}/count?${p({})}`, { timeoutMs: 8000 }),
    look(`${USGS}/query?${p({ orderby: "magnitude", limit: "3" })}`, { timeoutMs: 8000 }),
  ]);
  const count = c.response.body && typeof c.response.body.count === "number" ? c.response.body.count : null;
  const feats = q.response.body && Array.isArray(q.response.body.features) ? q.response.body.features : null;
  if (count === null && !feats) return failed(c);
  const biggest = (feats || []).map((f) => ({ mag: f.properties.mag, place: f.properties.place, time: iso(f.properties.time), updated: f.properties.updated ? iso(f.properties.updated) : null }));
  const revised = biggest.some((b) => b.updated && Date.parse(b.updated) - Date.parse(b.time) > 30 * DAY);
  return {
    state: "on", source: "USGS earthquake catalog, magnitude 4.5 and above (UTC day)", known: "within about an hour; revised later",
    count_m45: count, biggest, revised_later: revised,
  };
}

async function sceneFx(day) {
  if (day < WINDOW_FROM.fx) return absent(`this window opens on ${WINDOW_FROM.fx}`);
  const r = await look(`${FRANKFURTER}/${day}?base=USD&symbols=JPY,EUR`, { timeoutMs: 8000 });
  const b = r.response.body;
  if (!b || !b.rates) return failed(r);
  return {
    state: "on", source: "ECB reference rates via Frankfurter", known: "published on business days (about 16:00 CET)",
    rate_date: b.date, usd_jpy: b.rates.JPY ?? null, usd_eur: b.rates.EUR ?? null,
    note: b.date !== day ? `no rate on ${day} (weekend or holiday); this is ${b.date}` : null,
  };
}

/* ⛏️ Bitcoin ネットワーク（Blockchain.com）
   取引数はその日の値と7日前（同じ曜日）との比較。ハッシュレートは1日ごとだとブロックの出方でぶれるので、
   7日平均（その日まで）と、その前の7日平均との比較で見せる */
async function sceneChain(day) {
  if (day < WINDOW_FROM.bitcoin_network) return absent(`this window opens on ${WINDOW_FROM.bitcoin_network}`);
  const from = shiftDay(day, -13);
  const q = (chart) => `${CHAIN}/${chart}?start=${from}&timespan=14days&format=json&sampled=false`;
  const [tx, hr] = await Promise.all([look(q("n-transactions"), { timeoutMs: 8000 }), look(q("hash-rate"), { timeoutMs: 8000 })]);
  const at = (r) => {
    const v = r.response.body && Array.isArray(r.response.body.values) ? r.response.body.values : null;
    if (!v) return null;
    const m = new Map();
    for (const p of v) if (p && typeof p.x === "number" && typeof p.y === "number") m.set(ymdOf(Math.floor(p.x / 86400)), p.y);
    return m;
  };
  const tm = at(tx), hm = at(hr);
  if (!tm && !hm) return failed(tx);
  const recent = day >= shiftDay(dayKey(iso(nowMs())), -1);
  const missing = (m) => (!m ? "could not be read this time" : recent ? "not published yet" : "the chart has no value for this day");
  // 取引数：その日と7日前
  const tv = tm && tm.has(day) ? tm.get(day) : null;
  const tb = tm && tm.has(shiftDay(day, -7)) ? tm.get(shiftDay(day, -7)) : null;
  // ハッシュレート：7日平均（5日以上そろっているときだけ）
  const avg = (endDay) => {
    if (!hm) return null;
    let sum = 0, n = 0;
    for (let i = 0; i < 7; i++) { const d = shiftDay(endDay, -i); if (hm.has(d)) { sum += hm.get(d); n++; } }
    return n >= 5 ? sum / n : null;
  };
  const hv = hm && hm.has(day) ? avg(day) : null;
  const hb = avg(shiftDay(day, -7));
  if (tv === null && hv === null) return absent(missing(tm || hm));
  return {
    state: "on", source: "Blockchain.com charts (n-transactions, hash-rate)",
    transactions: tv, transactions_change_7d: tv !== null && tb ? tv / tb - 1 : null, transactions_why: tv === null ? missing(tm) : null,
    hash_rate_avg7_th_s: hv, hash_rate_avg7_change: hv !== null && hb ? hv / hb - 1 : null, hash_rate_why: hv === null ? missing(hm) : null,
  };
}

/* ☁️ 天気（Open-Meteo）：場所はまだ決まっていないので、?lat=&lon=&place= を渡されたときだけ開く */
const WMO = [[0, "clear"], [3, "partly cloudy"], [48, "fog"], [57, "drizzle"], [67, "rain"], [77, "snow"], [82, "rain showers"], [86, "snow showers"], [99, "thunderstorm"]];
function wmoText(c) {
  if (typeof c !== "number") return null;
  if (c === 0) return "clear";
  if (c <= 3) return c === 3 ? "overcast" : "partly cloudy";
  for (const [max, t] of WMO) if (c <= max) return t;
  return null;
}
function placeOf(url) {
  const lat = Number(url.searchParams.get("lat")), lon = Number(url.searchParams.get("lon"));
  if (!url.searchParams.has("lat") || !url.searchParams.has("lon")) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { bad: true };
  const name = (url.searchParams.get("place") || "").replace(/[^\p{L}\p{N} ,.'()-]/gu, "").slice(0, 60) || `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  return { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100, name };
}
async function sceneWeather(day, place) {
  if (day < WINDOW_FROM.weather) return absent(`this window opens on ${WINDOW_FROM.weather}`);
  const daily = "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max,weather_code";
  const r = await look(`${OPEN_METEO}?${new URLSearchParams({ latitude: String(place.lat), longitude: String(place.lon), start_date: day, end_date: day, daily, timezone: "UTC" })}`, { timeoutMs: 8000 });
  const d = r.response.body && r.response.body.daily;
  if (!d || !Array.isArray(d.time)) return absent(`could not be read this time: ${String(errOf(r) || "HTTP " + r.response.http_status).slice(0, 160)}`);
  const i = d.time.indexOf(day);
  const val = (k) => (i >= 0 && d[k] && d[k][i] !== undefined ? d[k][i] : null);
  if (i < 0 || val("temperature_2m_max") === null) return absent("no value for this day yet");
  return {
    state: "on", source: "Open-Meteo historical weather (UTC day)", place: place.name, lat: place.lat, lon: place.lon,
    temp_max_c: val("temperature_2m_max"), temp_min_c: val("temperature_2m_min"), precipitation_mm: val("precipitation_sum"),
    wind_max_kmh: val("wind_speed_10m_max"), weather_code: val("weather_code"), weather: wmoText(val("weather_code")),
  };
}

function sceneX(day) {
  const q = `bitcoin since:${day} until:${shiftDay(day, 1)}`;
  return {
    state: "door", source: "X search (opens in X; RE: fetches nothing from X)",
    url: `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=top`,
    note: "X's API has no free way to read past posts, so this window is a door, not data.",
  };
}

async function scene(env, url) {
  const day = url.searchParams.get("day");
  const today = dayKey(iso(nowMs()));
  if (!isDay(day) || day > today) {
    return out({ error: "bad parameters", problems: ["day is required as YYYY-MM-DD, not after today"], example: "/scene?day=2020-03-12" }, 400);
  }
  const place = placeOf(url);
  if (place && place.bad) return out({ error: "bad parameters", problems: ["lat must be −90…90 and lon −180…180"], example: "/scene?day=2020-03-12&lat=35.68&lon=139.69&place=Tokyo" }, 400);
  const ns = env.RE_CACHE || null;
  const key = `scene:${SCENE_V}:${day}`;
  // 返事の先頭に窓の時間の性質を付ける（しまってある景色の文字列はそのまま使う）
  const reply = async (text, how) => {
    let body = text;
    if (place) {
      const o = JSON.parse(text);
      o.windows.weather = await sceneWeather(day, place);
      body = JSON.stringify(o);
    }
    return new Response(`{"window_time":${JSON.stringify(WINDOW_TIME)},` + body.slice(1), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-RE-Scene": how, ...CORS } });
  };
  if (ns && url.searchParams.get("fresh") !== "1") {
    const hit = await ns.get(key);
    if (hit) return reply(hit, "archive");
  }
  const [wen, wja, hn, apod, quakes, fx, chain] = await Promise.all([
    sceneWikipedia(day, "en"), sceneWikipedia(day, "ja"), sceneHackerNews(day), sceneApod(day), sceneQuakes(day), sceneFx(day), sceneChain(day),
  ]);
  const windows = { wikipedia_en: wen, wikipedia_ja: wja, hacker_news: hn, apod, earthquakes: quakes, fx, bitcoin_network: chain, x: sceneX(day) };
  const body = {
    day,
    generated_at: iso(nowMs()),
    time_note: "HINDSIGHT: every window here describes this day itself, as its source reports it now. Most of it was published only after the day ended. For what was visible at 00:00 UTC on a day D, take each window from D − window_time[w].as_of_lag (AS OF).",
    windows,
  };
  const text = JSON.stringify(body);
  if (ns) {
    // 全部そろった過去の日（2日以上前）はずっとしまう。欠けがある日や最近の日は1時間だけ
    const complete = Object.values(windows).every((w) => w.state !== "absent" || /opens on|no picture page|has no value for this day/.test(w.reason || ""));
    const settled = day <= shiftDay(today, -3);
    try {
      await ns.put(key, text, complete && settled ? {} : { expirationTtl: 3600 });
    } catch (e) { console.error("scene cache", e); }
  }
  return reply(text, "fresh");
}

/* ──────────────────────────────────────────
   /window-series?w=attention|tx|hash|weather — 数字の窓の毎日の値（似てる過去を窓ごとに比べるため）
   ・attention = Wikipedia 英語版 "Bitcoin" 記事の閲覧数（人のアクセスだけ）。2015-07-01 から
   ・tx / hash = Blockchain.com の取引数とハッシュレート（TH/s）
   ・weather   = Open-Meteo の天気（?lat=&lon=&place= の場所。UTC の1日）
   値は「その日に起きた分」。D 00:00 に見えていたのは D − as_of_lag の分まで（画面の側でずらす）
   倉庫（KV）に6時間しまう（毎回取りに行かない。書き込みは窓ごとに1日4回まで）
   ────────────────────────────────────────── */
const SERIES_V = "v1";
const SERIES_FROM = "2012-04-01"; // 倉庫の最初の日（2013-04-28）の1年前から：最初の日から「過去1年の中の位置」が出せるように
const SERIES_TTL = 6 * 3600;
async function seriesAttention(today) {
  const r = await look(`${WIKI}/per-article/en.wikipedia/all-access/user/Bitcoin/daily/2015070100/${ymdCompact(today)}00`, { timeoutMs: 12000 });
  const items = r.response.body && Array.isArray(r.response.body.items) ? r.response.body.items : null;
  if (!items || !items.length) return { error: String(errOf(r) || `HTTP ${r.response.http_status}`).slice(0, 200) };
  const d0 = dayNum("2015-07-01");
  const n = dayNum(today) - d0 + 1;
  const values = new Array(n).fill(null);
  for (const it of items) {
    const t = it.timestamp; // YYYYMMDD00
    const i = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8)) / DAY - d0;
    if (i >= 0 && i < n && typeof it.views === "number") values[i] = it.views;
  }
  let last = n - 1;
  while (last >= 0 && values[last] === null) last--;
  return { from: "2015-07-01", values: values.slice(0, last + 1), unit: "views per day (people, not bots)", source: "Wikimedia pageviews: en.wikipedia 'Bitcoin'" };
}
async function seriesChain(chart, today) {
  // timespan=all はプローブで確かめた形（2009年からの全部。SERIES_FROM より前は捨てる）
  const r = await look(`${CHAIN}/${chart}?timespan=all&format=json&sampled=false`, { timeoutMs: 12000 });
  const v = r.response.body && Array.isArray(r.response.body.values) ? r.response.body.values : null;
  if (!v || !v.length) return { error: String(errOf(r) || `HTTP ${r.response.http_status}`).slice(0, 200) };
  const d0 = dayNum(SERIES_FROM);
  const n = dayNum(today) - d0 + 1;
  const values = new Array(n).fill(null);
  for (const p of v) {
    if (!p || typeof p.x !== "number" || typeof p.y !== "number") continue;
    const i = Math.floor(p.x / 86400) - d0;
    if (i >= 0 && i < n) values[i] = Number(p.y.toPrecision(5));
  }
  let last = n - 1;
  while (last >= 0 && values[last] === null) last--;
  return chart === "hash-rate"
    ? { from: SERIES_FROM, values: values.slice(0, last + 1), unit: "TH/s (daily estimate)", source: "Blockchain.com hash-rate" }
    : { from: SERIES_FROM, values: values.slice(0, last + 1), unit: "confirmed transactions per day", source: "Blockchain.com n-transactions" };
}
async function seriesWeather(place, today) {
  const daily = "temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code";
  const r = await look(`${OPEN_METEO}?${new URLSearchParams({ latitude: String(place.lat), longitude: String(place.lon), start_date: SERIES_FROM, end_date: today, daily, timezone: "UTC" })}`, { timeoutMs: 15000 });
  const d = r.response.body && r.response.body.daily;
  if (!d || !Array.isArray(d.time)) return { error: String(errOf(r) || `HTTP ${r.response.http_status}`).slice(0, 200) };
  let last = d.time.length - 1;
  while (last >= 0 && (d.temperature_2m_max[last] === null || d.temperature_2m_max[last] === undefined)) last--;
  const cut = (k) => (d[k] || []).slice(0, last + 1).map((x) => (typeof x === "number" ? x : null));
  return { from: d.time[0], place: place.name, lat: place.lat, lon: place.lon, tmax: cut("temperature_2m_max"), tmin: cut("temperature_2m_min"), precip: cut("precipitation_sum"), code: cut("weather_code"), unit: "°C, mm (UTC day)", source: "Open-Meteo historical weather (Best Match)" };
}
async function windowSeries(env, url) {
  const w = url.searchParams.get("w");
  const lagOf = { attention: WINDOW_TIME.wikipedia_en.as_of_lag, tx: WINDOW_TIME.bitcoin_network.as_of_lag, hash: WINDOW_TIME.bitcoin_network.as_of_lag, weather: WINDOW_TIME.weather.as_of_lag };
  if (!(w in lagOf)) return out({ error: "bad parameters", problems: ["w must be attention, tx, hash or weather"], example: "/window-series?w=attention" }, 400);
  const place = w === "weather" ? placeOf(url) : null;
  if (w === "weather" && (!place || place.bad)) return out({ error: "bad parameters", problems: ["weather needs lat (−90…90) and lon (−180…180)"], example: "/window-series?w=weather&lat=35.68&lon=139.69&place=Tokyo" }, 400);
  const ns = env.RE_CACHE || null;
  const key = `wseries:${SERIES_V}:${w}${place ? `:${place.lat},${place.lon}` : ""}`;
  const send = (text, how) => new Response(text, { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-RE-Window": how, ...CORS } });
  if (ns && url.searchParams.get("fresh") !== "1") {
    const hit = await ns.get(key);
    if (hit) return send(hit, "archive");
  }
  const today = dayKey(iso(nowMs()));
  const body = w === "attention" ? await seriesAttention(today)
    : w === "tx" ? await seriesChain("n-transactions", today)
    : w === "hash" ? await seriesChain("hash-rate", today)
    : await seriesWeather(place, today);
  if (body.error) return out({ error: `the ${w} window could not be read this time`, detail: body.error }, 502);
  const text = JSON.stringify({ w, as_of_lag: lagOf[w], generated_at: iso(nowMs()), ...body });
  if (ns) { try { await ns.put(key, text, { expirationTtl: SERIES_TTL }); } catch (e) { console.error("window cache", e); } }
  return send(text, "fresh");
}

/* ──────────────────────────────────────────
   いつ公開されたか（/probe/published）
   「D 00:00 に D−1 の分はもう出ていたか」を測る。cron のたびに、昨日（UTC）の分が出たかを見て、
   初めて見えた時刻を記録する。F&G の fng-timing と同じ考え方。書き込むのは何か新しく分かったときだけ
   ────────────────────────────────────────── */
const PUB_KEY = "published:v1";
const PUB_KEEP_DAYS = 21;
const PUB_SOURCES = {
  wikipedia_top: (y) => `${WIKI}/top/en.wikipedia/all-access/${y.replace(/-/g, "/")}`,
  wikipedia_article: (y) => `${WIKI}/per-article/en.wikipedia/all-access/user/Bitcoin/daily/${ymdCompact(y)}00/${ymdCompact(y)}00`,
  bitcoin_network: (y) => `${CHAIN}/n-transactions?start=${shiftDay(y, -1)}&timespan=3days&format=json&sampled=false`,
  weather: (y) => `${OPEN_METEO}?${new URLSearchParams({ latitude: "35.68", longitude: "139.69", start_date: y, end_date: y, daily: "temperature_2m_max", timezone: "UTC" })}`,
};
async function isPublished(name, y) {
  const url = PUB_SOURCES[name](y);
  if (name === "wikipedia_top") {
    const r = await fetchText(url, 8000);
    return r.ok && r.text.includes('"articles"');
  }
  const r = await look(url, { timeoutMs: 8000 });
  const b = r.response.body;
  if (name === "wikipedia_article") return !!(b && Array.isArray(b.items) && b.items.length);
  if (name === "weather") return !!(b && b.daily && Array.isArray(b.daily.temperature_2m_max) && b.daily.temperature_2m_max[0] !== null && b.daily.temperature_2m_max[0] !== undefined);
  const t0 = dayNum(y) * 86400;
  return !!(b && Array.isArray(b.values) && b.values.some((p) => p && p.x === t0));
}
async function observePublication(env, nowAt = nowMs()) {
  const ns = env.RE_CACHE;
  const y = shiftDay(dayKey(iso(nowAt)), -1);
  const log = (await kvJson(ns, PUB_KEY)) || { days: {} };
  const rec = log.days[y] || (log.days[y] = { first_checked: iso(nowAt), seen: {} });
  let changed = !log.days[y].checks;
  rec.checks = (rec.checks || 0) + 1;
  const todo = Object.keys(PUB_SOURCES).filter((n) => !rec.seen[n]);
  const got = await Promise.all(todo.map((n) => isPublished(n, y).catch(() => false)));
  todo.forEach((n, i) => { if (got[i]) { rec.seen[n] = iso(nowAt); changed = true; } });
  // 古い日は捨てる
  for (const d of Object.keys(log.days)) if (d < shiftDay(y, -PUB_KEEP_DAYS)) { delete log.days[d]; changed = true; }
  // 数えるだけの更新（checks）は、何か分かったときに一緒に書く（書き込み回数を増やさない）
  if (changed) await ns.put(PUB_KEY, JSON.stringify(log));
  return { day: y, checked: todo, newly_seen: todo.filter((_, i) => got[i]) };
}
function analyzePublication(log) {
  const days = log && log.days ? Object.keys(log.days).sort().reverse() : [];
  const rows = days.map((d) => {
    const r = log.days[d];
    const end = Date.parse(shiftDay(d, 1) + "T00:00:00Z");
    const after = (t) => (t ? Math.round((Date.parse(t) - end) / 60000) : null);
    const seen = {};
    for (const n of Object.keys(PUB_SOURCES)) {
      const t = r.seen[n] || null;
      seen[n] = t ? { first_seen: t, minutes_after_day_end: after(t) } : { first_seen: null, minutes_after_day_end: null };
    }
    return { day: d, first_checked: r.first_checked, first_checked_minutes_after_day_end: after(r.first_checked), seen };
  });
  return {
    question: "Was day D − 1 already published at D 00:00 UTC? For each source, the first time RE: saw yesterday's value (checked twice an hour, at :05 and :35). Weather is checked at one point (Tokyo) as a sample.",
    how_to_read: "minutes_after_day_end = when it was first seen, counted from the end of that day (00:00 UTC of the next day). If it equals first_checked_minutes_after_day_end, it was already there at the first look, so it was published earlier than that.",
    days: rows,
  };
}

/* cron: 毎時 5分・35分。F&G の観測 → 倉庫の1歩 */
async function runCron(env, scheduledTime) {
  if (!env.CMC_KEY || !env.RE_CACHE) return;
  try { await observeFng(env); } catch (e) { console.error("observeFng", e); }
  try { await observePublication(env, scheduledTime || nowMs()); } catch (e) { console.error("observePublication", e); }
  for (const id of ARCHIVE_IDS) {
    try { await archiveStep(env, id, scheduledTime || nowMs(), "cron"); } catch (e) { console.error("archiveStep", id, e); }
  }
}

function noStorage() {
  return {
    error: "archive storage is not connected yet",
    fix: "add the RE_CACHE KV binding to wrangler.toml (see the repository)",
  };
}

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";

    try {
      // 画面（public/index.html）がある間は "/" は静的ファイルが先に返す。API の一覧は /api でも見られる
      if (p === "/" || p === "/api") {
        return out({
          name: "RE: — A Temporal Exploration Playground (worker)",
          definition: DEFINITION,
          endpoints: [
            "/ — the app (public/index.html, public/app.js, public/engine.js)",
            "/series?id=1 — every stored day for the asset, from the archive (no CMC call). Optional &from=2020&to=2024 (years)",
            "/scene?day=YYYY-MM-DD — the same day through other windows: Wikipedia (en, ja), Hacker News, NASA APOD, earthquakes, ECB rates, the Bitcoin network, and a door to X search. window_time says, per window, when it is observed, published and revised, and how many days back it was visible at D 00:00 UTC (as_of_lag). Add &lat=&lon=&place= for the weather at one place",
            "/window-series?w=attention|tx|hash|weather — every day's value of one numeric window (Wikipedia 'Bitcoin' views, Bitcoin transactions, hash rate, or the weather at &lat=&lon=&place=), kept 6 hours. The value on a day is what happened that day; at D 00:00 UTC only D − as_of_lag was out",
            "/probe/published — when yesterday's Wikipedia, Bitcoin-network and weather values first appeared (measured by the cron, for the AS OF view)",
            "/archive/status — what the archive holds, what is missing, recent errors",
            "/archive/step — do one unit of archive work now (build one missing year, or refresh the recent days)",
            "/state?id=1&start=YYYY-MM-DD&end=YYYY-MM-DD — MarketState for every day from start to end, live from CMC (start and end are required, both inclusive)",
            "/probe/btc, /probe/ohlcv — raw CMC responses (evidence)",
            "/probe/fng — every Fear & Greed page, with oldest/newest, missing and duplicate days (?raw=1 for every row)",
            "/probe/fng-timing — when each Fear & Greed value first appeared in the API, and which live value it equals",
            "/probe/wiki — Wikipedia page views: where the daily series starts, gaps, delay, other languages, redirects, the whole-site total",
            "/probe/wiki-top — Wikipedia's most-read pages of a day: where they start, how many, by language and country, how late the newest list is",
            "/probe/gdelt — GDELT news volume for 'bitcoin': how far back it reaches (takes ~20 s: GDELT allows one call every 5 s; ?only=before_2017|2017_01|2020_03|last_7_days for one call)",
            "/probe/weather — Open-Meteo daily weather: where it starts, how late the newest days are, 2013→today in one call",
            "/probe/quakes — USGS earthquakes: daily counts, the biggest of a day, whether events are updated later",
            "/probe/fx — ECB exchange rates (Frankfurter): where they start, weekends, the latest date",
            "/probe/chain — Blockchain.com charts: transactions per day and hash rate since the start, spacing and time of day",
            "/probe/apod — NASA Astronomy Picture of the Day: first day, copyright field, DEMO_KEY limit",
            "/probe/hn — Hacker News (Algolia): the top stories of a day, and how far back the index goes",
          ],
          archive_layout: ARCHIVE_LAYOUT,
          fng_time_note: FNG_TIME_NOTE,
          note: "id=1 is the real Bitcoin. symbol=BTC also returns unrelated tokens with the same symbol, so always use id.",
        });
      }

      /* ── 他の窓の probe（CMC のキーも倉庫もいらない）── */
      if (p === "/probe/wiki") return out(await probeWiki());
      if (p === "/probe/wiki-top") return out(await probeWikiTop());
      if (p === "/scene") return await scene(env, url);
      if (p === "/window-series") return await windowSeries(env, url);
      if (p === "/probe/gdelt") return out(await probeGdelt(url.searchParams.get("only")));
      if (p === "/probe/weather") return out(await probeWeather());
      if (p === "/probe/quakes") return out(await probeQuakes());
      if (p === "/probe/fx") return out(await probeFx());
      if (p === "/probe/chain") return out(await probeChain());
      if (p === "/probe/apod") return out(await probeApod());
      if (p === "/probe/hn") return out(await probeHn());

      /* ── 倉庫だけで答えるもの（CMC を叩かない）── */
      if (p === "/series" || p === "/archive/status" || p === "/probe/fng-timing" || p === "/probe/published") {
        if (!env.RE_CACHE) return out(noStorage(), 503);
        if (p === "/probe/published") return out(analyzePublication(await kvJson(env.RE_CACHE, PUB_KEY)));
        if (p === "/series") return await series(env, url);
        if (p === "/archive/status") return out(await archiveStatus(env));
        return out(analyzeTiming(await kvJson(env.RE_CACHE, TIMING_KEY)));
      }

      /* ── ここから先は CMC を叩く ── */
      if (!env.CMC_KEY) return out({ error: "CMC_KEY not set in Secrets" }, 400);

      if (p === "/archive/step") {
        if (!env.RE_CACHE) return out(noStorage(), 503);
        const now = nowMs();
        const results = [];
        for (const id of ARCHIVE_IDS) results.push(await archiveStep(env, id, now, "manual"));
        return out({ results, see: "/archive/status" });
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
            span_days: fa.oldest ? daysBetween(fa.oldest, fa.newest) + 1 : 0,
            missing_days: cap(fa.missing, 200),
            duplicate_days: cap(fa.duplicates, 50),
            off_midnight: cap(fa.offMidnight, 50),
            exact_repeats: fa.exactRepeats,
            pages: fr.pages.length,
            credits: fr.credits,
            ok: fr.ok,
          },
          pages: fr.pages,
          newest_rows: fr.rows.slice(0, 2),
          oldest_rows: fr.rows.slice(-2),
        };
        if (url.searchParams.get("raw") === "1") body.rows = fr.rows;
        return out(body);
      }

      /* ── MarketState を組む（CMC から直接）── */
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

        const [qr, orr, fr] = await Promise.all([
          fetchQuotes(env, id, start, end),
          fetchOhlcv(env, id, start, end),
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
            upstream: { quotes: upstream(qr), ohlcv: upstream(orr), fng_pages: fr.pages.length, fng_ok: fr.ok },
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

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runCron(env, controller.scheduledTime));
  },
};
