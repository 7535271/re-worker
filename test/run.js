import { clock, cfg, calls, KV, runCron, get, ds, ymd, iso, g, fngValueFor } from "./mock.mjs";
import worker from "../src/worker.js";

const DAY = 86400000, MIN = 60000, HOUR = 3600000;
const AXES = ["price", "volume", "market_cap", "volatility", "change_24h", "change_7d", "change_30d", "sentiment", "attention"];
let failures = 0;
function check(label, cond, extra) {
  console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : ""));
  if (!cond) failures++;
}
// most sections test one asset (Bitcoin) at the old 30-minute cadence; section "five assets" tests the real set
const newEnv = () => ({ CMC_KEY: "test", RE_CACHE: new KV(), RE_ARCHIVE_IDS: "1" });

function seriesDays(body) {
  const m = new Map();
  let prevEnd = null;
  const gaps = [];
  for (const box of body.years) {
    const n = Math.round((ds(box.to) - ds(box.from)) / DAY) + 1;
    for (const k of AXES) {
      const col = box.axes[k];
      if (col !== null && col.length !== n) gaps.push(`length mismatch ${box.year} ${k} ${col.length} vs ${n}`);
    }
    if (prevEnd && ds(box.from) !== ds(prevEnd) + DAY) gaps.push(`gap ${prevEnd} → ${box.from}`);
    prevEnd = box.to;
    for (let j = 0; j < n; j++) {
      const d = ymd(ds(box.from) + j * DAY);
      const v = {};
      for (const k of AXES) v[k] = box.axes[k] ? box.axes[k][j] : null;
      m.set(d, v);
    }
  }
  return { m, gaps };
}
function stateDays(body) {
  const m = new Map();
  for (const s of body.states) {
    const v = {};
    for (const k of AXES) v[k] = s.axes[k].value;
    m.set(s.timestamp.slice(0, 10), v);
  }
  return m;
}
async function compareWithState(env, start, end, label) {
  const sr = await get(worker, env, `/series?id=1`);
  const st = await get(worker, env, `/state?id=1&start=${start}&end=${end}`);
  const S = seriesDays(sr.body).m, T = stateDays(st.body);
  const diffs = [];
  for (const [d, tv] of T) {
    const sv = S.get(d);
    if (!sv) { diffs.push(`${d}: not in series`); continue; }
    for (const k of AXES) if (sv[k] !== tv[k]) diffs.push(`${d} ${k}: series ${sv[k]} / state ${tv[k]}`);
  }
  for (let t = ds(start); t <= ds(end); t += DAY) {
    const d = ymd(t);
    if (S.has(d) && !T.has(d)) {
      const sv = S.get(d);
      if (AXES.some((k) => sv[k] !== null)) diffs.push(`${d}: in series but not in state`);
    }
  }
  check(`series == state for ${start}..${end} ${label || ""}`, diffs.length === 0 && T.size > 0, diffs.slice(0, 5).concat([`${T.size} days`]));
}

/* ── 1. /state regression (same checks as v2) ── */
{
  console.log("\n== /state regression ==");
  const env = newEnv();
  let r = await get(worker, env, "/state");
  check("no params → 400", r.status === 400, r.body.problems);
  r = await get(worker, env, "/state?id=1&start＝2025-06-01&end=2025-06-30");
  check("full-width ＝ → 400, visible in raw_query", r.status === 400 && r.body.raw_query.includes("＝"));
  r = await get(worker, env, "/state?id=1&start=2020-02-30&end=2020-03-01");
  check("nonexistent date → 400", r.status === 400);
  r = await get(worker, env, "/state?id=1&start=2020-03-05&end=2020-03-01");
  check("reversed → 400", r.status === 400);
  r = await get(worker, env, "/state?id=1&start=2020-03-01&end=2020-03-31");
  check("31 days, start inclusive", r.status === 200 && r.body.meta.days === 31 && r.body.states[0].timestamp === "2020-03-01T00:00:00Z");
  check("volatility on 31", r.body.axis_summary.volatility.on === 31, r.body.axis_summary.volatility);
  check("trace 3/1 00:00 / candle 2/29", r.body.sample._trace.quote_snapshot === "2020-03-01T00:00:00.000Z" && r.body.sample._trace.ohlcv_candle === "2020-02-29", r.body.sample._trace);
  check("sentiment absent before F&G era", r.body.axis_summary.sentiment.absent === 31);
  cfg.ohlcvEndExclusive = true;
  r = await get(worker, env, "/state?id=1&start=2020-03-01&end=2020-03-31");
  check("volatility on 31 even if OHLCV time_end is exclusive", r.body.axis_summary.volatility.on === 31, r.body.axis_summary.volatility);
  cfg.ohlcvEndExclusive = false;
  r = await get(worker, env, "/probe/fng");
  check("probe/fng: oldest 2023-06-29, no gaps", r.body._summary.oldest === "2023-06-29" && r.body._summary.missing_days.count === 0 && r.body._summary.ok === true, { newest: r.body._summary.newest, pages: r.body._summary.pages });
  r = await get(worker, env, "/state?id=1&start=2026-09-20&end=2026-09-25");
  const sent = r.body.states.map((s) => [s.timestamp.slice(0, 10), s.axes.sentiment.state]);
  check("today's and yesterday's sentiment are absent (not published yet)", sent.at(-1)[1] === "absent" && sent.at(-2)[1] === "absent" && sent.at(-3)[1] === "on", sent);
}

