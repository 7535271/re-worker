// Offline test for the window probes (/probe/wiki, /probe/wiki-top, /probe/gdelt) with a simulated Wikimedia and GDELT.
import worker from "../src/worker.js";

const DAY = 86400000;
const ymd = (t) => new Date(t).toISOString().slice(0, 10);
const NOW = Date.parse("2026-09-26T13:40:00Z");
Date.now = () => NOW;
let failures = 0;
const check = (label, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); if (!cond) failures++; };
const seen = [];

const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "cache-control": "s-maxage=86400" } });
const notFound = () => json({ type: "https://mediawiki.org/wiki/HyperSwitch/errors/not_found", title: "Not found.", method: "get", detail: "The date(s) you used are valid, but we either do not have data for those date(s), or the project you asked for is not loaded yet." }, 404);

globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  seen.push({ host: u.host, path: decodeURIComponent(u.pathname), ua: init && init.headers && init.headers["User-Agent"] });
  if (u.host === "wikimedia.org") {
    const parts = decodeURIComponent(u.pathname).split("/").filter(Boolean); // api rest_v1 metrics pageviews <kind> ...
    const kind = parts[4];
    if (kind === "per-article" || kind === "aggregate") {
      const [start, end] = parts.slice(-2);
      const s = Math.max(Date.parse(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`), Date.parse("2015-07-01"));
      const e = Math.min(Date.parse(`${end.slice(0, 4)}-${end.slice(4, 6)}-${end.slice(6, 8)}`), NOW - 2 * DAY);
      const items = [];
      for (let t = s; t <= e; t += DAY) {
        if (ymd(t) === "2016-01-02") continue; // one missing day
        items.push({ project: parts[5], article: kind === "per-article" ? parts[8] : undefined, granularity: "daily", timestamp: ymd(t).replace(/-/g, "") + "00", access: "all-access", agent: kind === "per-article" ? parts[7] : parts[7], views: Math.round(5000 + 3000 * Math.sin(t / DAY / 30)) });
      }
      return items.length ? json({ items }) : notFound();
    }
    if (kind === "top" || kind === "top-per-country") {
      const [y, m, d] = parts.slice(-3);
      const day = `${y}-${m}-${d}`;
      if (day < "2015-07-01" || Date.parse(day) > NOW - 2 * DAY) return notFound();
      if (kind === "top-per-country" && day < "2021-01-01") return notFound();
      const articles = Array.from({ length: kind === "top" ? 1000 : 1000 }, (_, i) => kind === "top"
        ? { article: i === 0 ? "Main_Page" : i === 1 ? "Special:Search" : `Article_${i}`, views: 1e6 / (i + 1), rank: i + 1 }
        : { article: `記事_${i}`, project: "ja.wikipedia", views_ceil: 1e5 / (i + 1), rank: i + 1 });
      return json({ items: [{ project: parts[5], access: "all-access", year: y, month: m, day: d, articles }] });
    }
  }
  if (u.host === "api.gdeltproject.org") {
    const sp = u.searchParams;
    if (globalThis.GDELT_HANGS) return new Promise((_, reject) => { init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))); });
    const start = sp.get("startdatetime");
    if (start && start < "20170101000000") return new Response("The specified date range is outside of the supported range.", { status: 200, headers: { "content-type": "text/html" } });
    if (sp.get("timespan") === "7d") return new Response("Please limit requests to one every 5 seconds.", { status: 429 });
    const from = start ? Date.parse(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`) : NOW - 7 * DAY;
    const data = Array.from({ length: 31 }, (_, i) => ({ date: new Date(from + i * DAY).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z", value: 100 + i, norm: 90000 }));
    return json({ query_details: { title: "bitcoin" }, timeline: [{ series: "Article Count", data }] });
  }

  if (u.host === "archive-api.open-meteo.com") {
    const sp = u.searchParams, s0 = sp.get("start_date"), e0 = sp.get("end_date");
    if (s0 < "1940-01-01") return json({ error: true, reason: "Parameter 'start_date' is out of allowed range from 1940-01-01 to 2026-09-26" }, 400);
    const time = [];
    for (let t = Date.parse(s0); t <= Date.parse(e0); t += DAY) time.push(ymd(t));
    const late = (i) => Date.parse(time[i]) > NOW - 6 * DAY;
    const col = (f) => time.map((_, i) => (late(i) ? null : f(i)));
    return json({ latitude: 35.7, longitude: 139.7, timezone: "UTC", utc_offset_seconds: 0, daily_units: { time: "iso8601", temperature_2m_max: "°C" },
      daily: { time, temperature_2m_max: col((i) => 15 + i % 5), temperature_2m_min: col(() => 5), precipitation_sum: col(() => 0), wind_speed_10m_max: col(() => 12), weather_code: col(() => 3) } });
  }
  if (u.host === "earthquake.usgs.gov") {
    if (u.pathname.endsWith("/count")) return json({ count: 38, maxAllowed: 20000 });
    return json({ type: "FeatureCollection", metadata: { generated: NOW, count: 2 }, features: [
      { properties: { mag: 6.1, place: "somewhere", time: Date.parse("2020-03-12T10:00:00Z"), updated: Date.parse("2022-01-01T00:00:00Z"), status: "reviewed", type: "earthquake" } },
      { properties: { mag: 5.0, place: "elsewhere", time: Date.parse("2020-03-12T02:00:00Z"), updated: Date.parse("2020-03-13T00:00:00Z"), status: "reviewed", type: "earthquake" } }] });
  }
  if (u.host === "api.frankfurter.dev") {
    if (u.pathname.endsWith("/latest")) return json({ amount: 1, base: "USD", date: "2026-09-25", rates: { EUR: 0.9, JPY: 150 } });
    return json({ amount: 1, base: "USD", start_date: "2020-03-06", end_date: "2020-03-12", rates: { "2020-03-06": { JPY: 105 }, "2020-03-09": { JPY: 102 }, "2020-03-10": { JPY: 104 } } });
  }
  if (u.host === "api.frankfurter.app") return new Response("Moved", { status: 301 });
  if (u.host === "api.blockchain.info") {
    const values = Array.from({ length: 100 }, (_, i) => ({ x: 1231459200 + i * 86400, y: i }));
    return json({ status: "ok", name: "Confirmed Transactions Per Day", unit: "Transactions", period: "day", description: "The total number of confirmed transactions per day.", values });
  }
  if (u.host === "api.nasa.gov") {
    const d = u.searchParams.get("date");
    if (d === "1995-06-15") return new Response(JSON.stringify({ code: 400, msg: "Date must be between Jun 16, 1995 and Sep 26, 2026.", service_version: "v1" }), { status: 400, headers: { "x-ratelimit-remaining": "27" } });
    return new Response(JSON.stringify({ date: d || "2026-09-26", title: "A picture", media_type: "image", copyright: "Someone", url: "https://apod.nasa.gov/x.jpg", hdurl: "https://apod.nasa.gov/x_hd.jpg", explanation: "Stars." }), { status: 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "28" } });
  }
  if (u.host === "hn.algolia.com") return json({ nbHits: 1234, hits: [{ title: "Story", points: 999, num_comments: 300, created_at: "2020-03-12T15:00:00Z", url: "https://example.com/a" }] });
  return new Response("unexpected", { status: 500 });
};

const env = {}; // no CMC key, no KV: these probes must not need them
async function get(path) { const r = await worker.fetch(new Request("https://x" + path), env); return { status: r.status, body: await r.json() }; }

let a = process.cpuUsage();
let r = await get("/probe/wiki");
let cpu = process.cpuUsage(a);
const s = r.body._summary;
check("wiki: works without CMC key or KV", r.status === 200);
check("wiki: series starts where the data starts (asked from 2015-06-01)", s.bitcoin_en.first === "2015-07-01", s.bitcoin_en.first);
check("wiki: the missing day is listed", s.bitcoin_en.missing_days.count === 1 && s.bitcoin_en.missing_days.items[0] === "2016-01-02", s.bitcoin_en.missing_days);
check("wiki: publication delay is measured", s.bitcoin_en.newest_is_days_before_today === 2, s.bitcoin_en.newest_is_days_before_today);
check("wiki: Japanese title is URL-encoded and reached", seen.some((x) => x.path.includes("ビットコイン")) && s.bitcoin_ja_2020_03.items === 31);
check("wiki: a User-Agent is sent", seen.every((x) => (x.ua || "").startsWith("RE-TemporalPlayground")));
console.log(`  /probe/wiki CPU in Node ≈ ${((cpu.user + cpu.system) / 1000).toFixed(1)} ms (incl. the simulator), response ${JSON.stringify(r.body).length} bytes`);

a = process.cpuUsage();
r = await get("/probe/wiki-top");
cpu = process.cpuUsage(a);
const t = r.body._summary;
check("wiki-top: 1000 articles on 2020-03-12, top 15 shown", t.en_2020_03_12.articles === 1000 && t.en_2020_03_12.top.length === 15, t.en_2020_03_12.top.slice(0, 2));
check("wiki-top: 2015-06-30 → not found (with the reason)", t.en_2015_06_30.articles === 0 && t.en_2015_06_30.error && t.en_2015_06_30.error.title === "Not found.", t.en_2015_06_30);
check("wiki-top: newest list found (2 days late here)", t.newest_top_list === ymd(NOW - 2 * DAY), t.newest_top_list);
check("wiki-top: per-country list uses views_ceil", t.country_JP_2024_01_01.top[0].views > 0 && t.country_JP_2024_01_01.top[0].project === "ja.wikipedia", t.country_JP_2024_01_01.top[0]);
console.log(`  /probe/wiki-top CPU in Node ≈ ${((cpu.user + cpu.system) / 1000).toFixed(1)} ms (incl. the simulator), response ${JSON.stringify(r.body).length} bytes`);

const t0 = performance.now();
r = await get("/probe/gdelt");
const g = r.body._summary;
check("gdelt: calls are spaced ≥ 5 s apart", performance.now() - t0 >= 16000, Math.round(performance.now() - t0));
check("gdelt: a text answer (not JSON) is kept as text", g.before_2017.points === 0 && /outside/.test(g.before_2017.text), g.before_2017);
check("gdelt: a JSON timeline is summarized", g["2020_03"].series[0].points === 31 && g["2020_03"].series[0].step_minutes === 1440, g["2020_03"].series[0]);
check("gdelt: a 429 is recorded as an observation", g.last_7_days.http_status === 429 && /5 seconds/.test(g.last_7_days.text), g.last_7_days);


r = await get("/probe/gdelt?only=2020_03");
check("gdelt ?only: one call, no waiting", r.body.calls.length === 1 && r.body._summary["2020_03"].series[0].points === 31);

globalThis.GDELT_HANGS = true;
const th = performance.now();
r = await get("/probe/gdelt?only=2020_03");
globalThis.GDELT_HANGS = false;
check("gdelt: a silent server is cut at 12 s and recorded", r.body._summary["2020_03"].http_status === -1 && /timed out/.test(r.body._summary["2020_03"].text) && performance.now() - th < 13500, r.body._summary["2020_03"]);

r = await get("/probe/weather");
let w = r.body._summary;
check("weather: before 1940 → the API's own reason is kept", w.before_1940.http_status === 400 && /1940-01-01/.test(JSON.stringify(w.before_1940.error)), w.before_1940);
check("weather: the late days show up as nulls with last_with_value", w.last_14_days.variables.temperature_2m_max.nulls > 0 && w.last_14_days.variables.temperature_2m_max.last_with_value < ymd(NOW), w.last_14_days.variables.temperature_2m_max);
check("weather: 2013→today in one call", w.from_2013_to_today.days > 4800, w.from_2013_to_today.days);

r = await get("/probe/quakes");
let q = r.body._summary;
check("quakes: count and events (with updated time) summarized", q.count_2020_03_12.count === 38 && q.biggest_2020_03_12.events[0].updated === "2022-01-01T00:00:00.000Z", q.biggest_2020_03_12.events[0]);

r = await get("/probe/fx");
let f = r.body._summary;
check("fx: weekend gap visible in days_listed", JSON.stringify(f.d_2020_03_06_to_12.days_listed) === JSON.stringify(["2020-03-06", "2020-03-09", "2020-03-10"]));
check("fx: latest date and old-domain redirect recorded", f.latest.date === "2026-09-25" && f.latest_old_domain.http_status === 301, f.latest_old_domain);

r = await get("/probe/chain");
let c = r.body._summary;
check("chain: first day, daily steps, all at 00:00 UTC", c.n_transactions_all.first === "2009-01-09T00:00:00.000Z" && c.n_transactions_all.step_days["1"] === 99 && c.n_transactions_all.not_at_00_00_utc === 0, c.n_transactions_all.first);

r = await get("/probe/apod");
let ap = r.body._summary;
check("apod: copyright field and the error before the first day", ap.d_2020_03_12.copyright === "Someone" && /Jun 16, 1995/.test(JSON.stringify(ap.before_1995_06_15.error)), ap.before_1995_06_15);
check("apod: DEMO_KEY remaining calls recorded", ap.d_2020_03_12.rate_limit_remaining === "28");

r = await get("/probe/hn");
check("hn: hits summarized with site", r.body._summary.top_2020_03_12.hits[0].site === "example.com");

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
