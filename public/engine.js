/* ──────────────────────────────────────────
   RE: — engine（ブラウザで動く観測器）
   /series の倉庫データから、似た過去を探してリプレイする。
   DOM を触らない純粋な関数だけ（ブラウザでも Node のテストでも同じものが動く）。

   ── 2つの観測器（2026-09-25、ノヴァと決めた形）──
   STATE      = その時点の状態。各軸を 0〜1 の座標にそろえる。
                正規化には D 以前のデータしか使わない（未来を覗かない）。
                  price / market_cap / volatility / change_* : 過去1年のレンジの中の位置
                  volume     : log を取ってから、過去1年のレンジの中の位置
                  sentiment  : 0〜100 → 0〜1
                過去が30日未満の軸は ABSENT。1年未満のときは、何日ぶんで正規化したか
                （coverage）を別に返す。similarity には混ぜない。
   TRAJECTORY = そこに至るまでの動き。窓の最初の日を基準にした変化の道のり。
                  price      : P(t) / P(窓の最初) − 1
                  volume     : log( V(t) / 窓の中央値 )
                  volatility : その日の値幅（そのまま）
                  sentiment  : F&G(t) − F&G(窓の最初)
                軸ごとに固定の目盛り（TRAJ_SCALE）で割る。候補の中での順位は使わない
                （似ている度合いが、探した候補の顔ぶれで変わらないように）。

   ── STRICT（D から見えていた世界）──
   候補の窓は、その後 HORIZON 日のリプレイまで D 以前に収まるものだけ：
     candidate_end + HORIZON ≤ D
   D 自身のその後は見せない（その時点では、まだ誰も知らない）。

   ── 軸の三状態 ──
   ON = データがあって使う / OFF = データはあるがユーザーが閉じた / ABSENT = データが無い
   比べる2つの両方にある軸だけを使い、重みを合計 100% に配り直す。
   ただし D で比べられる軸の重みのうち、半分以上を比べられた過去だけを候補にする。
   外した過去の数は隠さずに返す（excluded）。
   ────────────────────────────────────────── */

export const DAY = 86400000;
export const AXES = [
  "price", "volume", "market_cap", "volatility",
  "change_24h", "change_7d", "change_30d",
  "sentiment", "attention",
];

export const STATE_AXES = ["price", "market_cap", "volume", "volatility", "change_24h", "change_7d", "change_30d", "sentiment", "attention"];
export const TRAJ_AXES = ["price", "volume", "volatility", "sentiment", "attention"];

/* STATE の正規化（軸ごとに意味に合わせる） */
export const STATE_RULE = {
  price:      { kind: "range" },
  market_cap: { kind: "range" },
  volume:     { kind: "range", log: true },
  volatility: { kind: "range" },
  change_24h: { kind: "range" },
  change_7d:  { kind: "range" },
  change_30d: { kind: "range" },
  sentiment:  { kind: "fixed", min: 0, max: 100 },
  attention:  { kind: "none" }, // まだ観測窓が無い
};
export const NORM_DAYS = 365;     // 正規化に使う過去（D−364 〜 D）
export const MIN_NORM_DAYS = 30;  // これ未満しか過去が無い軸は ABSENT

/* TRAJECTORY の固定の目盛り：窓の中で平均してこれだけ違えば「まったく別の動き」（距離 1） */
export const TRAJ_SCALE = {
  price: 0.20,          // 道のりの差が平均 20%
  volume: Math.LN2,     // 出来高の倍率が平均 2 倍ちがう
  volatility: 0.04,     // 1日の値幅が平均 4 ポイントちがう
  sentiment: 20,        // F&G の動きが平均 20 ポイントちがう
  attention: 1,
};

export const PICK_GAP_DAYS = 30;                   // 似てる日どうしは30日以上離す
export const HORIZON = 30;                         // STRICT：候補のリプレイはここまで D 以前に収める
export const REPLAY_OFFSETS = [-7, -1, 0, 1, 3, 7, 14, 30];
export const WIDTHS = [1, 7, 15, 30];
export const MIN_SHARE = 0.8;                      // 窓の 8 割以上で値がそろった軸だけ比べる
export const MIN_WEIGHT_SHARE = 0.5;               // D で比べられる軸の重みのうち、半分以上を比べられた過去だけを候補にする

/* ── 日付（1970-01-01 から何日目か。worker.js と同じやり方） ── */
export function dayNum(ymd) {
  return Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY;
}
export function ymdOf(n) {
  const z = n + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return `${y}-${m < 10 ? "0" : ""}${m}-${d < 10 ? "0" : ""}${d}`;
}

