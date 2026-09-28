// Tests for public/engine.js — the browser-side observer (STATE / TRAJECTORY / STRICT / replay).
import * as E from "../public/engine.js";
import { clock, KV, runCron, get, ds } from "./mock.js";
import worker from "../src/worker.js";

let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  if (!cond) failures++;
}
const DAY = 86400000;

/* A synthetic archive: two yearly boxes, price wanders, sentiment only in the second half. */
function synth(nDays, from = "2020-01-01", f = {}) {
  const d0 = E.dayNum(from);
  const byYear = new Map();
  for (let i = 0; i < nDays; i++) {
    const day = E.ymdOf(d0 + i);
    const y = +day.slice(0, 4);
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push([i, day]);
  }
  const years = [];
  for (const [y, list] of byYear) {
    const axes = {};
    for (const k of E.AXES) axes[k] = [];
    for (const [i] of list) {
      const p = (f.price || ((j) => 100 * (1 + 0.4 * Math.sin(j / 40)) * (1 + j / 800)))(i);
      axes.price.push(p);
      axes.market_cap.push(p * 1e6);
      axes.volume.push((f.volume || ((j) => 1e9 * (1.5 + Math.sin(j / 9))))(i));
      axes.volatility.push(0.03 + 0.02 * Math.abs(Math.sin(i / 13)));
      axes.change_24h.push(Math.sin(i / 5) * 3);
      axes.change_7d.push(Math.sin(i / 11) * 8);
      axes.change_30d.push(Math.sin(i / 23) * 20);
      axes.sentiment.push(i >= (f.fngFrom ?? nDays / 2) ? Math.round(50 + 40 * Math.sin(i / 17)) : null);
      axes.attention.push(null);
    }
    for (const k of E.AXES) if (axes[k].every((v) => v === null)) axes[k] = null;
    years.push({ year: y, from: list[0][1], to: list.at(-1)[1], axes });
  }
  return { meta: {}, years };
}
function alterAfter(series, lastKeep) {
  const s = structuredClone(series);
  for (const b of s.years) {
    const off = E.dayNum(b.from);
    for (const k of E.AXES) {
      const col = b.axes[k];
      if (!col) continue;
      for (let j = 0; j < col.length; j++) {
        if (off + j > E.dayNum(lastKeep) && col[j] !== null) col[j] = col[j] * 37 + 5; // wildly different future
      }
    }
  }
  return s;
}

console.log("\n== timeline & STATE ==");
{
  const s = synth(900);
  const tl = E.buildTimeline(s);
  check("timeline covers every day", tl.n === 900 && tl.first === "2020-01-01" && tl.last === E.ymdOf(E.dayNum("2020-01-01") + 899));
  const st = E.buildStates(tl);
  const pv = st.value.price, nd = st.normDays.price;
  check("range axes ABSENT until 30 days of past exist", Number.isNaN(pv[28]) && !Number.isNaN(pv[29]) && nd[29] === 30, { i28: pv[28], i29: pv[29], nd29: nd[29] });
  check("coverage grows to 365 and stops", nd[200] === 201 && nd[364] === 365 && nd[800] === 365, { nd200: nd[200], nd364: nd[364], nd800: nd[800] });
  let inRange = true;
  for (const k of E.STATE_AXES) for (const v of st.value[k]) if (!Number.isNaN(v) && (v < 0 || v > 1)) inRange = false;
  check("every STATE value is inside 0..1", inRange);
  const i = 700, raw = tl.axes.price;
  let lo = Infinity, hi = -Infinity;
  for (let j = i - 364; j <= i; j++) { lo = Math.min(lo, raw[j]); hi = Math.max(hi, raw[j]); }
  check("price = position in the trailing-year range", Math.abs(pv[i] - (raw[i] - lo) / (hi - lo)) < 1e-12);
  const lv = tl.axes.volume;
  let llo = Infinity, lhi = -Infinity;
  for (let j = i - 364; j <= i; j++) { llo = Math.min(llo, Math.log(lv[j])); lhi = Math.max(lhi, Math.log(lv[j])); }
  check("volume = log first, then position in the range", Math.abs(st.value.volume[i] - (Math.log(lv[i]) - llo) / (lhi - llo)) < 1e-12);
  check("sentiment = value / 100, no coverage", Math.abs(st.value.sentiment[500] - tl.axes.sentiment[500] / 100) < 1e-12 && st.normDays.sentiment === null && Number.isNaN(st.value.sentiment[100]));
  check("attention stays ABSENT", st.value.attention.every(Number.isNaN));

  // no future leak: change everything after D, states up to D must be identical
  const D = E.ymdOf(E.dayNum("2020-01-01") + 600);
  const tl2 = E.buildTimeline(alterAfter(s, D));
  const st2 = E.buildStates(tl2);
  let same = true;
  for (const k of E.AXES) for (let j = 0; j <= 600; j++) {
    const a = st.value[k][j], b = st2.value[k][j];
    if (!(Number.isNaN(a) && Number.isNaN(b)) && a !== b) same = false;
  }
  check("STATE at D does not change when the future changes", same);
}

