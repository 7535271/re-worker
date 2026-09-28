// Exhaustive check of the integer date helpers against JavaScript's Date, plus a CPU profile of a year build.
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
const tmp = new URL("./.internals.mjs", import.meta.url);
writeFileSync(tmp, src + "\nexport { dayNum, ymdOf, shiftDay, daysBetween, isDay, dayStart, analyzeFng, pickQuotes, pickOhlcv, axesValues, AXES };\n");
const W = await import(tmp.href);
unlinkSync(tmp); // the copy is only needed for the import

let bad = 0;
const DAY = 86400000;
for (let n = -1000; n <= 47482; n++) { // 1967-04 .. 2100-01
  const want = new Date(n * DAY).toISOString().slice(0, 10);
  if (W.ymdOf(n) !== want || W.dayNum(want) !== n) { if (bad++ < 5) console.log("mismatch", n, W.ymdOf(n), want); }
}
console.log(bad ? `FAIL ymdOf/dayNum: ${bad} mismatches` : "PASS ymdOf/dayNum match Date for every day 1967–2100");
const cases = [["2020-02-29", true], ["2021-02-29", false], ["2020-02-30", false], ["2026-13-01", false], ["2026-00-10", false], ["2026-04-31", false], ["2026-12-31", true], ["20x6-01-01", false], ["", false], [null, false]];
const badDay = cases.filter(([s, ok]) => W.isDay(s) !== ok);
console.log(badDay.length ? "FAIL isDay " + JSON.stringify(badDay) : "PASS isDay rejects impossible dates");
console.log(W.shiftDay("2024-12-31", 1) === "2025-01-01" && W.shiftDay("2024-03-01", -1) === "2024-02-29" && W.daysBetween("2013-04-28", "2026-09-25") === 4898 ? "PASS shiftDay/daysBetween" : "FAIL shiftDay/daysBetween");

// CPU profile with realistic payloads (from the mock)
const { clock } = await import("./mock.mjs");
clock.now = Date.parse("2026-09-25T00:05:00Z");
const H = { "X-CMC_PRO_API_KEY": "k" };
const base = "https://pro-api.coinmarketcap.com";
const qText = await (await fetch(`${base}/v3/cryptocurrency/quotes/historical?id=1&time_start=2023-12-31&time_end=2024-12-31&interval=daily&convert=USD`, { headers: H })).text();
const oText = await (await fetch(`${base}/v2/cryptocurrency/ohlcv/historical?id=1&time_start=2023-12-30&time_end=2024-12-31&interval=daily&convert=USD`, { headers: H })).text();
const fTexts = [];
for (const s of [1, 501, 1001]) fTexts.push(await (await fetch(`${base}/v3/fear-and-greed/historical?start=${s}&limit=500`, { headers: H })).text());
function cpu(fn, n = 300) {
  for (let i = 0; i < 30; i++) fn();
  const a = process.cpuUsage();
  for (let i = 0; i < n; i++) fn();
  const b = process.cpuUsage(a);
  return (b.user + b.system) / 1000 / n;
}
const q = JSON.parse(qText), o = JSON.parse(oText), fr = fTexts.flatMap((t) => JSON.parse(t).data);
const qm = W.pickQuotes(q.data, "1").map, om = W.pickOhlcv(o.data, "1"), fm = W.analyzeFng(fr).pick;
function build() {
  const n0 = W.dayNum("2024-01-01"), n = 366;
  const cols = {}; for (const k of W.AXES) cols[k] = new Array(n);
  for (let i = 0; i < n; i++) { const d = W.ymdOf(n0 + i); const v = W.axesValues(d, { quote: qm.get(d), ohlcv: om.get(d), fng: fm.get(d) }); for (const k of W.AXES) cols[k][i] = v[k]; }
  return cols;
}
const parts = {
  "parse quotes": cpu(() => JSON.parse(qText)),
  "parse ohlcv": cpu(() => JSON.parse(oText)),
  "parse fng ×3": cpu(() => fTexts.map((t) => JSON.parse(t))),
  pickQuotes: cpu(() => W.pickQuotes(q.data, "1")),
  pickOhlcv: cpu(() => W.pickOhlcv(o.data, "1")),
  analyzeFng: cpu(() => W.analyzeFng(fr)),
  "build columns": cpu(build),
  "stringify box": cpu(() => JSON.stringify({ axes: build() })),
};
let total = 0;
for (const [k, v] of Object.entries(parts)) { total += v; console.log(`  ${k.padEnd(14)} ${v.toFixed(3)} ms`); }
console.log(`  heaviest year build (2024: quotes + OHLCV + 3 F&G pages) ≈ ${total.toFixed(2)} ms CPU`);