/* ── 倉庫の年ごとの箱を、1本の時間軸にならべる（無い日は NaN = ABSENT） ── */
export function buildTimeline(series) {
  const boxes = (series && series.years) || [];
  if (!boxes.length) throw new Error("the archive has no days yet");
  let lo = Infinity, hi = -Infinity;
  for (const b of boxes) {
    lo = Math.min(lo, dayNum(b.from));
    hi = Math.max(hi, dayNum(b.to));
  }
  const n = hi - lo + 1;
  const axes = {};
  for (const k of AXES) axes[k] = new Float64Array(n).fill(NaN);
  for (const b of boxes) {
    const off = dayNum(b.from) - lo;
    for (const k of AXES) {
      const col = b.axes && b.axes[k];
      if (!col) continue;
      for (let j = 0; j < col.length; j++) {
        const v = col[j];
        if (typeof v === "number" && Number.isFinite(v)) axes[k][off + j] = v;
      }
    }
  }
  const logVol = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) if (axes.volume[i] > 0) logVol[i] = Math.log(axes.volume[i]);
  return { d0: lo, n, first: ymdOf(lo), last: ymdOf(hi), axes, logVol, meta: series.meta || {} };
}
export function indexOf(tl, ymd) { return dayNum(ymd) - tl.d0; }
export function dayAt(tl, i) { return ymdOf(tl.d0 + i); }

/* 窓 [i−W+1, i] の最小・最大・値のある日数（NaN は飛ばす）。単調キューで O(n) */
function rollingRange(x, W) {
  const n = x.length;
  const lo = new Float64Array(n), hi = new Float64Array(n), cnt = new Int32Array(n);
  const qmin = new Int32Array(n), qmax = new Int32Array(n);
  let hmin = 0, tmin = 0, hmax = 0, tmax = 0, c = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (!Number.isNaN(v)) {
      while (tmin > hmin && x[qmin[tmin - 1]] >= v) tmin--;
      qmin[tmin++] = i;
      while (tmax > hmax && x[qmax[tmax - 1]] <= v) tmax--;
      qmax[tmax++] = i;
      c++;
    }
    const out = i - W;
    if (out >= 0 && !Number.isNaN(x[out])) c--;
    while (hmin < tmin && qmin[hmin] <= out) hmin++;
    while (hmax < tmax && qmax[hmax] <= out) hmax++;
    cnt[i] = c;
    lo[i] = hmin < tmin ? x[qmin[hmin]] : NaN;
    hi[i] = hmax < tmax ? x[qmax[hmax]] : NaN;
  }
  return { lo, hi, cnt };
}

/* ── STATE：各日の 0〜1 座標と、何日ぶんの過去で正規化したか ──
   i 日目の値は i 日目以前のデータだけから決まる。 */
export function buildStates(tl) {
  const value = {}, normDays = {};
  for (const k of AXES) {
    const rule = STATE_RULE[k] || { kind: "none" };
    const src = tl.axes[k];
    const v = new Float64Array(tl.n).fill(NaN);
    if (rule.kind === "fixed") {
      for (let i = 0; i < tl.n; i++) {
        const x = src[i];
        if (!Number.isNaN(x)) v[i] = Math.min(1, Math.max(0, (x - rule.min) / (rule.max - rule.min)));
      }
      value[k] = v;
      normDays[k] = null; // 過去に頼らない変換なので coverage は無い
      continue;
    }
    if (rule.kind !== "range") { value[k] = v; normDays[k] = null; continue; }
    const x = rule.log ? src.map((a) => (a > 0 ? Math.log(a) : NaN)) : src;
    const { lo, hi, cnt } = rollingRange(x, NORM_DAYS);
    const nd = new Int16Array(tl.n);
    for (let i = 0; i < tl.n; i++) {
      nd[i] = cnt[i];
      const xi = x[i];
      if (Number.isNaN(xi) || cnt[i] < MIN_NORM_DAYS) continue;
      const span = hi[i] - lo[i];
      v[i] = span > 0 ? (xi - lo[i]) / span : 0.5;
    }
    value[k] = v;
    normDays[k] = nd;
  }
  return { value, normDays };
}