/* ── 2. no storage bound ── */
{
  console.log("\n== no KV binding ==");
  const env = { CMC_KEY: "test" };
  let r = await get(worker, env, "/series?id=1");
  check("/series → 503", r.status === 503, r.body);
  r = await get(worker, env, "/archive/status");
  check("/archive/status → 503", r.status === 503);
  r = await get(worker, env, "/archive/step");
  check("/archive/step → 503", r.status === 503);
  const before = calls.length;
  await runCron(worker, env);
  check("cron does nothing without storage", calls.length === before);
  r = await get(worker, env, "/state?id=1&start=2020-03-01&end=2020-03-02");
  check("/state still works", r.status === 200 && r.body.meta.days === 2);
}

/* ── 3. fresh archive: backfill by cron ── */
const env = newEnv();
{
  console.log("\n== backfill ==");
  clock.now = ds("2026-09-25") + 5 * MIN;
  let r = await get(worker, env, "/archive/status");
  check("status before anything: empty", r.status === 200 && /empty so far/.test(r.body.archives[0].state));
  r = await get(worker, env, "/series?id=1");
  check("/series before anything → 404", r.status === 404);
  const order = [];
  let runs = 0;
  for (; runs < 40; runs++) {
    await runCron(worker, env);
    const meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
    order.push(meta.last_step.year ?? meta.last_step.did);
    if (meta.complete) break;
    clock.now += 30 * MIN;
  }
  check("built newest first, 2026 → 2013, in 14 runs", order.join(",") === Array.from({ length: 14 }, (_, i) => 2026 - i).join(","), order);
  const meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
  check("fng_from discovered = 2023-06-29", meta.fng_from === "2023-06-29", meta.fng_from);
  check("2013 starts at the first CMC day", meta.years[2013].from === "2013-04-28", meta.years[2013]);
  check("2026 ends today", meta.years[2026].to === "2026-09-25", meta.years[2026]);
  check("last_on: price today, sentiment 2 days behind", meta.last_on.price === "2026-09-25" && meta.last_on.sentiment === "2026-09-23" && meta.last_on.attention === null, meta.last_on);
  const fngCalls = calls.filter((c) => c.path === "/v3/fear-and-greed/historical" && c.q.includes("limit=500"));
  console.log("  F&G full-page calls during backfill:", fngCalls.length);

  r = await get(worker, env, "/series?id=1");
  const { m, gaps } = seriesDays(r.body);
  const expectDays = Math.round((ds("2026-09-25") - ds("2013-04-28")) / DAY) + 1;
  check("series: contiguous, one entry per day", gaps.length === 0 && m.size === expectDays, { gaps: gaps.slice(0, 3), days: m.size, expectDays });
  check("series meta complete", r.body.meta.complete === true && r.body.meta.missing_years.length === 0);
  console.log(`  /series size: ${(r.bytes / 1024).toFixed(0)} KB for ${m.size} days`);
  check("2013-04-28 has price, no volatility (no earlier candle)", m.get("2013-04-28").price !== null && m.get("2013-04-28").volatility === null);
  check("2013-04-29 has volatility", m.get("2013-04-29").volatility !== null);
  check("sentiment absent on 2023-06-28, on from 2023-06-29", m.get("2023-06-28").sentiment === null && m.get("2023-06-29").sentiment !== null);
  const y2020 = r.body.years.find((b) => b.year === 2020);
  check("pre-F&G years store sentiment and attention as null columns", y2020.axes.sentiment === null && y2020.axes.attention === null);
  r = await get(worker, env, "/series?id=1&from=2025&to=2026");
  check("/series year filter", r.body.years.map((b) => b.year).join(",") === "2025,2026");
  r = await get(worker, env, "/series?id=1&from=20x5");
  check("/series bad year → 400", r.status === 400);
  r = await get(worker, env, "/series?id=999");
  check("/series unknown id → 400", r.status === 400);

  await compareWithState(env, "2020-03-01", "2020-03-31");
  await compareWithState(env, "2023-06-20", "2023-07-10", "(F&G era starts)");
  await compareWithState(env, "2025-12-20", "2026-01-10", "(year boundary)");
  await compareWithState(env, "2013-04-20", "2013-05-10", "(first days)");
  // 2026 was built at 00:05; the 9/24 F&G value was published at 02:00. The first refresh after the backfill picks it up.
  const sBefore = seriesDays((await get(worker, env, "/series?id=1")).body).m.get("2026-09-24").sentiment;
  clock.now += 30 * MIN;
  await runCron(worker, env);
  const sAfter = seriesDays((await get(worker, env, "/series?id=1")).body).m.get("2026-09-24").sentiment;
  check("9/24 sentiment: absent in the 00:05 build, filled by the first refresh", sBefore === null && sAfter !== null, { sBefore, sAfter });
  await compareWithState(env, "2026-09-10", "2026-09-25", "(recent days, after the first refresh)");

  r = await get(worker, env, "/archive/status");
  const a = r.body.archives[0];
  check("status: complete, 14 years listed", a.complete === true && a.years.length === 14, a.years.slice(0, 2).concat(a.years.slice(-1)));
}