console.log("\n== TRAJECTORY ==");
{
  const s = synth(900);
  const tl = E.buildTimeline(s);
  const a = E.trajectory(tl, "price", 500, 30);
  check("price path starts at 0", a[0] === 0);
  // scale invariance: the same shape at 1000× the price is the same trajectory
  const big = synth(900, "2020-01-01", { price: (j) => 1000 * 100 * (1 + 0.4 * Math.sin(j / 40)) * (1 + j / 800), volume: (j) => 1000 * 1e9 * (1.5 + Math.sin(j / 9)) });
  const tlb = E.buildTimeline(big);
  const b = E.trajectory(tlb, "price", 500, 30), vb = E.trajectory(tlb, "volume", 500, 30), va = E.trajectory(tl, "volume", 500, 30);
  let maxd = 0;
  for (let t = 0; t < 30; t++) maxd = Math.max(maxd, Math.abs(a[t] - b[t]), Math.abs(va[t] - vb[t]));
  check("price and volume paths ignore the scale (2013 vs 2024 comparable)", maxd < 1e-9, { maxd });
}

console.log("\n== search (STRICT) ==");
{
  // plant an exact copy of the query's shape 400 days earlier at 1/10 the price
  const n = 1200;
  const base = (j) => 100 * (1 + 0.4 * Math.sin(j / 40)) * (1 + j / 800) * (1 + 0.1 * Math.sin(j / 3.7));
  const Q = 1100, P = 700, W = 15;
  const price = (j) => (j > P - W && j <= P ? base(j - P + Q) / 10 : base(j));
  const s = synth(n, "2019-01-01", { price, fngFrom: 2000 });
  const ex = E.createExplorer(s);
  const day = E.dayAt(ex.tl, Q);
  const r = ex.search({ day, mode: "TRAJECTORY", width: W, axes: { price: true, volume: false, volatility: false, sentiment: false } });
  check("TRAJECTORY finds the planted copy first, similarity 1", r.results[0].index === P && r.results[0].similarity === 1, r.results.slice(0, 2).map((x) => [x.day, x.similarity]));
  check("STRICT: every candidate ends at least 30 days before D", r.results.every((x) => x.index + 30 <= Q) && r.strict.last_candidate_end === E.dayAt(ex.tl, Q - 30));
  check("candidates = every window that fits before D−30", r.candidates === (Q - 30) - (W - 1) + 1, { candidates: r.candidates });
  const gaps = r.results.map((x) => x.index).sort((p, q) => p - q);
  check("results are at least max(w,30) days apart", gaps.every((v, i) => i === 0 || v - gaps[i - 1] >= Math.max(W, 30)), gaps);

  // no future leak in the whole search
  const s2 = alterAfter(s, day);
  const r1 = E.createExplorer(s).search({ day, mode: "STATE", width: 7 });
  const r2 = E.createExplorer(s2).search({ day, mode: "STATE", width: 7 });
  const r3 = E.createExplorer(s).search({ day, mode: "TRAJECTORY", width: 30 });
  const r4 = E.createExplorer(s2).search({ day, mode: "TRAJECTORY", width: 30 });
  check("STATE results do not change when the future changes", JSON.stringify(r1) === JSON.stringify(r2));
  check("TRAJECTORY results do not change when the future changes", JSON.stringify(r3) === JSON.stringify(r4));

  // axes: OFF, weights, absent
  const rOff = ex.search({ day, mode: "STATE", width: 7, axes: { market_cap: false } });
  check("an OFF axis is not used", rOff.axes_used_for_query.indexOf("market_cap") < 0 && rOff.results.every((x) => !("market_cap" in x.axes)));
  const rW = ex.search({ day, mode: "STATE", width: 7, weights: { volume: 0 } });
  check("weight 0 removes an axis", rW.results.every((x) => !("volume" in x.axes)));
  check("sentiment is ABSENT when the archive has none", rOff.presence.sentiment === "absent" && rOff.presence.attention === "absent");
  check("TRAJECTORY does not use market_cap or change_* (they repeat the price path)", r3.presence.market_cap === "unused" && r3.presence.change_24h === "unused");
}