/* ── TRAJECTORY：窓 [e−w+1, e] の道のり（窓の中だけで決まる） ── */
let scratch = new Float64Array(64);
export function trajectory(tl, k, e, w, out = new Float64Array(w)) {
  const s = e - w + 1;
  out.fill(NaN);
  if (s < 0 || e >= tl.n) return out;
  const x = tl.axes[k];
  if (k === "price") {
    const base = x[s];
    if (!(base > 0)) return out;
    for (let t = 0; t < w; t++) out[t] = x[s + t] / base - 1;
  } else if (k === "volume") {
    // log(V(t) / 窓の中央値)。中央値は log の空間で取る
    const lv = tl.logVol;
    if (scratch.length < w) scratch = new Float64Array(w * 2);
    let m = 0;
    for (let t = 0; t < w; t++) { const v = lv[s + t]; if (!Number.isNaN(v)) scratch[m++] = v; }
    if (!m) return out;
    const sub = scratch.subarray(0, m).sort();
    const med = m % 2 ? sub[m >> 1] : (sub[(m >> 1) - 1] + sub[m >> 1]) / 2;
    for (let t = 0; t < w; t++) out[t] = lv[s + t] - med;
  } else if (k === "volatility") {
    for (let t = 0; t < w; t++) out[t] = x[s + t];
  } else if (k === "sentiment") {
    const base = x[s];
    if (Number.isNaN(base)) return out;
    for (let t = 0; t < w; t++) out[t] = x[s + t] - base;
  }
  return out;
}

/* ── ある窓で、どの軸が観測できるか（UI の ABSENT 判定と同じもの） ── */
export function axisPresence(tl, st, mode, e, w) {
  const need = Math.ceil(MIN_SHARE * w);
  const res = {};
  const list = mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES;
  for (const k of AXES) {
    if (!list.includes(k)) { res[k] = "unused"; continue; }
    let cnt = 0;
    if (mode === "TRAJECTORY") {
      const tr = trajectory(tl, k, e, w);
      for (let t = 0; t < w; t++) if (!Number.isNaN(tr[t])) cnt++;
    } else {
      for (let t = 0; t < w; t++) { const i = e - t; if (i >= 0 && !Number.isNaN(st.value[k][i])) cnt++; }
    }
    res[k] = cnt >= need && cnt > 0 ? "on" : "absent";
  }
  return res;
}

/* ── 似ている度合い（1 = 同じ、0 = まったく別）──
   使えた軸と、その軸ごとの距離も返す（何で似ていると言ったのかを見えるように） */
function stateDistance(st, q, c, w, axes, weights) {
  const need = Math.ceil(MIN_SHARE * w);
  let sw = 0, sd = 0;
  const used = {};
  for (const k of axes) {
    const a = st.value[k];
    let sum = 0, cnt = 0;
    for (let t = 0; t < w; t++) {
      if (q - t < 0 || c - t < 0) continue;
      const x = a[q - t], y = a[c - t];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      sum += Math.abs(x - y);
      cnt++;
    }
    if (cnt < need || cnt === 0) continue;
    const d = sum / cnt;
    const wt = weights[k] ?? 1;
    if (wt <= 0) continue;
    used[k] = d;
    sw += wt;
    sd += wt * d;
  }
  return sw > 0 ? { d: sd / sw, used, sw } : null;
}

function trajDistance(qTraj, tl, c, w, axes, weights, buf) {
  const need = Math.ceil(MIN_SHARE * w);
  let sw = 0, sd = 0;
  const used = {};
  for (const k of axes) {
    const qa = qTraj[k];
    const ca = trajectory(tl, k, c, w, buf);
    let sum = 0, cnt = 0;
    for (let t = 0; t < w; t++) {
      const x = qa[t], y = ca[t];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      sum += Math.abs(x - y);
      cnt++;
    }
    if (cnt < need || cnt === 0) continue;
    const d = Math.min(1, sum / cnt / TRAJ_SCALE[k]);
    const wt = weights[k] ?? 1;
    if (wt <= 0) continue;
    used[k] = d;
    sw += wt;
    sd += wt * d;
  }
  return sw > 0 ? { d: sd / sw, used, sw } : null;
}

/* STATE の coverage：使った軸のうち、正規化に使えた過去が一番短かった日数 */
function stateCoverage(st, e, w, usedAxes) {
  let min = Infinity;
  for (const k of usedAxes) {
    const nd = st.normDays[k];
    if (!nd) continue;
    for (let t = 0; t < w; t++) { const i = e - t; if (i >= 0) min = Math.min(min, nd[i]); }
  }
  return Number.isFinite(min) ? min : null;
}

/* ── 似た過去を探す（STRICT）──
   opts: { day | index, mode: "STATE"|"TRAJECTORY", width, axes: {k: true/false}, weights: {k: n}, top, horizon } */