/* ── 4. hourly refresh: days roll forward, F&G arrives late, failures erase nothing ── */
{
  console.log("\n== refresh ==");
  const writesBefore = env.RE_CACHE.writes;
  const t0 = clock.now;
  const did = [];
  const refreshTimes = new Set();
  let sawFail = false;
  for (let i = 0; i < 6 * 24; i++) { // 3 days of cron runs (:05 and :35)
    clock.now += 30 * MIN;
    const hourOfRun = new Date(clock.now).getUTCHours();
    cfg.fail.fng = i === 20;       // one run with F&G failing
    cfg.fail.quotes = i === 40;    // one run with quotes failing
    const snapBefore = env.RE_CACHE.m.get("series:v1:1:2026");
    await runCron(worker, env);
    const meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
    did.push(meta.last_step.did);
    refreshTimes.add(meta.last_refresh_at);
    const dayNow = ymd(clock.now);
    if (new Date(clock.now).getUTCHours() === 0 && new Date(clock.now).getUTCMinutes() === 5) {
      check(`first run of ${dayNow} (00:05) refreshes and brings the new day in`, meta.last_refresh_at === iso(clock.now) && meta.years[2026].to === dayNow, { last: meta.last_refresh_at, to: meta.years[2026].to });
    }
    if (cfg.fail.fng || cfg.fail.quotes) {
      const before = JSON.parse(snapBefore), after = JSON.parse(env.RE_CACHE.m.get("series:v1:1:2026"));
      let erased = 0;
      for (const k of AXES) {
        const b = before.axes[k], a = after.axes[k];
        if (!b) continue;
        for (let j = 0; j < b.length; j++) if (b[j] !== null && (!a || a[j] === null)) erased++;
      }
      check(`a failing ${cfg.fail.fng ? "F&G" : "quotes"} run erased nothing`, erased === 0, { erased });
      sawFail = true;
    }
  }
  cfg.fail.fng = false; cfg.fail.quotes = false;
  const meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
  const today = ymd(clock.now);
  check("box follows today", meta.years[2026].to === today, { to: meta.years[2026].to, today });
  check("sentiment keeps arriving ~1-2 days behind", meta.last_on.sentiment >= ymd(clock.now - 2 * DAY), meta.last_on);
  const refreshes = refreshTimes.size;
  check("refresh about once an hour (not every run)", refreshes >= 70 && refreshes <= 78, { refreshes, runs: did.length });
  const writes = env.RE_CACHE.writes - writesBefore;
  console.log(`  KV writes over 3 days: ${writes} (≈${Math.round(writes / 3)}/day, free limit 1000/day)`);
  check("KV writes well under 1000/day", writes / 3 < 250, { perDay: Math.round(writes / 3) });
  await compareWithState(env, ymd(clock.now - 14 * DAY), today, "(after 3 days of refresh)");
  const callsPerDay = calls.filter((c) => c.at > t0).length / 3;
  console.log(`  CMC calls per day while idle: ${Math.round(callsPerDay)}`);
}

