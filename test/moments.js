// Offline test for /moments?q= (the world entrance) and the per-asset Attention series, with simulated Wikipedia and Hacker News.
import worker from "../src/worker.js";

const NOW = Date.parse("2026-09-27T09:00:00Z");
Date.now = () => NOW;
let failures = 0;
const check = (label, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); if (!cond) failures++; };
const DAY = 86400000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
const sec = (d) => Date.parse(d + "T12:00:00Z") / 1000;

/* a Wikipedia article read ~3,000 times a day, with spikes on a few days */
function articleItems(spikes) {
  const items = [];
  for (let t = Date.parse("2015-07-01"); t <= Date.parse("2026-09-25"); t += DAY) {
    const d = ymd(t);
    items.push({ timestamp: d.replace(/-/g, "") + "00", views: spikes[d] ?? 3000 + ((t / DAY) % 7) * 50 });
  }
  return items;
}
const ARTICLES = {
  Pandemic: articleItems({ "2020-03-12": 118000, "2020-03-13": 90000, "2020-03-16": 70000, "2016-02-01": 16000, "2021-01-05": 9000 }),
  Ethereum: articleItems({}),
  Bitcoin: articleItems({}),
};
const HN_HITS = {
  pandemic: [
    { title: "Covid-19 is now officially a pandemic, WHO says", points: 1243, created_at_i: sec("2020-03-11"), objectID: "22547283", url: "https://example.com/who" },
    { title: "Pandemic Ventilator Project", points: 318, created_at_i: sec("2020-03-14"), objectID: "22573188", url: "https://example.com/vent" },
    { title: "Lab leak most likely origin of Covid-19 pandemic, U.S. agency now says", points: 983, created_at_i: sec("2023-02-26"), objectID: "34945078", url: "https://example.com/lab" },
    { title: "Flu has disappeared worldwide during the Covid pandemic", points: 726, created_at_i: sec("2021-04-29"), objectID: "26982681" },
    { title: "Smaller pandemic story the same day", points: 150, created_at_i: sec("2021-04-29"), objectID: "1" },
    { title: "Florida DMV sells personal info to private companies", points: 3000, created_at_i: sec("2019-07-15"), objectID: "2" },
    { title: "Pandemics, a history", points: 120, created_at_i: sec("2018-05-01"), objectID: "3" },
  ],
};
for (let i = 0; i < 14; i++) HN_HITS.many = (HN_HITS.many || []).concat([{ title: `many story ${i}`, points: 200 + i * 10, created_at_i: sec(ymd(Date.parse("2014-01-01") + i * 60 * DAY)), objectID: String(100 + i) }]);
const flags = { hnDown: false, wikiDown: false };
const seen = [];

globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  seen.push(u);
  if (u.host === "en.wikipedia.org") {
    if (flags.wikiDown) return new Response("down", { status: 503 });
    const q = u.searchParams.get("search");
    const title = q === "pandemic" ? "Pandemic" : q === "many" ? null : q === "ethereum" ? "Ethereum" : null;
    return new Response(JSON.stringify([q, title ? [title] : [], [], title ? [`https://en.wikipedia.org/wiki/${title}`] : []]), { status: 200 });
  }
  if (u.host === "wikimedia.org" && u.pathname.includes("/aggregate/")) {
    return new Response(JSON.stringify({ items: articleItems({ "2020-03-12": 9000 }).map((x) => ({ ...x, views: x.views * 1000 })) }), { status: 200 });
  }
  if (u.host === "fred.stlouisfed.org") {
    const id = u.searchParams.get("id");
    if (id === "DTWEXBGS") return new Response("<html>maintenance</html>", { status: 503 });
    let csv = "observation_date," + id + "\r\n";
    for (let t = Date.parse("2011-01-03"); t <= Date.parse("2026-09-25"); t += DAY) {
      const d = new Date(t);
      const wd = d.getUTCDay();
      const day = ymd(t);
      csv += wd === 0 || wd === 6 ? "" : `${day},${day === "2020-01-01" ? "." : (1000 + (t / DAY) % 500).toFixed(2)}\r\n`;
    }
    return new Response(csv, { status: 200 });
  }
  if (u.host === "hn.algolia.com" && u.pathname.endsWith("/search_by_date")) {
    const [a, b] = u.searchParams.get("numericFilters").match(/\d+/g).map(Number);
    const hits = [];
    for (let s0 = a; s0 < b; s0 += 86400) {
      const n = s0 === sec("2020-03-12") - 43200 ? 12 : 2;
      for (let k = 0; k < n; k++) hits.push({ title: k % 2 ? "Bitcoin falls again" : "Why bitcoins matter", created_at_i: s0 + 3600 * (k + 1) });
      hits.push({ title: "Unrelated story", created_at_i: s0 + 7200 });
    }
    return new Response(JSON.stringify({ hits }), { status: 200 });
  }
  if (u.host === "wikimedia.org") {
    if (flags.wikiDown) return new Response("down", { status: 503 });
    const art = decodeURIComponent(u.pathname.split("/user/")[1].split("/")[0]);
    const items = ARTICLES[art];
    return items ? new Response(JSON.stringify({ items }), { status: 200 }) : new Response(JSON.stringify({ title: "Not found." }), { status: 404 });
  }
  if (u.host === "hn.algolia.com") {
    if (flags.hnDown) return new Response("down", { status: 500 });
    const hits = (HN_HITS[u.searchParams.get("query")] || []).filter((h) => h.points >= 100);
    return new Response(JSON.stringify({ hits, nbHits: hits.length }), { status: 200 });
  }
  return new Response("unexpected", { status: 500 });
};
class KV { constructor() { this.m = new Map(); this.opts = new Map(); } async get(k) { return this.m.get(k) ?? null; } async put(k, v, o) { this.m.set(k, v); this.opts.set(k, o || {}); } }
const get = async (env, path) => {
  const r = await worker.fetch(new Request("https://x" + path), env);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, headers: r.headers };
};

