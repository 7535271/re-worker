// Serve public/ + the worker (on the simulated archive) and screenshot the app at iPhone size.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { clock, KV, runCron } from "./mock.js";
import worker from "../src/worker.js";

const OUT = process.argv[2] || "/tmp/re-shots3";
const PUB = new URL("../public/", import.meta.url).pathname;
const env = { CMC_KEY: "k", RE_CACHE: new KV() };
clock.now = Date.parse("2026-09-24T18:00:00Z");
for (let i = 0; i < 12 * 7; i++) { await runCron(worker, env); clock.now += 5 * 60000; }

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css" };
/* /scene: a canned reply shaped like the real one (the real windows are not reachable from here) */
const { readFileSync } = await import("node:fs");
const wsrc = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const WT = new Function(wsrc.slice(wsrc.indexOf("const WINDOW_TIME = {"), wsrc.indexOf("};", wsrc.indexOf("const WINDOW_TIME = {")) + 2) + " return WINDOW_TIME;")();
function fakeScene(day, place) {
  const pre = (from) => day < from ? { state: "absent", reason: `this window opens on ${from}` } : null;
  const wiki = (lang, names) => pre("2015-07-01") || { state: "on", items: names.map((t, i) => ({ title: t, views: 1980000 - i * 211000, url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(t)}` })) };
  return { day, windows: {
    wikipedia_en: wiki("en", ["2019–20 coronavirus pandemic", "Tom Hanks", "United States Senate", "Rita Wilson", "Coronavirus disease 2019"]),
    wikipedia_ja: wiki("ja", ["新型コロナウイルス感染症 (2019年)", "トム・ハンクス", "パンデミック"]),
    hacker_news: pre("2006-10-09") || { state: "on", items: [{ title: "U.S. will suspend all travel from Europe for 30 days", points: 920, url: "https://example.com/a" }, { title: "The NBA has suspended its season", points: 612, url: "https://example.com/b" }, { title: "A very long story title that goes on and on to check how wrapping behaves on a narrow iPhone screen", points: 48, url: "javascript:alert(1)" }] },
    apod: pre("1995-06-16") || { state: "on", title: "Falcon 9 Boostback", credit: "Image Credit & Copyright: John Kraus", page_url: "https://apod.nasa.gov/apod/ap200312.html" },
    earthquakes: { state: "on", count_m45: 18, biggest: [{ mag: 5.5, place: "127 km ESE of Neiafu, Tonga" }], revised_later: true },
    fx: pre("1999-01-04") || { state: "on", rate_date: day, usd_jpy: 104.5, usd_eur: 0.8849, note: null },
    bitcoin_network: day < "2009-01-03" ? { state: "absent", reason: "this window opens on 2009-01-03" } : { state: "on", transactions: 311520 + (day.charCodeAt(9) % 7) * 4100, transactions_change_7d: 0.041, hash_rate_avg7_th_s: 114.6e6, hash_rate_avg7_change: -0.02 },
    ...(place ? { weather: { state: "on", place, temp_min_c: 6.1, temp_max_c: 14.2, precipitation_mm: 0.4, wind_max_kmh: 18.3, weather: "rain" } } : {}),
    x: { state: "door", url: `https://x.com/search?q=${encodeURIComponent(`bitcoin since:${day}`)}` },
  }, window_time: WT };
}
/* /window-series: synthetic but shaped like the real ones */
function fakeSeries(q) {
  const DAYMS = 86400000, w = q.get("w");
  const days = (from, to) => { const out = []; for (let t = Date.parse(from); t <= Date.parse(to); t += DAYMS) out.push(t); return out; };
  if (w === "attention") return { w, as_of_lag: 2, from: "2015-07-01", values: days("2015-07-01", "2026-09-24").map((t, i) => Math.round(6000 + 4000 * Math.sin(i / 90) + (i % 17) * 120)) };
  if (w === "tx" || w === "hash") return { w, as_of_lag: 2, from: "2012-04-01", values: days("2012-04-01", "2026-09-24").map((t, i) => (w === "tx" ? 30000 + i * 60 + (i % 7) * 4000 : Number((10 * Math.exp(i / 420) * (1 + 0.05 * Math.sin(i))).toPrecision(5)))) };
  if (w === "wikitotal") return { w, as_of_lag: 2, from: "2015-07-01", values: days("2015-07-01", "2026-09-24").map((t, i) => 2.5e8 + (i % 7) * 4e6 + (new Date(t).toISOString().startsWith("2020-03-1") ? 9e7 : 0)) };
  if (w === "nasdaq" || w === "vix" || w === "usd") return { w, as_of_lag: 1, from: "2012-04-01", values: days("2012-04-01", "2026-09-24").map((t, i) => {
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) return null;
    const hit = ["2020-03-12", "2018-02-05", "2022-06-13"].includes(new Date(t).toISOString().slice(0, 10));
    return w === "vix" ? 18 + (i % 5) + (hit ? 40 : 0) : w === "usd" ? 110 + Math.sin(i / 50) : 5000 + i * 2 + (i % 3) * 5 - (hit ? 600 : 0);
  }) };
  const lat = Number(q.get("lat"));
  const ts = days("2012-04-01", "2026-09-24");
  const season = (t) => Math.cos(((new Date(t).getUTCMonth() + 0.5) / 12) * 2 * Math.PI) * (lat >= 0 ? -1 : 1);
  return { w, as_of_lag: 2, from: "2012-04-01", place: q.get("place"), tmax: ts.map((t, i) => 17 + 10 * season(t) + (i % 5)), tmin: ts.map((t, i) => 9 + 9 * season(t) + (i % 3)), precip: ts.map((t, i) => (i % 4 === 0 ? (i % 11) * 1.3 : 0)), code: ts.map((t, i) => [0, 2, 3, 61, 63, 71][i % 6]) };
}
/* /moments: canned, shaped like the real one */
const MOMENTS = {
  pandemic: { q: "pandemic", article: { title: "Pandemic", url: "https://en.wikipedia.org/wiki/Pandemic" }, moments: [
    { day: "2016-02-01", score: 0.4, wiki: { views: 16000, usual: 3150, times: 5.1 }, hn: null },
    { day: "2020-03-11", score: 1.25, wiki: { views: 118000, usual: 3150, times: 37.5 }, hn: { title: "Covid-19 is now officially a pandemic, WHO says", points: 1243, url: "https://example.com/who", hn_url: "https://news.ycombinator.com/item?id=22547283" } },
    { day: "2021-04-29", score: 0.58, wiki: null, hn: { title: "Flu has disappeared worldwide during the Covid pandemic", points: 726, url: "https://example.com/flu", hn_url: "https://news.ycombinator.com/item?id=26982681" } },
    { day: "2023-02-26", score: 0.79, wiki: null, hn: { title: "Lab leak most likely origin of Covid-19 pandemic, U.S. agency now says", points: 983, url: "https://example.com/lab", hn_url: "https://news.ycombinator.com/item?id=34945078" } },
  ], how: "Found with today's records.", notes: [] },
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/talk") {
    const day = url.searchParams.get("day");
    const counts = Array.from({ length: 38 }, (_, i) => (i === 7 ? 14 : i === 9 ? 6 : 2 + (i % 3)));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ q: url.searchParams.get("q"), day, counts }));
    return;
  }
  if (url.pathname === "/moments") {
    await new Promise((r) => setTimeout(r, 250));
    const q = (url.searchParams.get("q") || "").toLowerCase();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(MOMENTS[q] || { q, article: null, moments: [], notes: ["no English Wikipedia article for this word"] }));
    return;
  }
  if (url.pathname === "/window-series") {
    await new Promise((r) => setTimeout(r, 200));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fakeSeries(url.searchParams)));
    return;
  }
  if (url.pathname === "/scene") {
    await new Promise((r) => setTimeout(r, 300));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(fakeScene(url.searchParams.get("day"), url.searchParams.get("place"))));
    return;
  }
  if (/^\/(series|archive|probe|state|api)/.test(url.pathname)) {
    const r = await worker.fetch(new Request("http://localhost" + req.url), env);
    res.writeHead(r.status, Object.fromEntries(r.headers));
    res.end(Buffer.from(await r.arrayBuffer()));
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  try {
    const body = await readFile(join(PUB, file));
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise((r) => server.listen(8787, r));

const { createRequire } = await import("node:module");
const { chromium } = createRequire(import.meta.url)("/home/claude/.npm-global/lib/node_modules/playwright");
let browser;
try { browser = await chromium.launch(); } catch { browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" }); }
const errors = [];
const widths = {};
const { mkdirSync } = await import("node:fs");
mkdirSync(OUT, { recursive: true });
async function phone(dark = false) {
  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, colorScheme: dark ? "dark" : "light" });
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(e.message + " @ " + (e.stack || "").split("\n").slice(0, 3).join(" / ")));
  return { ctx, page };
}
const W = (page) => page.evaluate(() => document.documentElement.scrollWidth);
const tilesReady = (page, id) => page.waitForFunction((id) => { const t = document.querySelectorAll(`#${id} .tile .tt, #${id} .tile .two em`); return t.length >= 9 && [...t].every((x) => x.textContent !== "…"); }, id, { timeout: 15000 });