/* ── 5. manual step throttle ── */
{
  console.log("\n== /archive/step ==");
  // put the clock right after a refresh
  clock.now += 30 * MIN;
  let r = await get(worker, env, "/archive/step");
  const w0 = env.RE_CACHE.writes;
  r = await get(worker, env, "/archive/step");
  check("second tap within 10 min: nothing to do, no writes", r.body.results[0].did === "nothing to do right now" && env.RE_CACHE.writes === w0, r.body.results[0]);
  clock.now += 11 * MIN;
  r = await get(worker, env, "/archive/step");
  check("after 11 min: refreshes", r.body.results[0].did === "refreshed recent days", r.body.results[0].did);
}

/* ── 6. year boundary (after a long gap: stale year is rebuilt first) ── */
{
  console.log("\n== year boundary ==");
  clock.now = ds("2026-12-30") + 5 * MIN;
  await runCron(worker, env);
  let meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
  check("stale 2026 is rebuilt after a 3-month gap", meta.last_step.did === "built a year" && meta.last_step.year === 2026 && meta.years[2026].to === "2026-12-30", meta.last_step);
  for (let i = 0; i < 4 * 48; i++) { clock.now += 30 * MIN; await runCron(worker, env); }
  meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
  check("2026 closes on 12-31", meta.years[2026].to === "2026-12-31", meta.years[2026]);
  check("2027 box exists and follows today", meta.years[2027] && meta.years[2027].from === "2027-01-01" && meta.years[2027].to === ymd(clock.now), meta.years[2027]);
  const r = await get(worker, env, "/series?id=1");
  const { gaps } = seriesDays(r.body);
  check("no gaps across the new year", gaps.length === 0, gaps.slice(0, 3));
  await compareWithState(env, "2026-12-20", ymd(clock.now), "(across the new year)");
}

/* ── 7. the key stops working (e.g. after 10/8) ── */
{
  console.log("\n== key expired ==");
  const snap = new Map(env.RE_CACHE.m);
  cfg.fail.all401 = true;
  const c0 = calls.length;
  for (let i = 0; i < 48; i++) { clock.now += 30 * MIN; await runCron(worker, env); }
  let changedBoxes = 0;
  for (const [k, v] of snap) if (k.startsWith("series:") && env.RE_CACHE.m.get(k) !== v) changedBoxes++;
  check("no box changed during 24h of 401s", changedBoxes === 0);
  const r = await get(worker, env, "/series?id=1");
  check("/series still serves everything", r.status === 200 && r.body.years.length === 15);
  const st = await get(worker, env, "/archive/status");
  check("errors are visible", st.body.archives[0].errors[0].http_status === 401, st.body.archives[0].errors[0]);
  console.log(`  CMC calls in 24h of 401s: ${calls.length - c0}`);
  // a year going stale while the key is dead: retries back off
  clock.now += 20 * DAY;
  const c1 = calls.length;
  for (let i = 0; i < 48; i++) { clock.now += 30 * MIN; await runCron(worker, env); }
  const builds = calls.slice(c1).filter((c) => c.path.includes("quotes") && c.q.includes("time_start=2026-12-31")).length;
  const meta = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
  check("stale-year rebuild retries back off (≤ 6 tries in 24h)", builds <= 6, { builds, backoff: meta.backoff });
  // the app keeps the coin open: only the years from the last stored day on are missing (rule in public/app.js boot)
  const st2 = (await get(worker, env, "/archive/status")).body.archives[0];
  const lastY = Number(st2.last_on.price.slice(0, 4));
  const open = st2.complete === true || st2.missing_years.every((y) => y >= lastY);
  check("stale archive: the coin stays open in the app", st2.complete === false && open, { missing: st2.missing_years, last_price_day: st2.last_on.price });
  const r3 = await get(worker, env, "/series?id=1");
  check("stale archive: /series still serves every stored day", r3.status === 200 && seriesDays(r3.body).gaps.length === 0);
  cfg.fail.all401 = false;
  for (let i = 0; i < 30 && JSON.parse(env.RE_CACHE.m.get("meta:v1:1")).backoff[2027]; i++) { clock.now += 30 * MIN; await runCron(worker, env); }
  const meta2 = JSON.parse(env.RE_CACHE.m.get("meta:v1:1"));
  check("recovers when the key works again", meta2.years[2027].to === ymd(clock.now) && !meta2.backoff[2027], meta2.years[2027]);
  const r2 = await get(worker, env, "/series?id=1");
  check("still no gaps", seriesDays(r2.body).gaps.length === 0);
}