console.log("\n== /moments ==");
{
  const env = { RE_CACHE: new KV() };
  let r = await get(env, "/moments?q=Pandemic");
  check("200", r.status === 200, r.status);
  const m = r.body.moments;
  check("the article is found", r.body.article && r.body.article.title === "Pandemic");
  check("moments are in date order", m.every((x, i) => i === 0 || m[i - 1].day < x.day), m.map((x) => x.day));
  const covid = m.find((x) => x.day === "2020-03-11");
  check("WHO (HN, 03-11) and the Wikipedia peak (03-12) are one moment, on the earlier day", covid && covid.hn && covid.hn.points === 1243 && covid.wiki && covid.wiki.views === 118000, covid);
  check("the 03-13/03-16 highs and the 03-14 story are not separate moments", !m.some((x) => ["2020-03-13", "2020-03-14", "2020-03-16"].includes(x.day)), m.map((x) => x.day));
  check("the 2016 peak is found by Wikipedia alone (16,000 ≥ 4× usual)", m.some((x) => x.day === "2016-02-01" && x.wiki && !x.hn));
  check("a small rise (9,000 = 3× usual) is not a moment", !m.some((x) => x.day === "2021-01-05"));
  const apr = m.find((x) => x.day === "2021-04-29");
  check("two stories on one day: the one with more points", apr && apr.hn.points === 726, apr);
  check("the strongest moment scores 1.25 (both clues at their maximum)", covid.score === 1.25, covid.score);
  check("stories without a link go to the HN page", apr.hn.url === "https://news.ycombinator.com/item?id=26982681");
  check("a story without the word in its title is not a trace (even with the most points)", !m.some((x) => x.day === "2019-07-15"), m.map((x) => x.day));
  check("the plural counts (“Pandemics, a history”)", m.some((x) => x.day === "2018-05-01"));
  const hnUrl = seen.find((u) => u.host === "hn.algolia.com");
  check("HN is asked from 2013 and for 100+ points only", hnUrl && hnUrl.searchParams.get("numericFilters").includes("created_at_i>=1356998400") && hnUrl.searchParams.get("numericFilters").includes("points>=100"));
  check("q is normalized (lower case) and the answer is kept for a day", env.RE_CACHE.m.has("moments:v2:pandemic") && env.RE_CACHE.opts.get("moments:v2:pandemic").expirationTtl === 86400);
  const n = seen.length;
  r = await get(env, "/moments?q=pandemic");
  check("the second ask comes from the archive (no new calls)", r.headers.get("X-RE-Moments") === "archive" && seen.length === n);

  r = await get(env, "/moments?q=many");
  check("no article: Hacker News alone, at most 8 moments", r.status === 200 && r.body.article === null && r.body.moments.length === 8 && r.body.notes.length === 1, { n: r.body.moments.length, notes: r.body.notes });
  check("the 8 are the strongest (the 6 weakest stories are left out)", !r.body.moments.some((x) => x.hn.points < 260), r.body.moments.map((x) => x.hn.points));

  for (const bad of ["", "a", "x".repeat(41), "<script>", "drop;table"]) {
    r = await get(env, "/moments?q=" + encodeURIComponent(bad));
    check(`bad q ${JSON.stringify(bad.slice(0, 12))} → 400`, r.status === 400);
  }
  r = await get(env, "/moments?q=" + encodeURIComponent("パンデミック"));
  check("a Japanese word is accepted (and may find nothing)", r.status === 200 && Array.isArray(r.body.moments));

  flags.hnDown = true;
  const env2 = { RE_CACHE: new KV() };
  r = await get(env2, "/moments?q=pandemic");
  check("HN down: Wikipedia still answers, with a note, kept only an hour", r.status === 200 && r.body.moments.length > 0 && r.body.notes.some((x) => x.includes("Hacker News")) && env2.RE_CACHE.opts.get("moments:v2:pandemic").expirationTtl === 3600, r.body.notes);
  flags.wikiDown = true;
  r = await get({ RE_CACHE: new KV() }, "/moments?q=pandemic");
  check("both down → 502, nothing kept", r.status === 502, r.body);
  flags.hnDown = false; flags.wikiDown = false;
}

