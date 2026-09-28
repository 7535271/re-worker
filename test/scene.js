// Offline test for /scene?day= — the same day through other windows (simulated services, no network).
import worker from "../src/worker.js";

const NOW = Date.parse("2026-09-26T15:00:00Z");
Date.now = () => NOW;
let failures = 0;
const check = (label, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); if (!cond) failures++; };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json" } });
const flags = { hnHangs: false, chainDown: false, chainGap: null };

globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.host === "wikimedia.org" && u.pathname.includes("/per-article/")) {
    const d = u.pathname.split("/").pop().slice(0, 8);
    const day = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
    if (Date.parse(day) > NOW - 2 * 86400000) return json({ title: "Not found." }, 404);
    return json({ items: [{ article: "Bitcoin", timestamp: d + "00", views: 7824 }] });
  }
  if (u.host === "wikimedia.org") {
    const [y, m, d] = u.pathname.split("/").slice(-3);
    if (Date.parse(`${y}-${m}-${d}`) > NOW - 2 * 86400000) return json({ title: "Not found." }, 404);
    const ja = u.pathname.includes("ja.wikipedia");
    const names = ja ? ["メインページ", "特別:検索", "パンデミック", "森まさこ", "トム・ハンクス"] : ["Main_Page", "Special:Search", "United_States_Senate", "2019–20_coronavirus_pandemic", "Tom_Hanks", "Wikipedia:Featured_pictures", "Rita_Wilson"];
    return json({ items: [{ articles: names.map((a, i) => ({ article: a, views: 1000 - i, rank: i + 1 })) }] });
  }
  if (u.host === "hn.algolia.com") {
    if (flags.hnHangs) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));
    return json({ hits: [{ title: "U.S. will suspend all travel from Europe for 30 days", points: 920, num_comments: 866, url: "https://example.com/x", objectID: "22557286" }] });
  }
  if (u.host === "apod.nasa.gov") {
    if (!/ap200312\.html$/.test(u.pathname)) return new Response("<html><title>APOD: 2014 January 1 - A Picture</title><center><b>Image Credit:</b> NASA</center></html>", { status: 200 });
    return new Response(`<html><head><title> APOD: 2020 March 12 - Falcon 9 Boostback
</title></head><body><center><h1> Astronomy Picture of the Day </h1><p>2020 March 12<br><img src="image/2003/crs20_boostback1024.jpg"></center>
<center><b> Falcon 9 Boostback </b> <br><b> Image Credit &amp; <a href="lib/about_apod.html#srapply">Copyright</a>: </b> <a href="https://x">John Kraus</a></center>
<p> <b> Explanation: </b> Short star trails appear...</p></body></html>`, { status: 200, headers: { "content-type": "text/html" } });
  }
  if (u.host === "earthquake.usgs.gov") {
    if (u.pathname.endsWith("/count")) return json({ count: 18, maxAllowed: 20000 });
    return json({ features: [{ properties: { mag: 5.5, place: "127 km ESE of Neiafu, Tonga", time: Date.parse("2020-03-12T12:50:27Z"), updated: Date.parse("2025-12-22T18:31:00Z") } }] });
  }
  if (u.host === "api.blockchain.info") {
    if (flags.chainDown) return new Response("Service Unavailable", { status: 503 });
    const start = Date.parse(u.searchParams.get("start") + "T00:00:00Z") / 1000;
    const n = parseInt(u.searchParams.get("timespan"), 10);
    const lastPublished = Date.parse("2026-09-24T00:00:00Z") / 1000; // yesterday (09-25) is not out yet
    const isTx = u.pathname.endsWith("n-transactions");
    const values = [];
    for (let i = 0; i < n; i++) {
      const x = start + i * 86400;
      if (x > lastPublished || (flags.chainGap && x === Date.parse(flags.chainGap + "T00:00:00Z") / 1000)) continue;
      values.push({ x, y: isTx ? 300000 + i * 1000 : 100e6 + i * 1e6 });
    }
    return json({ status: "ok", name: isTx ? "Confirmed Transactions Per Day" : "Total Hash Rate (TH/s)", unit: isTx ? "Transactions" : "Hash Rate TH/s", period: "day", values });
  }
  if (u.host === "archive-api.open-meteo.com") {
    const d = u.searchParams.get("start_date");
    if (d >= "2026-09-25") return json({ latitude: 35.7, longitude: 139.7, timezone: "GMT", daily: { time: [d], temperature_2m_max: [null], temperature_2m_min: [null], precipitation_sum: [null], wind_speed_10m_max: [null], weather_code: [null] } });
    return json({ latitude: 35.7, longitude: 139.7, timezone: "GMT", daily: { time: [d], temperature_2m_max: [14.2], temperature_2m_min: [6.1], precipitation_sum: [0.4], wind_speed_10m_max: [18.3], weather_code: [61] } });
  }
  if (u.host === "api.frankfurter.dev") {
    const d = u.pathname.split("/").pop();
    const used = d === "2020-03-07" ? "2020-03-06" : d;
    return json({ amount: 1, base: "USD", date: used, rates: { JPY: 104.5, EUR: 0.88 } });
  }
  return new Response("unexpected " + u.host, { status: 500 });
};