console.log("\n== sentiment era & coverage ==");
{
  const s = synth(1000, "2021-01-01", { fngFrom: 600 });
  const ex = E.createExplorer(s);
  const day = E.dayAt(ex.tl, 900);
  const r = ex.search({ day, mode: "STATE", width: 7, top: 50 });
  const early = r.results.filter((x) => x.index < 600), late = r.results.filter((x) => x.index >= 606);
  check("candidates before the F&G era are compared without sentiment", early.length > 0 && early.every((x) => !("sentiment" in x.axes)), early.length);
  check("candidates inside the era use sentiment", late.length > 0 && late.every((x) => "sentiment" in x.axes), late.length);
  const r40 = ex.search({ day: E.dayAt(ex.tl, 900), mode: "STATE", width: 1, top: 50 });
  const young = r40.results.find((x) => x.index < 365);
  check("coverage is reported next to similarity, not inside it", young && young.coverage_days.candidate < 365 && young.coverage_days.query === 365, young && { day: young.day, sim: young.similarity, cov: young.coverage_days });
  const tooEarly = ex.search({ day: E.dayAt(ex.tl, 20), mode: "STATE", width: 1 });
  check("a D with less than 30 days of past: STATE axes are ABSENT", tooEarly.error === "no axis can be observed for this window", tooEarly.error);
}

console.log("\n== the 50%-of-weight rule ==");
{
  // like the half-filled archive on 9/26: F&G exists from day 0, the range axes need 30 days first
  const s = synth(600, "2024-01-01", { fngFrom: 0 });
  const ex = E.createExplorer(s);
  const day = E.dayAt(ex.tl, 400);
  const r = ex.search({ day, mode: "STATE", width: 7, top: 400 });
  const onlyFng = r.results.filter((x) => Object.keys(x.axes).length === 1);
  check("a past where only F&G can be compared is left out (the 2024-01-13 case)", onlyFng.length === 0 && r.excluded > 0, { excluded: r.excluded, onlyFng: onlyFng.map((x) => x.day) });
  check("searched = compared + left out, and covers every window up to D−30", r.searched === r.candidates + r.excluded && r.searched === (400 - 30) - (7 - 1) + 1, { searched: r.searched, compared: r.candidates, excluded: r.excluded });
  const early = r.results.filter((x) => x.index < 40);
  check("every kept past compares at least half of D's weight", r.results.every((x) => Object.keys(x.axes).length >= 4), early.map((x) => [x.day, Object.keys(x.axes).length]));

  // weight-based, not axis-count: pasts before the F&G era keep 7 of 8 axes (kept with equal weights)…
  const s2 = synth(1000, "2021-01-01", { fngFrom: 600 });
  const ex2 = E.createExplorer(s2);
  const d2 = E.dayAt(ex2.tl, 900);
  const eq = ex2.search({ day: d2, mode: "STATE", width: 7, top: 1000 });
  check("equal weights: pasts without F&G (7 of 8) are kept", eq.results.some((x) => x.index < 600 && !("sentiment" in x.axes)));
  // …but if F&G carries most of the weight, they fall under 50% and are left out
  const heavy = ex2.search({ day: d2, mode: "STATE", width: 7, top: 1000, weights: { sentiment: 10 } });
  check("F&G weight 10 (7 of 17 without it): pasts without F&G are left out", heavy.results.every((x) => "sentiment" in x.axes) && heavy.excluded > eq.excluded, { excludedEqual: eq.excluded, excludedHeavy: heavy.excluded });
}

console.log("\n== replay ==");
{
  const s = synth(900);
  const ex = E.createExplorer(s);
  const D = E.dayAt(ex.tl, 800), C = E.dayAt(ex.tl, 500);
  const rq = ex.replay(D, D), rc = ex.replay(C, D);
  check("the event itself is 0%", rq.points.find((p) => p.offset === 0).change === 0);
  check("D's own future is unknown (STRICT)", rq.points.filter((p) => p.offset > 0).every((p) => p.state === "unknown") && rq.points.filter((p) => p.offset <= 0).every((p) => p.state === "seen"));
  check("an analog's +30d is visible", rc.points.every((p) => p.state === "seen") && rc.path.length === 38 && rc.path.every((v) => v !== null));
  const L = ex.last, rl = ex.replay(L, L);
  check("on the archive's last day, the future is '?' (unknown), not '—'", rl.points.filter((p) => p.offset > 0).every((p) => p.state === "unknown"), rl.points.map((p) => p.state));
  const p7 = rc.points.find((p) => p.offset === 7);
  check("+7d change = P(c+7)/P(c) − 1", Math.abs(p7.change - (ex.tl.axes.price[507] / ex.tl.axes.price[500] - 1)) < 1e-12);
}