/* ── 8. current year with no data yet (fresh archive at 00:01 on Jan 1) ── */
{
  console.log("\n== empty current year ==");
  const env2 = newEnv();
  clock.now = ds("2027-01-01") + 1 * MIN;
  await runCron(worker, env2);
  let meta = JSON.parse(env2.RE_CACHE.m.get("meta:v1:1"));
  check("2027 marked empty for now", meta.years[2027] && meta.years[2027].empty === true, meta.years[2027]);
  clock.now += 30 * MIN; await runCron(worker, env2);
  meta = JSON.parse(env2.RE_CACHE.m.get("meta:v1:1"));
  check("next run moves on to 2026", meta.last_step.year === 2026);
  clock.now += 61 * MIN; await runCron(worker, env2);
  meta = JSON.parse(env2.RE_CACHE.m.get("meta:v1:1"));
  check("an hour later 2027 is retried and filled", meta.years[2027] && !meta.years[2027].empty && meta.years[2027].to === "2027-01-01", meta.years[2027]);
}

/* ── 9. F&G timing log ── */
async function timingRun(hyp) {
  cfg.hypothesis = hyp;
  const env3 = newEnv();
  clock.now = ds("2026-09-25") + 5 * MIN;
  for (let i = 0; i < 48 * 7; i++) { await runCron(worker, env3); clock.now += 30 * MIN; }
  return (await get(worker, env3, "/probe/fng-timing")).body;
}
{
  console.log("\n== F&G timing ==");
  const a = await timingRun("A");
  console.log("  A:", JSON.stringify(a._summary));
  const va = a._summary.verdicts;
  check("hypothesis A → mostly 'D 00:00'", (va["D 00:00"] || 0) >= 4 && !va["D+1 00:00"], va);
  check("A: lag ≈ 26h", a._summary.publication_lag_hours && Math.abs(a._summary.publication_lag_hours.median - 26) <= 0.6, a._summary.publication_lag_hours);
  check("A: rows already there at start are marked", a.days.at(-1).appeared === "already in the API when logging started");
  check("A: live update minutes are :00 and :30", Object.keys(a._summary.live_update_minute_of_hour).sort().join(",") === "0,30", a._summary.live_update_minute_of_hour);
  const b = await timingRun("B");
  console.log("  B:", JSON.stringify(b._summary));
  const vb = b._summary.verdicts;
  check("hypothesis B → mostly 'D+1 00:00'", (vb["D+1 00:00"] || 0) >= 4 && !vb["D 00:00"], vb);
  console.log("  one row:", JSON.stringify(b.days[2], null, 0));
  cfg.hypothesis = "A";
}

