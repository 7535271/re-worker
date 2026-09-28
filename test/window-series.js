// Offline test for /window-series (numeric windows), with full-size simulated payloads and a CPU check.
import worker from "../src/worker.js";

const NOW = Date.parse("2026-09-26T15:00:00Z");
Date.now = () => NOW;
let failures = 0;
const check = (label, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); if (!cond) failures++; };
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// payloads built once (real sizes: ~4,100 Wikipedia days, ~6,400 chain days, ~5,300 weather days)
const wikiItems = [];
for (let t = Date.parse("2015-07-01"); t <= Date.parse("2026-09-25"); t += DAY) {
  const d = ymd(t).replace(/-/g, "");
  wikiItems.push({ project: "en.wikipedia", article: "Bitcoin", granularity: "daily", timestamp: d + "00", access: "all-access", agent: "user", views: 5000 + (t / DAY) % 3000 });
}
const WIKI_TEXT = JSON.stringify({ items: wikiItems });
const chainText = (hash) => {
  const values = [];
  for (let t = Date.parse("2009-01-03"); t <= Date.parse("2026-09-24"); t += DAY) {
    if (ymd(t) === "2016-05-10") continue; // a gap the chart really has somewhere
    values.push({ x: t / 1000, y: hash ? 1e-6 * Math.exp((t - Date.parse("2009-01-03")) / DAY / 250) : 1000 + (t / DAY) % 400000 });
  }
  return JSON.stringify({ status: "ok", name: hash ? "Total Hash Rate (TH/s)" : "Confirmed Transactions Per Day", unit: hash ? "Hash Rate TH/s" : "Transactions", period: "day", values });
};
const TX_TEXT = chainText(false), HASH_TEXT = chainText(true);
const flags = { chainDown: false };
let calls = 0;

globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  calls++;
  if (u.host === "wikimedia.org") return new Response(WIKI_TEXT, { status: 200 });
  if (u.host === "api.blockchain.info") {
    if (flags.chainDown) return new Response("Service Unavailable", { status: 503 });
    return new Response(u.pathname.endsWith("hash-rate") ? HASH_TEXT : TX_TEXT, { status: 200 });
  }
  if (u.host === "archive-api.open-meteo.com") {
    const s = u.searchParams.get("start_date"), e = u.searchParams.get("end_date");
    const time = [], tmax = [], tmin = [], precip = [], code = [];
    for (let t = Date.parse(s); t <= Date.parse(e); t += DAY) {
      const late = t > Date.parse(e) - 2 * DAY; // the newest days are not filled yet
      time.push(ymd(t)); tmax.push(late ? null : 20.5); tmin.push(late ? null : 11.2); precip.push(late ? null : 0); code.push(late ? null : 3);
    }
    return new Response(JSON.stringify({ daily: { time, temperature_2m_max: tmax, temperature_2m_min: tmin, precipitation_sum: precip, weather_code: code } }), { status: 200 });
  }
  return new Response("unexpected", { status: 500 });
};

class KV { constructor() { this.m = new Map(); this.opts = new Map(); } async get(k) { return this.m.get(k) ?? null; } async put(k, v, o) { this.m.set(k, v); this.opts.set(k, o || {}); } }
const env = { RE_CACHE: new KV() };
async function get(path) {
  const a = process.cpuUsage();
  const r = await worker.fetch(new Request("https://x" + path), env);
  const text = await r.text();
  const b = process.cpuUsage(a);
  return { status: r.status, how: r.headers.get("X-RE-Window"), body: JSON.parse(text), cpu: (b.user + b.system) / 1000 };
}

let r = await get("/window-series?w=nope");
check("unknown window → 400", r.status === 400);
r = await get("/window-series?w=weather");
check("weather without a place → 400", r.status === 400);

r = await get("/window-series?w=attention");
check("attention: from 2015-07-01, one value per day, through the newest published day", r.status === 200 && r.body.from === "2015-07-01" && r.body.values.length === wikiItems.length && r.body.values[0] === wikiItems[0].views && r.body.as_of_lag === 2, { n: r.body.values.length });
check("attention: kept 6 hours", env.RE_CACHE.opts.get("wseries:v1:attention").expirationTtl === 21600);
const cpuAttention = r.cpu;

r = await get("/window-series?w=tx");
const i0 = 0, gapIndex = (Date.parse("2016-05-10") - Date.parse("2012-04-01")) / DAY;
check("tx: starts at 2012-04-01 (a year before the archive), a skipped day is null, not 0", r.body.from === "2012-04-01" && r.body.values[i0] !== null && r.body.values[gapIndex] === null && r.body.values[gapIndex + 1] !== null, { gap: r.body.values[gapIndex] });
check("tx: ends at the newest day the chart has (2026-09-24)", r.body.values.length === (Date.parse("2026-09-24") - Date.parse("2012-04-01")) / DAY + 1);
const cpuTx = r.cpu;
r = await get("/window-series?w=hash");
check("hash: tiny early values survive rounding (5 significant digits)", r.body.values[0] > 0 && String(r.body.values[0]).replace(/[^0-9]/g, "").replace(/^0+/, "").length <= 7, r.body.values[0]);
const cpuHash = r.cpu;

r = await get("/window-series?w=weather&lat=35.68&lon=139.69&place=Tokyo");
check("weather: four columns from 2012-04-01, the unfilled newest days are cut off", r.body.from === "2012-04-01" && r.body.tmax.length === r.body.tmin.length && r.body.tmax.length === r.body.code.length && r.body.tmax[r.body.tmax.length - 1] === 20.5 && r.body.place === "Tokyo" && r.body.as_of_lag === 2, { n: r.body.tmax.length });
check("weather: stored per place", env.RE_CACHE.m.has("wseries:v1:weather:35.68,139.69"));
const cpuWeather = r.cpu;

const before = calls;
r = await get("/window-series?w=attention");
check("second time from the archive, no call outside", r.how === "archive" && calls === before);

flags.chainDown = true;
r = await get("/window-series?w=tx&fresh=1");
check("chain down → 502 with the reason, and the stored copy is kept", r.status === 502 && /could not be read/.test(r.body.error) && env.RE_CACHE.m.has("wseries:v1:tx"), r.body);
flags.chainDown = false;

console.log(`  CPU per fresh build (includes the simulated fetch): attention ${cpuAttention.toFixed(1)} ms · tx ${cpuTx.toFixed(1)} ms · hash ${cpuHash.toFixed(1)} ms · weather ${cpuWeather.toFixed(1)} ms`);
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