const tiles9 = (page, id) => page.waitForFunction((id) => { const t = document.querySelectorAll(`#${id} .tile .tt, #${id} .tile .two em`); return t.length >= 9 && [...t].every((x) => x.textContent !== "…"); }, id, { timeout: 15000 });
const info = {};
const txt = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.innerText.replace(/\s+/g, " ").trim() : null; }, sel);
const placesReady = (page) => page.waitForFunction(() => { const b = document.querySelector("#s-places"); return b && b.children.length && !b.innerText.includes("Still looking"); }, null, { timeout: 20000 });
{
  const { ctx, page } = await phone();
  // 1. the start: three doors
  await page.goto("http://localhost:8787/");
  await page.waitForSelector("#coins .coin", { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/w1-home.png` });
  info.home = await txt(page, "#v-home");
  // 2. any day → the newest day, its places
  await page.click("#pick-day");
  await placesReady(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/w2-latest.png` });
  info.latest = [await page.evaluate(() => location.hash), await txt(page, "#s-places"), await txt(page, "#s-places-note")];
  await page.click("#latest");
  await placesReady(page);
  info.today = await page.evaluate(() => location.hash);
  // 2b. a random day, from the day and from the start
  await page.click("#random");
  await placesReady(page);
  info.random1 = await page.evaluate(() => location.hash);
  await page.goBack();
  await page.waitForTimeout(400);
  info.random_back = await page.evaluate(() => location.hash);
  // 3. a day with a past and a future
  await page.goto("http://localhost:8787/#d=2020-03-12&v=stand");
  await placesReady(page);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/w3-day.png` });
  await page.screenshot({ path: `${OUT}/w3-day-full.png`, fullPage: true });
  info.places = await page.$$eval("#s-places > *", (r) => r.map((x) => x.innerText.replace(/\s+/g, " ")));
  info.places_note = await txt(page, "#s-places-note");
  // 4. a place found by the same windows
  const sel = (await page.$("#s-places .row.place:has(.k-p)")) ? "#s-places .row.place:has(.k-p) >> nth=0" : "#s-places .row.place >> nth=0";
  await page.click(sel);
  await tiles9(page, "p-tiles");
  await page.waitForFunction(() => !document.querySelector("#p-lens").innerText.includes("looking at every window"), null, { timeout: 15000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/w4-pair.png` });
  info.pair = [await page.evaluate(() => location.hash), await txt(page, "#p-title"), await txt(page, "#p-sub"), await txt(page, "#p-what")];
  info.lens = await page.$$eval("#p-lens .lr", (r) => r.map((x) => x.innerText.replace(/\s+/g, " ")));
  await page.click("#p-why summary");
  await page.waitForTimeout(300);
  await page.locator("#p-why").screenshot({ path: `${OUT}/w4-why.png` });
  info.why = (await txt(page, "#p-why")).slice(0, 600);
  await page.locator("#next-body").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${OUT}/w4-next.png` });
  info.hidden = await txt(page, "#p-hidden");
  info.tiles = await page.$$eval("#p-tiles .tile .tn", (t) => t.map((x) => x.innerText.replace(/\s+/g, " ")).join(" | "));
  await page.screenshot({ path: `${OUT}/w4-pair-full.png`, fullPage: true });
  // 5. step through the places
  const before = await page.evaluate(() => location.hash);
  if (!(await page.$eval("#p-next", (b) => b.disabled))) { await page.click("#p-next"); await tiles9(page, "p-tiles"); }
  info.stepped = [before, await page.evaluate(() => location.hash), await txt(page, "#p-sub")];
  // 6. explore that day
  await page.click("#stand");
  await tiles9(page, "s-tiles");
  await page.waitForTimeout(600);
  info.explore = [await page.evaluate(() => location.hash), await page.evaluate(() => [document.querySelector("#s-explore").hidden, document.querySelector("#s-explore-link").hidden])];
  // 6b. the Observatory, from the day
  await page.click("#how-link2");
  await page.waitForTimeout(800);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/w6-observatory.png`, fullPage: true });
  info.observatory = await page.evaluate(() => [location.hash, document.querySelector("#v-how").hidden, !!document.querySelector("#v-home #how-link"), document.querySelector("#times").innerText.slice(0, 120)]);
  await page.goBack();
  await page.waitForTimeout(500);
  // 7. the mark: a clean start
  await page.click("#mark");
  await page.waitForTimeout(500);
  info.mark = [await page.evaluate(() => location.hash), await page.evaluate(() => document.querySelector("#v-home").hidden)];
  info.width = await W(page);
  await ctx.close();
}
{
  // 8. from the world, in dark
  const { ctx, page } = await phone(true);
  await page.goto("http://localhost:8787/#q=pandemic");
  await page.waitForSelector("#w-rows .row", { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/w8-world.png` });
  await page.click("#w-rows .row >> nth=0");
  await placesReady(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/w8-day.png` });
  info.world_places = await page.$$eval("#s-places > *", (r) => r.map((x) => x.innerText.replace(/\s+/g, " ")));
  const wsel = (await page.$("#s-places .row.place:has(.k-w)")) ? "#s-places .row.place:has(.k-w) >> nth=0" : "#s-places .row.place >> nth=0";
  await page.click(wsel);
  await tiles9(page, "p-tiles");
  await page.waitForFunction(() => !document.querySelector("#p-lens").innerText.includes("looking at every window"), null, { timeout: 15000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/w8-pair.png` });
  info.world_pair = [await page.evaluate(() => location.hash), await txt(page, "#p-sub"), await txt(page, "#p-what")];
  info.world_lens = await page.$$eval("#p-lens .lr", (r) => r.map((x) => x.innerText.replace(/\s+/g, " ")));
  // a shared link straight to a pair still opens
  await page.goto("http://localhost:8787/#d=2020-03-12&p=2018-02-06&v=past");
  await page.waitForTimeout(2500);
  info.shared = await page.evaluate(() => [location.hash, document.querySelector("#v-past").hidden, document.querySelector("#v-stand").hidden]);
  await ctx.close();
}
console.log(JSON.stringify(info, null, 1));
console.log("errors:", errors.length ? errors : "none");
await browser.close();
server.close();