/* ── 9b. five assets: the real set, with the real 5-minute cron (one asset per run) ── */
{
  console.log("\n== five assets (5-minute cron, one asset per run) ==");
  const env5 = { CMC_KEY: "test", RE_CACHE: new KV() };
  clock.now = ds("2026-09-24") + 22 * HOUR; // the fill crosses midnight
  const before = calls.length;
  const perRun = [];
  let observes = 0, btcAtMidnight = null;
  for (let i = 0; i < 12 * 24; i++) {
    const c0 = calls.length;
    await runCron(worker, env5);
    const mine = calls.slice(c0);
    if (clock.now === ds("2026-09-25")) btcAtMidnight = mine.filter((c) => c.path === "/v3/cryptocurrency/quotes/historical").map((c) => new URLSearchParams(c.q).get("id"));
    perRun.push(mine.filter((c) => c.path.includes("/cryptocurrency/")).length);
    if (mine.some((c) => c.path === "/v3/fear-and-greed/latest")) observes++;
    clock.now += 5 * MIN;
  }
  check("each run works on one asset at most (≤ 2 market calls)", perRun.every((n) => n <= 2), Math.max(...perRun));
  check("F&G observed only on the :05 and :35 runs (48 a day)", observes === 48, observes);
  check("while the others fill, Bitcoin's new day is refreshed at the first run after 00:00", JSON.stringify(btcAtMidnight) === '["1"]', btcAtMidnight);
  const st = await get(worker, env5, "/archive/status");
  check("all five archives complete within a day", st.body.archives.length === 5 && st.body.archives.every((a) => a.complete),
    st.body.archives.map((a) => [a.id, a.complete, (a.missing_years || []).length]));
  const early = calls.slice(before)
    .filter((c) => c.path === "/v3/cryptocurrency/quotes/historical")
    .map((c) => new URLSearchParams(c.q))
    .filter((q) => (q.get("id") === "1027" && q.get("time_start") < "2014-12-31") || (q.get("id") === "5426" && q.get("time_start") < "2019-12-31"));
  check("never asks ETH before 2015 or SOL before 2020", early.length === 0, early.length);
  for (const id of ["1027", "52", "5426", "74"]) {
    const r = await get(worker, env5, `/series?id=${id}`);
    check(`/series?id=${id} → 200`, r.status === 200 && Array.isArray(r.body.years), r.status);
  }
  const w0 = env5.RE_CACHE.writes;
  const c1 = calls.length;
  for (let i = 0; i < 12 * 24; i++) { await runCron(worker, env5); clock.now += 5 * MIN; }
  const writes = env5.RE_CACHE.writes - w0;
  check("a full day after the fill: KV writes < 300 (free limit 1,000; the rest is left for the page)", writes < 300, writes);
  const per = {};
  for (const c of calls.slice(c1)) if (c.path === "/v3/cryptocurrency/quotes/historical") { const id = new URLSearchParams(c.q).get("id"); per[id] = (per[id] || 0) + 1; }
  check("Bitcoin refreshed about hourly, the others about every 3 hours", per["1"] >= 18 && per["1"] <= 30 && ["1027", "52", "5426", "74"].every((id) => per[id] >= 6 && per[id] <= 10), per);
  let r = await get(worker, env5, "/archive/status?write=1");
  check("/archive/status?write=1 says whether KV still takes writes", r.body.kv_write === "ok", r.body.kv_write);
  const broken = { CMC_KEY: "test", RE_CACHE: Object.assign(new KV(), { put: async () => { throw new Error("KV put() limit exceeded for the day."); } }) };
  r = await get(worker, broken, "/archive/status?write=1");
  check("… and when it does not, says why", /limit exceeded/.test(r.body.kv_write), r.body.kv_write);
  r = await get(worker, env5, "/archive/step?id=999");
  check("/archive/step unknown id → 400", r.status === 400);
  r = await get(worker, env5, "/archive/step?id=1027");
  check("/archive/step?id=1027 works on ETH only", r.status === 200 && r.body.results.length === 1 && r.body.results[0].id === "1027", r.body.results);
}

/* ── 10. CPU-ish: how long one step takes (Node, same V8 as Workers) ── */
{
  console.log("\n== timing (wall clock in Node) ==");
  const env4 = newEnv();
  clock.now = ds("2026-09-25") + 5 * MIN;
  cfg.memo = true;
  for (let i = 0; i < 14; i++) { await runCron(worker, env4); clock.now += 30 * MIN; } // warm the memo
  // rebuild some years with memoized CMC responses (so the mock costs ~nothing) and time one cron run each
  const times = [];
  for (const y of [2026, 2025, 2024, 2023, 2022, 2026, 2025]) {
    const meta = JSON.parse(env4.RE_CACHE.m.get("meta:v1:1"));
    delete meta.years[y];
    env4.RE_CACHE.m.set("meta:v1:1", JSON.stringify(meta));
    const t = performance.now();
    await runCron(worker, env4);
    times.push(performance.now() - t);
    const after = JSON.parse(env4.RE_CACHE.m.get("meta:v1:1"));
    if (after.last_step.year !== y) console.log("  (timing run built", after.last_step.year, "instead of", y, ")");
  }
  const t1 = performance.now();
  for (let i = 0; i < 20; i++) await get(worker, env4, "/series?id=1");
  const seriesMs = (performance.now() - t1) / 20;
  cfg.memo = false;
  console.log(`  year build (incl. mock + F&G log): ${times.map((x) => x.toFixed(1)).join(", ")} ms`);
  console.log(`  /series: ${seriesMs.toFixed(2)} ms per request`);
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