console.log("\n== on the simulated real archive ==");
{
  const env = { CMC_KEY: "k", RE_CACHE: new KV() };
  clock.now = ds("2026-09-25") + 5 * 60000;
  for (let i = 0; i < 16; i++) { await runCron(worker, env); clock.now += 30 * 60000; }
  const series = (await get(worker, env, "/series?id=1")).body;
  let t = performance.now();
  const ex = E.createExplorer(series);
  const tBuild = performance.now() - t;
  const times = [];
  const show = (r) => r.results.map((x) => `${x.day} ${x.similarity}`).join(" | ");
  for (const [day, mode, w] of [["2020-03-12", "STATE", 7], ["2020-03-12", "TRAJECTORY", 30], ["2014-05-01", "STATE", 7], ["2026-09-25", "STATE", 30], ["2026-09-25", "TRAJECTORY", 30], ["2024-03-14", "TRAJECTORY", 15]]) {
    t = performance.now();
    const r = ex.search({ day, mode, width: w });
    times.push(performance.now() - t);
    console.log(`  ${day} ${mode.padEnd(10)} w=${String(w).padEnd(2)} candidates=${String(r.candidates).padEnd(5)} ${show(r)}`);
  }
  console.log(`  build ${tBuild.toFixed(1)} ms, searches ${times.map((x) => x.toFixed(1)).join(" / ")} ms (Node)`);
  const early = ex.search({ day: "2014-05-01", mode: "STATE", width: 7 });
  check("2014-05-01 has few candidates (a small past), and says so", early.candidates > 0 && early.candidates < 330, { candidates: early.candidates });
  const r1 = ex.search({ day: "2026-09-25", mode: "STATE", width: 1 });
  const r7 = ex.search({ day: "2026-09-25", mode: "STATE", width: 7 });
  check("latest D, 1-day window: sentiment ABSENT (today's value not published yet)", r1.presence.sentiment === "absent" && r1.results.every((x) => !("sentiment" in x.axes)), r1.presence.sentiment);
  check("latest D, 7-day window: 6 of 7 days have sentiment (≥ 80%) → ON", r7.presence.sentiment === "on", r7.presence.sentiment);
}


