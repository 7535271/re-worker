// Offline test for comparing similar pasts through other windows (engine: asOfColumn, rangeState, mean7, windowSimilarity).
import { asOfColumn, rangeState, mean7, windowSimilarity, dayNum, ymdOf } from "../public/engine.js";

let failures = 0;
const check = (label, cond, extra) => { console.log((cond ? "PASS " : "FAIL ") + label + (extra !== undefined ? "  → " + JSON.stringify(extra) : "")); if (!cond) failures++; };

// a small archive: 2013-04-28 … 2016-12-31
const d0 = dayNum("2013-04-28");
const tl = { d0, n: dayNum("2016-12-31") - d0 + 1 };
const idx = (d) => dayNum(d) - d0;

// a window that starts on 2015-07-01 and counts up by 1 every day
const from = "2015-07-01";
const values = [];
for (let i = 0; i < dayNum("2016-12-31") - dayNum(from) + 1; i++) values.push(100 + i);

const col = asOfColumn(tl, from, values, 2);
check("as of D, the value shown is the one from D − 2 (what had come out by D 00:00)", col[idx("2016-01-10")] === 100 + dayNum("2016-01-08") - dayNum(from));
check("before the window opens (and for its first 2 days as of D) there is nothing: NaN, not 0", Number.isNaN(col[idx("2015-06-30")]) && Number.isNaN(col[idx("2015-07-02")]) && col[idx("2015-07-03")] === 100);

// no future leak: change every value after some day; STATE up to that day must not move
const st = rangeState(col);
const cut = "2016-03-01";
const changed = values.map((v, i) => (dayNum(from) + i > dayNum(cut) - 2 ? v * 50 : v));
const st2 = rangeState(asOfColumn(tl, from, changed, 2));
let same = true;
for (let i = 0; i <= idx(cut); i++) if (!(Number.isNaN(st[i]) && Number.isNaN(st2[i])) && st[i] !== st2[i]) same = false;
check("STATE of a day never moves when later values change (no future leak, lag included)", same);
check("fewer than 30 days of past → ABSENT", Number.isNaN(st[idx("2015-07-20")]) && !Number.isNaN(st[idx("2015-08-10")]));
check("a steadily rising value sits at the top of its own past year", st[idx("2016-06-01")] === 1);

// mean7 needs at least 5 of the last 7 days, and the day itself
const m = mean7([1, 2, 3, 4, 5, null, 7, 8]);
check("7-day average: waits for 5 values, skips a missing day", m[3] === null && m[4] === 3 && m[5] === null && Math.abs(m[6] - (1 + 2 + 3 + 4 + 5 + 7) / 6) < 1e-12, m);

// similarity: same state = 1, opposite = 0, half-present window is not compared
const a = new Float64Array(20).fill(0.2);
check("the same state through a window → 1", windowSimilarity([a], 19, 10, 7).similarity === 1);
const x = new Float64Array(20).fill(0.2); for (let i = 0; i < 12; i++) x[i] = 0.9;
check("0.2 all week vs 0.9 all week → 0.3", windowSimilarity([x], 19, 8, 7).similarity === 0.3);
check("two components are averaged: same (0) and far (0.7) → 0.65", windowSimilarity([a, x], 19, 8, 7).similarity === 0.65);
const r = windowSimilarity([x], 19, 13, 7);
check("per-day differences are averaged over the window", r && Math.abs(r.similarity - (1 - (0.7 * 5) / 7)) < 1e-3, r);
const holes = new Float64Array(20).fill(NaN); holes[19] = 0.5; holes[10] = 0.5;
check("less than 80% of the window present → not compared (null, never a made-up number)", windowSimilarity([holes], 19, 10, 7) === null);
check("components that can't be compared are left out and counted", windowSimilarity([a, holes], 19, 10, 7).used === 1);

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