class KV { constructor() { this.m = new Map(); this.opts = new Map(); } async get(k) { return this.m.get(k) ?? null; } async put(k, v, o) { this.m.set(k, v); this.opts.set(k, o || {}); } }
const env = { RE_CACHE: new KV() };
async function get(path) { const r = await worker.fetch(new Request("https://x" + path), env); return { status: r.status, how: r.headers.get("X-RE-Scene"), body: await r.json() }; }
const KEY = (d) => `scene:v2:${d}`;

let r = await get("/scene");
check("no day → 400", r.status === 400);
r = await get("/scene?day=2026-09-30");
check("a future day → 400", r.status === 400);

r = await get("/scene?day=2020-03-12");
const w = r.body.windows;
check("fresh the first time", r.status === 200 && r.how === "fresh");
check("wikipedia en: site pages removed, titles readable", w.wikipedia_en.items.map((i) => i.title).join("|") === "United States Senate|2019–20 coronavirus pandemic|Tom Hanks|Rita Wilson", w.wikipedia_en.items.map((i) => i.title));
check("wikipedia ja: メインページ and 特別: removed", w.wikipedia_ja.items[0].title === "パンデミック" && w.wikipedia_ja.items.length === 3, w.wikipedia_ja.items.map((i) => i.title));
check("hacker news: top story with its HN link", w.hacker_news.items[0].points === 920 && /item\?id=22557286/.test(w.hacker_news.items[0].hn_url));
check("apod: title and credit read from the page, link kept", w.apod.title === "Falcon 9 Boostback" && /John Kraus/.test(w.apod.credit) && w.apod.page_url.endsWith("ap200312.html"), { title: w.apod.title, credit: w.apod.credit });
check("earthquakes: count, biggest, revised later", w.earthquakes.count_m45 === 18 && w.earthquakes.biggest[0].mag === 5.5 && w.earthquakes.revised_later === true);
check("fx: a weekday has no note", w.fx.rate_date === "2020-03-12" && w.fx.note === null && w.fx.usd_jpy === 104.5);
check("x: a door, not data", w.x.state === "door" && decodeURIComponent(w.x.url).includes("since:2020-03-12 until:2020-03-13"));
check("bitcoin network: transactions vs the same weekday a week before; hash rate as a 7-day average vs the week before", w.bitcoin_network.state === "on" && w.bitcoin_network.transactions === 313000 && Math.abs(w.bitcoin_network.transactions_change_7d - (313000 / 306000 - 1)) < 1e-9 && w.bitcoin_network.hash_rate_avg7_th_s === 110e6 && Math.abs(w.bitcoin_network.hash_rate_avg7_change - (110 / 103 - 1)) < 1e-9, w.bitcoin_network);
check("window_time: every window says when it came out, its value status and its AS OF lag", Object.keys(w).every((k) => { const t = r.body.window_time[k]; return t && t.publication && ["as_published", "current", "revised"].includes(t.value_status) && Number.isInteger(t.as_of_lag); }) && r.body.window_time.weather);
check("the four times are a template: a window lists only the ones it has (APOD has no 'happened', HN no separate 'seen', earthquakes all four)", !("event" in r.body.window_time.apod) && !("observation" in r.body.window_time.hacker_news) && ["event", "observation", "publication", "revision"].every((f) => r.body.window_time.earthquakes[f]));
check("no weather unless a place is given", !("weather" in w));
check("the settled, complete day is archived with no expiry", env.RE_CACHE.m.has(KEY("2020-03-12")) && !("expirationTtl" in env.RE_CACHE.opts.get(KEY("2020-03-12"))));
r = await get("/scene?day=2020-03-12");
check("second time comes from the archive, still with window_time", r.how === "archive" && r.body.windows.apod.title === "Falcon 9 Boostback" && r.body.window_time.wikipedia_en.as_of_lag === 2);
const stored = env.RE_CACHE.m.get(KEY("2020-03-12"));
check("window_time is added on the way out, not stored (it can change without re-reading the windows)", !("window_time" in JSON.parse(stored)));
r = await get("/scene?day=2020-03-12&lat=35.68&lon=139.69&place=Tokyo<script>");
check("weather at a given place (name cleaned), next to the stored windows", r.how === "archive" && r.body.windows.weather.state === "on" && r.body.windows.weather.place === "Tokyoscript" && r.body.windows.weather.weather === "rain" && r.body.windows.weather.temp_max_c === 14.2, r.body.windows.weather);
check("…and the stored day is not changed by the weather", env.RE_CACHE.m.get(KEY("2020-03-12")) === stored);
r = await get("/scene?day=2020-03-12&lat=135&lon=10");
check("a place outside the globe → 400", r.status === 400);

