// A small CoinMarketCap + Workers KV simulator for testing src/worker.js offline.
const DAY = 86400000;
const MIN = 60000;
export const iso = (t) => new Date(t).toISOString();
export const ds = (s) => Date.parse(s + "T00:00:00Z");
export const ymd = (t) => iso(t).slice(0, 10);

export const clock = { now: ds("2026-09-25") + 5 * MIN };
Date.now = () => clock.now;

const BTC_START = ds("2013-04-28");
const FNG_START = ds("2023-06-29");
const SUPPLY = 19e6;

export const cfg = {
  hypothesis: "A",        // A: historical[D] = live index at D 00:00; B: = live index at D+1 00:00
  fngLagMs: 26 * 3600000, // A: historical[D] shows up this long after D 00:00
  ohlcvEndExclusive: false,
  fail: { quotes: false, ohlcv: false, fng: false, latest: false, all401: false, fngPage2: false },
  memo: false,
};
export const calls = [];
const memo = new Map();

const idx = (t) => Math.round((t - BTC_START) / DAY);
export function P(i) { return 100 * Math.exp(i * 0.0017) * (1 + 0.3 * Math.sin(i / 37)) * (1 + 0.05 * Math.sin(i / 3.3)); }
export function V(i) { return 1e9 * (1 + i / 500) * (1.5 + Math.sin(i / 5)); }
export function g(t) { // live F&G index, recomputed every 15 minutes
  const step = Math.floor(t / (15 * MIN));
  const v = Math.round(50 + 30 * Math.sin(step / 97) + 10 * Math.sin(step / 13));
  return Math.max(0, Math.min(100, v));
}
const label = (v) => (v < 25 ? "Extreme fear" : v < 45 ? "Fear" : v < 55 ? "Neutral" : v < 75 ? "Greed" : "Extreme greed");

function quoteRow(t) {
  const i = idx(t);
  const p = P(i);
  const ch = (k) => (i - k >= 0 ? (p / P(i - k) - 1) * 100 : null);
  const ts = iso(t);
  return {
    timestamp: ts,
    quote: { USD: {
      price: p, percent_change_1h: 0.01 * Math.sin(i), percent_change_24h: ch(1), percent_change_7d: ch(7),
      percent_change_30d: ch(30), volume_24h: V(i - 1), market_cap: p * SUPPLY, total_supply: SUPPLY,
      circulating_supply: SUPPLY, timestamp: ts,
    } },
  };
}
function candleRow(t) {
  const i = idx(t);
  const open = P(i), close = P(i + 1);
  const high = Math.max(open, close) * (1.01 + 0.02 * Math.abs(Math.sin(i / 7)));
  const low = Math.min(open, close) * (0.99 - 0.02 * Math.abs(Math.cos(i / 11)));
  const tc = iso(t + DAY - 1);
  return {
    time_open: iso(t), time_close: tc, time_high: iso(t + 14 * 3600000), time_low: iso(t + 3 * 3600000),
    quote: { USD: { open, high, low, close, volume: V(i), market_cap: close * SUPPLY, timestamp: tc } },
  };
}
export function fngValueFor(dayT) {
  return cfg.hypothesis === "A" ? g(dayT) : g(dayT + DAY);
}
function fngPublished(dayT) {
  return cfg.hypothesis === "A" ? clock.now >= dayT + cfg.fngLagMs : clock.now >= dayT + DAY + 30 * MIN;
}
function fngRowsNewestFirst() {
  let d = Math.floor(clock.now / DAY) * DAY;
  while (d >= FNG_START && !fngPublished(d)) d -= DAY;
  const rows = [];
  for (; d >= FNG_START; d -= DAY) {
    const v = fngValueFor(d);
    rows.push({ timestamp: String(d / 1000), value: v, value_classification: label(v) });
  }
  return rows;
}

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
const st = (credits, code = 0, msg = null) => ({
  timestamp: iso(clock.now), error_code: code, error_message: msg, elapsed: 10, credit_count: credits, notice: null,
});

globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const key = init && init.headers && init.headers["X-CMC_PRO_API_KEY"];
  calls.push({ at: clock.now, path: u.pathname, q: u.search });
  if (cfg.memo && memo.has(u.toString())) {
    const m = memo.get(u.toString());
    return new Response(m.body, { status: m.status });
  }
  const res = route(u, key);
  if (cfg.memo) {
    const body = await res.clone().text();
    memo.set(u.toString(), { body, status: res.status });
  }
  return res;
};

function route(u, key) {
  if (!key) return json({ status: st(0, 1002, "API key missing.") }, 401);
  if (cfg.fail.all401) return json({ status: st(0, 1001, "This API Key is invalid.") }, 401);
  const sp = u.searchParams;
  if (u.pathname === "/v3/cryptocurrency/quotes/historical") {
    if (cfg.fail.quotes) return json({ status: st(0, 500, "Internal error") }, 500);
    const a = ds(sp.get("time_start")), b = ds(sp.get("time_end"));
    const quotes = [];
    for (let t = Math.max(a + DAY, BTC_START); t <= b; t += DAY) {
      if (t + 3 * MIN > clock.now) break;
      quotes.push(quoteRow(t));
    }
    return json({ status: st(Math.max(1, Math.ceil(quotes.length / 100))),
      data: { "1": { id: 1, name: "Bitcoin", symbol: "BTC", is_active: 1, is_fiat: 0, quotes } } });
  }
  if (u.pathname === "/v2/cryptocurrency/ohlcv/historical") {
    if (cfg.fail.ohlcv) return json({ status: st(0, 500, "Internal error") }, 500);
    const a = ds(sp.get("time_start")), b = ds(sp.get("time_end"));
    const quotes = [];
    for (let t = Math.max(a + DAY, BTC_START); cfg.ohlcvEndExclusive ? t < b : t <= b; t += DAY) {
      if (t + DAY + 3 * MIN > clock.now) break; // only closed candles
      quotes.push(candleRow(t));
    }
    return json({ status: st(Math.max(1, Math.ceil(quotes.length / 100))),
      data: { id: 1, name: "Bitcoin", symbol: "BTC", quotes } });
  }
  if (u.pathname === "/v3/fear-and-greed/historical") {
    const start = Number(sp.get("start") || 1), limit = Number(sp.get("limit") || 50);
    if (cfg.fail.fng || (cfg.fail.fngPage2 && start > 1)) return json({ status: st(0, 500, "Internal error") }, 500);
    const rows = fngRowsNewestFirst().slice(start - 1, start - 1 + limit);
    return json({ status: { ...st(1), error_code: "0", error_message: "" }, data: rows });
  }
  if (u.pathname === "/v3/fear-and-greed/latest") {
    if (cfg.fail.latest) return json({ status: st(0, 500, "Internal error") }, 500);
    const t = Math.floor(clock.now / (15 * MIN)) * 15 * MIN;
    const v = g(t);
    return json({ status: st(1), data: { value: v, update_time: iso(t), value_classification: label(v) } });
  }
  return json({ status: st(0, 404, "not found") }, 404);
}

export class KV {
  constructor() { this.m = new Map(); this.reads = 0; this.writes = 0; }
  async get(k) { this.reads++; return this.m.has(k) ? this.m.get(k) : null; }
  async put(k, v) { this.writes++; this.m.set(k, String(v)); }
}

export async function runCron(worker, env) {
  const pending = [];
  await worker.scheduled({ scheduledTime: clock.now, cron: "5,35 * * * *" }, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}
export async function get(worker, env, path) {
  const r = await worker.fetch(new Request("https://x" + path), env);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, bytes: text.length };
}