export function search(tl, st, opts) {
  const mode = opts.mode === "TRAJECTORY" ? "TRAJECTORY" : "STATE";
  const w = Math.max(mode === "TRAJECTORY" ? 2 : 1, Math.floor(opts.width || 7));
  const H = opts.horizon ?? HORIZON;
  const top = opts.top ?? 5;
  const q = opts.index ?? indexOf(tl, opts.day);
  const weights = opts.weights || {};
  const list = mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES;
  const presence = axisPresence(tl, st, mode, q, w);
  const wanted = list.filter((k) => (opts.axes ? opts.axes[k] !== false : true));
  const axes = wanted.filter((k) => presence[k] === "on" && (weights[k] ?? 1) > 0);
  const totalWeight = axes.reduce((s, k) => s + (weights[k] ?? 1), 0);

  const base = {
    query: { day: dayAt(tl, q), index: q, window: [dayAt(tl, q - w + 1), dayAt(tl, q)] },
    mode, width: w, horizon: H, axes_used_for_query: axes, presence,
    strict: { rule: "candidate_end + horizon <= D", last_candidate_end: dayAt(tl, q - H) },
    rule: { min_weight_share: MIN_WEIGHT_SHARE },
  };
  if (q < 0 || q >= tl.n) return { ...base, error: "that day is outside the archive", results: [], candidates: 0, searched: 0, excluded: 0 };
  if (!axes.length) return { ...base, error: "no axis can be observed for this window", results: [], candidates: 0, searched: 0, excluded: 0 };

  let qTraj = null;
  if (mode === "TRAJECTORY") {
    qTraj = {};
    for (const k of axes) qTraj[k] = trajectory(tl, k, q, w);
  }

  // STRICT の範囲の窓はすべて調べる（searched）。
  // D で比べられる軸の重みのうち、半分未満しか比べられない過去は外して数える（excluded）。
  // 1軸だけで比べた過去が、8軸で比べた過去と同じ順位表に並ばないように（2026-09-26、ノヴァと決定）
  const scored = [];
  const buf = new Float64Array(w);
  const lastEnd = q - H;
  let searched = 0, excluded = 0;
  for (let c = w - 1; c <= lastEnd; c++) {
    searched++;
    const r = mode === "TRAJECTORY"
      ? trajDistance(qTraj, tl, c, w, axes, weights, buf)
      : stateDistance(st, q, c, w, axes, weights);
    if (!r || r.sw + 1e-9 < MIN_WEIGHT_SHARE * totalWeight) { excluded++; continue; }
    scored.push({ c, d: r.d, used: r.used });
  }
  scored.sort((a, b) => a.d - b.d || b.c - a.c);

  // 同じ出来事を何回も覗かないように、選んだ日の近く（max(w,30) 日以内）は飛ばす
  // （2026-09-27、ノヴァ：7日 → 30日。「季節ごとに1つ」まではしない。同じ局面が長く続いたなら、それも観測として残す）
  const gap = Math.max(w, PICK_GAP_DAYS);
  const picked = [];
  for (const s of scored) {
    if (picked.some((p) => Math.abs(p.c - s.c) < gap)) continue;
    picked.push(s);
    if (picked.length >= top) break;
  }

  const results = picked.map((p) => {
    const usedAxes = Object.keys(p.used);
    const out = {
      day: dayAt(tl, p.c),
      index: p.c,
      window: [dayAt(tl, p.c - w + 1), dayAt(tl, p.c)],
      similarity: Math.round((1 - p.d) * 1000) / 1000,
      axes: Object.fromEntries(usedAxes.map((k) => [k, Math.round((1 - p.used[k]) * 1000) / 1000])),
    };
    if (mode === "STATE") {
      out.coverage_days = { candidate: stateCoverage(st, p.c, w, usedAxes), query: stateCoverage(st, q, w, usedAxes) };
    }
    return out;
  });
  return { ...base, searched, excluded, candidates: scored.length, results };
}

/* ── リプレイ：出来事の日（i）を 0 として、−7d … +30d に何が起きたか ──
   limit より後の日は見せない（STRICT：D 自身のその後は「まだ誰も知らない」） */