r = await get("/scene?day=2014-01-01");
check("before 2015-07-01: Wikipedia is ABSENT with the reason", r.body.windows.wikipedia_en.state === "absent" && /2015-07-01/.test(r.body.windows.wikipedia_en.reason));
r = await get("/scene?day=1990-06-01");
const o = r.body.windows;
check("1990: only earthquakes are open; each closed window says when it opens", o.earthquakes.state === "on" && o.apod.state === "absent" && o.fx.state === "absent" && o.hacker_news.state === "absent" && /2009-01-03/.test(o.bitcoin_network.reason), [o.apod.reason, o.fx.reason, o.hacker_news.reason, o.bitcoin_network.reason]);
r = await get("/scene?day=2020-03-07");
check("fx on a Saturday: says which day's rate it is", /2020-03-06/.test(r.body.windows.fx.note), r.body.windows.fx.note);

flags.hnHangs = true;
const t0 = performance.now();
r = await get("/scene?day=2019-05-01");
flags.hnHangs = false;
check("a silent window becomes ABSENT with a reason (not 0), within ~8 s", r.body.windows.hacker_news.state === "absent" && /8 s/.test(r.body.windows.hacker_news.reason) && performance.now() - t0 < 9500, r.body.windows.hacker_news);
check("…and that incomplete day is kept for 1 hour only", env.RE_CACHE.opts.get(KEY("2019-05-01")).expirationTtl === 3600);
r = await get("/scene?day=2026-09-25");
check("yesterday: Wikipedia and the chain not published yet → ABSENT; kept 1 hour", r.body.windows.wikipedia_en.state === "absent" && /not published yet/.test(r.body.windows.wikipedia_en.reason) && r.body.windows.bitcoin_network.state === "absent" && /not published yet/.test(r.body.windows.bitcoin_network.reason) && env.RE_CACHE.opts.get(KEY("2026-09-25")).expirationTtl === 3600, r.body.windows.bitcoin_network);
flags.chainGap = "2018-02-10";
r = await get("/scene?day=2018-02-10");
check("a day the chart skips: ABSENT with that reason, and the day still counts as complete", r.body.windows.bitcoin_network.state === "absent" && /no value for this day/.test(r.body.windows.bitcoin_network.reason) && !("expirationTtl" in env.RE_CACHE.opts.get(KEY("2018-02-10"))), r.body.windows.bitcoin_network);
flags.chainGap = null; flags.chainDown = true;
r = await get("/scene?day=2018-02-11");
check("chain down: ABSENT with the reason, kept 1 hour", r.body.windows.bitcoin_network.state === "absent" && /could not be read/.test(r.body.windows.bitcoin_network.reason) && env.RE_CACHE.opts.get(KEY("2018-02-11")).expirationTtl === 3600, r.body.windows.bitcoin_network);
flags.chainDown = false;

/* ── when was yesterday published? (cron log) ── */
const { readFileSync, writeFileSync, unlinkSync } = await import("node:fs");
const tmp = new URL("./.pub-internals.mjs", import.meta.url);
writeFileSync(tmp, readFileSync(new URL("../src/worker.js", import.meta.url), "utf8") + "\nexport { observePublication, analyzePublication, PUB_KEY };\n");
const P = await import(tmp.href);
unlinkSync(tmp);
const penv = { RE_CACHE: new KV() };
let writes = 0;
const put0 = penv.RE_CACHE.put.bind(penv.RE_CACHE);
penv.RE_CACHE.put = async (...a) => { writes++; return put0(...a); };
// 2026-09-26 00:05 → wiki top for 09-25 not out (mock: > NOW−2d is 404) … we move the mock's "now" by moving the day instead
let t = Date.parse("2026-09-25T00:05:00Z"); // yesterday = 09-24: the chain has it, Wikipedia (mock) has it too
let res1 = await P.observePublication(penv, t);
check("first look at a new day: records what is already out, one write", res1.day === "2026-09-24" && res1.newly_seen.length === 4 && writes === 1, res1);
let res2 = await P.observePublication(penv, t + 30 * 60000);
check("nothing left to look for: no calls, no write", res2.checked.length === 0 && writes === 1, res2);
t = Date.parse("2026-09-26T00:05:00Z"); // yesterday = 09-25: nothing out yet
res1 = await P.observePublication(penv, t);
check("a new day with nothing out yet: first_checked is written once", res1.newly_seen.length === 0 && writes === 2, res1);
res2 = await P.observePublication(penv, t + 30 * 60000);
check("still nothing: no write", writes === 2);
const a = P.analyzePublication(JSON.parse(penv.RE_CACHE.m.get(P.PUB_KEY)));
check("the report: minutes after the day ended, per source", a.days[0].day === "2026-09-25" && a.days[0].seen.wikipedia_top.first_seen === null && a.days[1].seen.bitcoin_network.minutes_after_day_end === 5 && a.days[1].first_checked_minutes_after_day_end === 5, a.days[1]);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