console.log("\n== filling with later days when the past is short (B) ==");
{
  const ex = E.createExplorer(synth(1400));
  const early = E.ymdOf(E.dayNum("2020-01-01") + 75); // a short past: few windows end 30 days before it
  const r = ex.search({ day: early, mode: "STATE", width: 7, top: 5 });
  const q = E.indexOf(ex.tl, early);
  const past = r.results.filter((x) => !x.later), later = r.results.filter((x) => x.later);
  check("a short past: the list is filled up to five with later days", r.results.length === 5 && later.length >= 1 && r.later_filled === later.length, { past: past.length, later: later.length });
  check("later days come after the past ones, and are marked", r.results.every((x, i) => !x.later || r.results.slice(i).every((y) => y.later)));
  check("a later day's replay starts after D's own next 30 days", later.every((x) => x.index - Math.max(7, 7) > q + E.HORIZON - 1), later.map((x) => x.index - q));
  check("a later day's own 30 days are in the archive", later.every((x) => x.index + E.HORIZON <= ex.tl.n - 1));
  const idx = r.results.map((x) => x.index).sort((a, b) => a - b);
  check("still at least 30 days apart", idx.every((v, i) => i === 0 || v - idx[i - 1] >= 30), idx);
  const mid = E.ymdOf(E.dayNum("2020-01-01") + 900);
  const r2 = ex.search({ day: mid, mode: "STATE", width: 7, top: 5 });
  check("with enough past, nothing later is used (STRICT stays as it was)", r2.results.length === 5 && r2.results.every((x) => !x.later && x.index + E.HORIZON <= E.indexOf(ex.tl, mid)));
  // D's own future still never leaks into the past part
  const altered = E.createExplorer(alterAfter(synth(1400), E.ymdOf(E.dayNum(mid) + 0)));
  const r3 = altered.search({ day: mid, mode: "STATE", width: 7, top: 5 });
  check("changing everything after D changes nothing when the past is enough", JSON.stringify(r3.results) === JSON.stringify(r2.results));
}
console.log("\n== moves like this (hindsight: the shape of how it moved) ==");
{
  // a fall-then-partial-rebound, planted four times: full size, a third of the size, twice as slow, and upside down
  const shape = (t, amp, k) => {
    if (t < 0) return 0;
    const fall = 7 * k, back = 23 * k;
    if (t <= fall) return -amp * (t / fall);
    return -amp + 0.3 * amp * Math.min(1, (t - fall) / back);
  };
  const Q = 1000, A = 400, B = 1300, C = 700;
  const price = (j) => 100 * Math.exp(0.01 * Math.sin(j / 9) + shape(j - Q, 0.5, 1) + shape(j - A, 0.17, 1) + shape(j - B, 0.5, 2) - shape(j - C, 0.5, 1));
  const s = synth(1500, "2019-01-01", { price });
  const ex = E.createExplorer(s);
  const at = (i) => E.dayAt(ex.tl, i);
  const r = ex.movesLike(at(Q), 7);
  const days = r.results.map((x) => x.day);
  check("the smaller copy (a third of the size) is found — shape, not size", days.includes(at(A)), r.results.map((x) => [x.day, x.similarity, x.stretch]));
  check("the slower copy (later in history) is found too", r.results.some((x) => x.day === at(B) && x.later === true));
  const whole = ex.movesLike(at(Q), 30); // the fall and the rebound: only a 2× stretch fits the slow copy
  const b2 = whole.results.find((x) => Math.abs(x.index - B) <= 2);
  check("over the whole fall and rebound, the slow copy fits only when measured at 2× (60 days)", b2 && b2.stretch === 2 && b2.days === 60 && b2.similarity >= 0.95, whole.results.map((x) => [x.day, x.similarity, x.stretch]));
  const a = r.results.find((x) => x.day === at(A));
  check("each result says how much it moved, so the size difference shows", a && Math.abs(a.move) < Math.abs(r.query.move) * 0.5, { query: r.query.move, a: a && a.move });
  check("the upside-down copy is not found", !days.includes(at(C)));
  check("results are ≥ 30 days from the day and from each other", r.results.every((x, i) => Math.abs(x.index - Q) >= 30 && r.results.every((y, j) => i === j || Math.abs(x.index - y.index) >= 30)));
  check("the copies score high (≥ 0.9)", r.results.filter((x) => [at(A), at(B)].includes(x.day)).every((x) => x.similarity >= 0.9));
  const end = ex.movesLike(at(1495), 7);
  check("too close to the archive's end: says so", end.results.length === 0 && /not enough days after/.test(end.error), end.error);
  const m = ex.movesLike(at(Q), 30);
  check("a month-long span also works", m.results.length > 0 && m.query.days === 30);
}
console.log("\n== one pair, measured the ways the searches measure ==");
{
  const s = synth(1500, "2019-01-01");
  const ex = E.createExplorer(s);
  const D = E.dayAt(ex.tl, 1200);
  for (const [mode, width] of [["STATE", 7], ["STATE", 30], ["TRAJECTORY", 15]]) {
    const r = ex.search({ day: D, mode, width, top: 3 });
    const same = r.results.every((x) => ex.pairAlike(D, x.day, { mode, width }).looked.similarity === x.similarity);
    check(`looked (${mode}, ${width}d): the pair measure equals what the search found`, same && r.results.length > 0, r.results.map((x) => [x.day, x.similarity, ex.pairAlike(D, x.day, { mode, width }).looked.similarity]));
  }
  const later = E.dayAt(ex.tl, 1400);
  const pl = ex.pairAlike(D, later, { mode: "STATE", width: 7 });
  const s2 = alterAfter(s, later);
  const pl2 = E.createExplorer(s2).pairAlike(D, later, { mode: "STATE", width: 7 });
  check("looked: a later day can be measured too, using nothing after either day", typeof pl.looked.similarity === "number" && pl.looked.similarity === pl2.looked.similarity, [pl.looked, pl2.looked]);
  const m = ex.movesLike(D, 7, { top: 3 });
  const sameMoved = m.results.every((x) => { const pm = ex.pairAlike(D, x.day, { span: 7 }).moved; return pm.similarity === x.similarity && pm.stretch === x.stretch; });
  check("moved: the pair measure equals what movesLike found (similarity and stretch)", sameMoved && m.results.length > 0);
  const end = ex.pairAlike(ex.last, D, { span: 7 });
  check("moved: on the archive's last day it says there are not enough days after", /not enough days after/.test(end.moved.error || ""), end.moved);
}
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