export function replay(tl, i, limit) {
  const p0 = tl.axes.price[i];
  const points = REPLAY_OFFSETS.map((o) => {
    const j = i + o;
    const day = dayAt(tl, j);
    if (j > limit) return { offset: o, day, state: "unknown" }; // 倉庫の最後の日より先も「まだ誰も知らない」
    if (j < 0 || j >= tl.n) return { offset: o, day, state: "outside" };
    const p = tl.axes.price[j];
    return {
      offset: o, day, state: "seen",
      price: Number.isNaN(p) ? null : p,
      change: Number.isNaN(p) || !(p0 > 0) ? null : p / p0 - 1,
      sentiment: Number.isNaN(tl.axes.sentiment[j]) ? null : tl.axes.sentiment[j],
      volatility: Number.isNaN(tl.axes.volatility[j]) ? null : tl.axes.volatility[j],
    };
  });
  // グラフ用：毎日の価格（出来事の日を 0 とした変化率）
  const lo = REPLAY_OFFSETS[0], hi = REPLAY_OFFSETS[REPLAY_OFFSETS.length - 1];
  const path = [];
  for (let o = lo; o <= hi; o++) {
    const j = i + o;
    if (j < 0 || j >= tl.n || j > limit) { path.push(null); continue; }
    const p = tl.axes.price[j];
    path.push(Number.isNaN(p) || !(p0 > 0) ? null : p / p0 - 1);
  }
  return { event: dayAt(tl, i), points, path, from: lo, to: hi };
}

/* ──────────────────────────────────────────
   ほかの窓（数字の窓）を、同じ STATE のやり方で比べる（2026-09-27）
   ・窓の値は「その日に起きた分」。D 00:00 に見えていたのは D − lag の分まで。
     だから i 日目に置く値は、窓の (i − lag) 日目の値（asOfColumn）
   ・STATE = 過去1年（その時点で見えていた分だけ）の中の位置。30日未満なら ABSENT
   ・似ている度合い = 1 − 窓の日ごとの差の平均（STATE と同じ。8割以上そろった成分だけ使う）
   CMC の探し方には混ぜない。窓ごとに別々に「その窓から見て似ているか」を出す
   ────────────────────────────────────────── */
export function asOfColumn(tl, from, values, lag, map = (x) => x) {
  const out = new Float64Array(tl.n).fill(NaN);
  if (!values || !values.length) return out;
  const off = dayNum(from) - tl.d0; // 窓の 0 番目が、倉庫の何日目か
  for (let i = 0; i < tl.n; i++) {
    const j = i - lag - off;
    if (j < 0 || j >= values.length) continue;
    const v = values[j];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const m = map(v);
    if (Number.isFinite(m)) out[i] = m;
  }
  return out;
}
export function rangeState(x) {
  const n = x.length;
  const { lo, hi, cnt } = rollingRange(x, NORM_DAYS);
  const v = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    if (Number.isNaN(xi) || cnt[i] < MIN_NORM_DAYS) continue;
    const span = hi[i] - lo[i];
    v[i] = span > 0 ? (xi - lo[i]) / span : 0.5;
  }
  return v;
}
/* 7日平均（5日以上そろっている日だけ）。ハッシュレートのように1日ごとにぶれる値に */
export function mean7(values) {
  const out = new Array(values.length).fill(null);
  for (let j = 0; j < values.length; j++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, j - 6); k <= j; k++) { const v = values[k]; if (typeof v === "number" && Number.isFinite(v)) { s += v; c++; } }
    if (c >= 5 && typeof values[j] === "number") out[j] = s / c;
  }
  return out;
}
export function windowSimilarity(comps, q, c, w) {
  const need = Math.ceil(MIN_SHARE * w);
  let sd = 0, used = 0;
  for (const a of comps) {
    let sum = 0, cnt = 0;
    for (let t = 0; t < w; t++) {
      if (q - t < 0 || c - t < 0) continue;
      const x = a[q - t], y = a[c - t];
      if (Number.isNaN(x) || Number.isNaN(y)) continue;
      sum += Math.abs(x - y);
      cnt++;
    }
    if (cnt >= need && cnt > 0) { sd += sum / cnt; used++; }
  }
  if (!used) return null;
  return { similarity: Math.round((1 - sd / used) * 1000) / 1000, used, of: comps.length };
}

/* まとめて使う入口 */
export function createExplorer(series) {
  const tl = buildTimeline(series);
  const st = buildStates(tl);
  return {
    tl, st,
    first: tl.first, last: tl.last,
    presence: (day, mode, width) => axisPresence(tl, st, mode, indexOf(tl, day), width),
    search: (opts) => search(tl, st, opts),
    replay: (day, limitDay) => replay(tl, indexOf(tl, day), indexOf(tl, limitDay)),
  };
}