console.log("\n== Attention follows the asset ==");
{
  const env = { RE_CACHE: new KV() };
  seen.length = 0;
  let r = await get(env, "/window-series?w=attention&id=1027");
  check("ETH reads the “Ethereum” article", r.status === 200 && seen.some((u) => u.pathname.includes("/user/Ethereum/")) && r.body.article === "Ethereum", r.body.source);
  check("kept apart from Bitcoin's", env.RE_CACHE.m.has("wseries:v1:attention:1027"));
  r = await get(env, "/window-series?w=attention");
  check("no id: Bitcoin, under the old key", r.status === 200 && r.body.article === "Bitcoin" && env.RE_CACHE.m.has("wseries:v1:attention"));
  r = await get(env, "/window-series?w=attention&id=999");
  check("unknown id → 400", r.status === 400);
}

console.log("\n== Moved together? — the new windows ==");
{
  const env = { RE_CACHE: new KV() };
  let r = await get(env, "/window-series?w=wikitotal");
  check("Wikipedia as a whole: one number a day from 2015-07-01", r.status === 200 && r.body.from === "2015-07-01" && r.body.values[0] > 1e6, r.body.source);
  r = await get(env, "/window-series?w=nasdaq");
  const v = r.body.values;
  const at = (d) => v[(Date.parse(d) - Date.parse(r.body.from)) / DAY];
  check("Nasdaq from FRED: starts at 2012-04-01, weekends empty, “.” is empty", r.status === 200 && r.body.from === "2012-04-01" && at("2020-03-14") === null && at("2020-03-13") > 0 && at("2020-01-01") === null, [at("2020-03-13"), at("2020-03-14"), at("2020-01-01")]);
  r = await get(env, "/window-series?w=vix");
  check("VIX too", r.status === 200 && r.body.source.includes("VIXCLS"));
  r = await get(env, "/window-series?w=usd");
  check("FRED down for one series → 502 for that row only", r.status === 502, r.body);
  r = await get(env, "/talk?q=bitcoin&day=2020-03-12");
  const c = r.body.counts;
  check("HN talk: 38 days, from 7 before to 30 after", r.status === 200 && c.length === 38 && r.body.from === "2020-03-05" && r.body.to === "2020-04-11");
  check("… counting only titles with the word (plural too): 2 a day, 12 on the day", c[0] === 2 && c[7] === 12, c.slice(5, 10));
  check("… kept for good once settled", env.RE_CACHE.m.has("talk:v1:bitcoin:2020-03-12") && !env.RE_CACHE.opts.get("talk:v1:bitcoin:2020-03-12").expirationTtl);
  r = await get(env, "/talk?q=bitcoin&day=2026-09-20");
  check("… a recent window is kept an hour", env.RE_CACHE.opts.get("talk:v1:bitcoin:2026-09-20").expirationTtl === 3600);
  r = await get(env, "/talk?q=bitcoin&day=2020-3-12");
  check("bad day → 400", r.status === 400);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
