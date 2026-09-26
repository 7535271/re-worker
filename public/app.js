/* RE: — the page. Reads /series once, then every observation is computed here in the browser. */
import { createExplorer, AXES, STATE_AXES, TRAJ_AXES, WIDTHS, HORIZON, REPLAY_OFFSETS, dayNum, ymdOf } from "./engine.js";

const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";

const LABEL = {
  price: "Price", volume: "Volume", market_cap: "Market cap", volatility: "Volatility",
  change_24h: "24h change", change_7d: "7d change", change_30d: "30d change",
  sentiment: "Fear & Greed", attention: "Attention",
};
const ABSENT_WHY = {
  sentiment: "Fear & Greed has no value for this window (the index starts on 2023-06-29, and new days reach CMC's history with a delay).",
  attention: "Attention has no source connected yet.",
};
const MODE_HINT = {
  STATE: "Where each axis stood within its own past year, as seen on each day of the window.",
  TRAJECTORY: "How price, volume, volatility and Fear & Greed moved inside the window, from its first day.",
};

const S = { day: null, mode: "STATE", width: 7, off: new Set(), sel: 0 };
let ex = null, meta = {}, res = null, view = null;

/* ── formatting ── */
const MINUS = "−";
function pct(v, digits = 1) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = Math.abs(v * 100).toFixed(digits);
  if (Number(s) === 0) return (0).toFixed(digits) + "%";
  return (v > 0 ? "+" : MINUS) + s + "%";
}
function usd(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  if (v >= 1000) return "$" + Math.round(v).toLocaleString("en-US");
  if (v >= 1) return "$" + v.toFixed(2);
  return "$" + v.toPrecision(3);
}
const int = (n) => Number(n).toLocaleString("en-US");
const shortDay = (d) => d; // ISO dates read the same everywhere

function el(tag, attrs = {}, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  if (text !== undefined) e.textContent = text;
  return e;
}
/* 日付（YYYY-MM-DD）は行の途中で折り返さない */
function textWithDates(tag, attrs, text) {
  const e = el(tag, attrs);
  let last = 0;
  for (const m of text.matchAll(/\d{4}-\d{2}-\d{2}/g)) {
    if (m.index > last) e.append(document.createTextNode(text.slice(last, m.index)));
    e.append(el("span", { style: "white-space:nowrap" }, m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) e.append(document.createTextNode(text.slice(last)));
  return e;
}
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ── the URL remembers the observation (so a view can be shared or reopened) ── */
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  const d = h.get("d");
  if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) S.day = d;
  if (h.get("m") === "TRAJECTORY" || h.get("m") === "STATE") S.mode = h.get("m");
  const w = Number(h.get("w"));
  if (WIDTHS.includes(w)) S.width = w;
  for (const k of (h.get("off") || "").split(",")) if (AXES.includes(k)) S.off.add(k);
  const s = Number(h.get("s"));
  if (Number.isInteger(s) && s >= 0 && s < 5) S.sel = s;
}
function writeHash() {
  const parts = [`d=${S.day}`, `m=${S.mode}`, `w=${S.width}`];
  if (S.off.size) parts.push(`off=${[...S.off].join(",")}`);
  if (S.sel) parts.push(`s=${S.sel}`);
  history.replaceState(null, "", "#" + parts.join("&"));
}

/* ── start ── */
async function boot() {
  readHash();
  let series;
  try {
    const r = await fetch("/series?id=1", { cache: "no-store" });
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error((body && body.error) || `HTTP ${r.status}`);
    series = body;
    ex = createExplorer(series);
  } catch (e) {
    const st = $("status");
    st.textContent = "";
    st.append(el("div", { class: "error" },
      `The archive could not be loaded yet (${e.message}). It fills itself every hour; progress is at /archive/status.`));
    return;
  }
  meta = series.meta || {};
  $("day").min = ex.first;
  $("day").max = ex.last;
  if (!S.day || S.day < ex.first || S.day > ex.last) S.day = ex.last;
  setupControls();
  renderFooter();
  run();
  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => view && drawChart(), 120); });
}

function setupControls() {
  const wbox = $("width");
  for (const w of WIDTHS) {
    const b = el("button", { type: "button", "data-w": w, "aria-label": `${w}-day window` }, `${w}d`);
    b.addEventListener("click", () => { S.width = w; S.sel = 0; run(); });
    wbox.append(b);
  }
  for (const b of $("mode").querySelectorAll("button")) {
    b.addEventListener("click", () => { S.mode = b.dataset.mode; S.sel = 0; run(); });
  }
  $("day").addEventListener("change", (e) => {
    const v = e.target.value;
    if (!v) return;
    S.day = v < ex.first ? ex.first : v > ex.last ? ex.last : v;
    S.sel = 0;
    run();
  });
  $("latest").addEventListener("click", () => { S.day = ex.last; S.sel = 0; run(); });
  const svgEl = $("chart");
  svgEl.addEventListener("pointerdown", (e) => pointAt(e));
  svgEl.addEventListener("pointermove", (e) => pointAt(e));
  svgEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTip(); });
  svgEl.addEventListener("keydown", (e) => {
    if (!view) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const cur = view.cursor ?? 0;
      showAt(Math.max(view.lo, Math.min(view.hi, cur + (e.key === "ArrowLeft" ? -1 : 1))));
    } else if (e.key === "Escape") hideTip();
  });
  svgEl.addEventListener("blur", hideTip);
}

/* ── one observation ── */
function run() {
  if (S.mode === "TRAJECTORY" && S.width < 2) S.width = 7;
  const axes = {};
  for (const k of AXES) axes[k] = !S.off.has(k);
  res = ex.search({ day: S.day, mode: S.mode, width: S.width, axes, top: 5 });
  if (S.sel >= res.results.length) S.sel = 0;
  renderControls();
  renderStatus();
  renderResults();
  renderReplay();
  writeHash();
}

function renderControls() {
  $("day").value = S.day;
  for (const b of $("width").querySelectorAll("button")) {
    const w = Number(b.dataset.w);
    b.setAttribute("aria-pressed", String(w === S.width));
    b.disabled = S.mode === "TRAJECTORY" && w < 2;
  }
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
  $("mode-hint").textContent = MODE_HINT[S.mode];

  const box = $("chips");
  box.textContent = "";
  const list = S.mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES;
  for (const k of list) {
    const absent = res.presence[k] === "absent";
    const state = absent ? "absent" : S.off.has(k) ? "off" : "on";
    const b = el("button", {
      type: "button", class: "chip", "data-state": state,
      "aria-pressed": absent ? undefined : String(state === "on"),
      "aria-disabled": absent ? "true" : undefined,
      title: absent ? (ABSENT_WHY[k] || `${LABEL[k]} has no data for this window.`) : `Tap to turn ${state === "on" ? "off" : "on"}`,
    });
    b.append(el("span", { class: "mark", "aria-hidden": "true" }, state === "on" ? "●" : state === "off" ? "○" : "–"), document.createTextNode(LABEL[k]));
    if (!absent) b.addEventListener("click", () => { S.off.has(k) ? S.off.delete(k) : S.off.add(k); S.sel = 0; run(); });
    box.append(b);
  }
  // title は iPhone では出ないので、ABSENT の理由は文字で出す
  const why = $("absent-why");
  why.textContent = "";
  for (const k of list) {
    if (res.presence[k] !== "absent") continue;
    let reason;
    if (k === "attention") reason = "no source connected yet";
    else if (k === "sentiment") {
      const from = meta.fng_from || "2023-06-29";
      const lastF = (meta.last_on || {}).sentiment;
      if (S.day < from) reason = `the index starts on ${from}`;
      else if (lastF && S.day > lastF) reason = `the value for ${S.day} is not in CMC's history yet (new days arrive there with a delay)`;
      else reason = "not enough values in this window";
    } else reason = "less than 30 days of past to scale it, or no values in this window";
    why.append(el("div", {}, `– ${LABEL[k]}: ${reason}`));
  }
}

function renderStatus() {
  const st = $("status");
  st.textContent = "";
  const q = ex.tl.axes.price[dayNum(S.day) - ex.tl.d0];
  const head = el("div");
  head.append(el("strong", {}, `D = ${S.day}`), document.createTextNode(` · BTC ${usd(q)}`));
  st.append(head);
  if (res.error) {
    const why = res.error === "no axis can be observed for this window"
      ? (S.off.size ? "No axis is left to compare — turn one back on." : "Too little past before this day to observe anything yet.")
      : res.error;
    st.append(el("div", { class: "error", style: "margin-top:8px" }, why));
    return;
  }
  const n = res.candidates;
  if (!res.searched) {
    st.append(textWithDates("div", {}, `No past window ended by ${res.strict.last_candidate_end} (D − ${HORIZON} days). The archive starts on ${ex.first}; a past only counts if its ${HORIZON}-day replay had already happened on D.`));
  } else {
    st.append(textWithDates("div", {}, `Searched ${int(res.searched)} past windows that ended by ${res.strict.last_candidate_end} (D − ${HORIZON} days), so each replay below had already happened on D.`));
    if (res.excluded) {
      st.append(textWithDates("div", {}, `${int(n)} compared · ${int(res.excluded)} left out: less than half of D's axes (by weight) could be compared there.`));
    }
  }
  if (n > 0 && n < 365) st.append(el("div", { class: "note" }, "A small past: few windows could be compared before this day. That is part of what RE: observes here."));
  if (meta.complete === false && meta.missing_years && meta.missing_years.length) {
    st.append(textWithDates("div", { class: "note" }, `The archive is still filling (missing: ${meta.missing_years.join(", ")}). Results use what is stored so far.`));
  }
}

function coverageNote(r) {
  if (!r.coverage_days) return null;
  const parts = [];
  if (r.coverage_days.candidate !== null && r.coverage_days.candidate < 365) parts.push(`this past: ${r.coverage_days.candidate} days`);
  if (r.coverage_days.query !== null && r.coverage_days.query < 365) parts.push(`D: ${r.coverage_days.query} days`);
  return parts.length ? `scaled on less than a year (${parts.join(", ")})` : null;
}

function renderResults() {
  const box = $("results");
  box.textContent = "";
  if (!res.results.length) {
    box.append(el("p", { class: "note" }, res.error ? "Nothing to compare for these conditions."
      : res.searched ? "Every past window was left out: none had at least half of D's axes to compare." : "No past window could be compared under these conditions."));
    return;
  }
  res.results.forEach((r, i) => {
    const b = el("button", { type: "button", class: "result", "aria-pressed": String(i === S.sel), "aria-label": `Similar past ${i + 1}: window ending ${r.day}, similarity ${r.similarity}` });
    b.append(
      el("i", { class: "key", "aria-hidden": "true" }),
      el("span", { class: "when" }, `${i + 1}. ${r.day}`),
      el("span", { class: "sim" }, r.similarity.toFixed(3)),
    );
    const metaRow = el("span", { class: "meta" });
    const m = el("span", { class: "meter", "aria-hidden": "true" });
    m.append(el("i", { style: `width:${Math.max(0, Math.min(1, r.similarity)) * 100}%` }));
    metaRow.append(m, document.createTextNode(S.width > 1 ? `${r.window[0]} → ${r.window[1]}` : "1-day window"));
    const cov = coverageNote(r);
    b.append(metaRow);
    if (cov) b.append(el("span", { class: "meta" }, cov));
    b.addEventListener("click", () => {
      S.sel = i;
      renderResults();
      renderReplay();
      writeHash();
      $("replay").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    box.append(b);
  });
}

/* ── replay: chart, checkpoint table, why ── */
function renderReplay() {
  const picker = $("picker");
  picker.textContent = "";
  picker.style.display = res.results.length > 1 ? "" : "none";
  res.results.forEach((r, i) => {
    const b = el("button", { type: "button", "aria-pressed": String(i === S.sel), "aria-label": `Replay similar past ${i + 1}, ${r.day}` }, String(i + 1));
    b.addEventListener("click", () => { S.sel = i; renderResults(); renderReplay(); writeHash(); });
    picker.append(b);
  });

  const r = res.results[S.sel] || null;
  const D = ex.replay(S.day, S.day);
  const series = [];
  res.results.forEach((x, i) => {
    if (i === S.sel) return;
    series.push({ kind: "context", name: `${i + 1}. ${x.day}`, rep: ex.replay(x.day, S.day) });
  });
  const selRep = r ? ex.replay(r.day, S.day) : null;
  series.push({ kind: "d", name: `D · ${S.day}`, rep: D });
  if (r) series.push({ kind: "sel", name: `${S.sel + 1}. ${r.day}`, rep: selRep });
  view = { series, lo: REPLAY_OFFSETS[0], hi: REPLAY_OFFSETS[REPLAY_OFFSETS.length - 1], cursor: null };

  const lg = $("legend");
  lg.textContent = "";
  const key = (color, text) => { const s = el("span"); s.append(el("i", { style: `background:var(${color})` }), document.createTextNode(text)); return s; };
  lg.append(key("--series-d", `D · ${S.day}`));
  if (r) lg.append(key("--series-sel", `Similar past ${S.sel + 1} · ${r.day}`));
  if (res.results.length > 1) lg.append(key("--context", "Other similar pasts"));

  drawChart();
  renderTable(D, selRep, r);
  renderWhy(r);
  renderWorld(r);
}

/* ── the world that day: other windows onto the chosen past's event day (/scene) ── */
const scenes = new Map(); // day → Promise<body>
let worldToken = 0;
function loadScene(day) {
  if (!scenes.has(day)) {
    const p = fetch(`/scene?day=${day}`).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.windows) throw new Error((body && body.error) || `HTTP ${r.status}`);
      return body;
    });
    p.catch(() => scenes.delete(day)); // a failure is not remembered: the next look tries again
    scenes.set(day, p);
  }
  return scenes.get(day);
}
function safeHref(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}
function link(href, text) {
  const h = safeHref(href);
  return h ? el("a", { href: h, target: "_blank", rel: "noopener noreferrer" }, text) : el("span", {}, text);
}
function winBox(title, when) {
  const box = el("div", { class: "win" });
  const h = el("h3");
  h.append(el("span", {}, title));
  if (when) h.append(el("span", { class: "when" }, when));
  box.append(h);
  return box;
}
function listOf(items, text, num) {
  const ol = el("ol");
  for (const it of items) {
    const li = el("li");
    li.append(link(it.url, text(it)), el("span", { class: "n" }, num(it)));
    ol.append(li);
  }
  return ol;
}
function absentLine(w) {
  return el("p", { class: "absent" }, `– ${w.reason || "no data for this day"}`);
}

async function renderWorld(r) {
  const card = $("world");
  card.style.display = r ? "" : "none";
  if (!r) return;
  const token = ++worldToken;
  const head = $("world-day");
  head.textContent = "";
  head.append(el("span", { class: "k", style: "background:var(--series-sel)" }), textWithDates("span", {}, `Similar past ${S.sel + 1} · event day ${r.day}`));
  const box = $("world-body");
  box.textContent = "";
  box.append(el("p", { class: "note" }, "Looking through other windows…"));
  box.classList.add("loading");
  let sc;
  try { sc = await loadScene(r.day); } catch (e) {
    if (token !== worldToken) return;
    box.classList.remove("loading");
    box.textContent = "";
    box.append(el("p", { class: "note" }, `The other windows could not be reached this time (${e.message}). Choosing this past again will retry.`));
    return;
  }
  if (token !== worldToken) return; // the choice changed while this was loading
  box.classList.remove("loading");
  box.textContent = "";
  const w = sc.windows;

  const wiki = (key, title, n) => {
    const x = w[key], b = winBox(title, x && x.state === "on" ? "most read · a day later" : null);
    if (!x || x.state !== "on") b.append(absentLine(x || {}));
    else if (!x.items.length) b.append(absentLine({ reason: "no pages listed" }));
    else b.append(listOf(x.items.slice(0, n), (i) => i.title, (i) => int(i.views)));
    return b;
  };
  box.append(wiki("wikipedia_en", "Wikipedia · English", 5));

  const hn = w.hacker_news, bh = winBox("Hacker News", hn && hn.state === "on" ? "top stories · points today" : null);
  if (!hn || hn.state !== "on") bh.append(absentLine(hn || {}));
  else if (!hn.items.length) bh.append(absentLine({ reason: "no stories that day" }));
  else bh.append(listOf(hn.items.slice(0, 3), (i) => i.title, (i) => `${int(i.points)} pts`));
  box.append(bh);

  const ap = w.apod, ba = winBox("NASA · Picture of the Day", null);
  if (!ap || ap.state !== "on") ba.append(absentLine(ap || {}));
  else {
    const p = el("p", { class: "one" });
    p.append(link(ap.page_url, ap.title || "(untitled)"));
    ba.append(p);
    if (ap.credit) ba.append(el("p", { class: "sub" }, ap.credit));
  }
  box.append(ba);

  const q = w.earthquakes, bq = winBox("Earthquakes · M4.5+", q && q.revised_later ? "revised later" : null);
  if (!q || q.state !== "on") bq.append(absentLine(q || {}));
  else {
    bq.append(el("p", { class: "one" }, q.count_m45 === null ? "count unavailable" : `${int(q.count_m45)} on this UTC day`));
    const big = (q.biggest || [])[0];
    if (big) bq.append(el("p", { class: "sub" }, `Largest: M${Number(big.mag).toFixed(1)} · ${big.place || "unnamed place"}`));
  }
  box.append(bq);

  const fx = w.fx, bf = winBox("Exchange rates · ECB", null);
  if (!fx || fx.state !== "on") bf.append(absentLine(fx || {}));
  else {
    const f = (v, d) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
    bf.append(el("p", { class: "one" }, `1 USD = ${f(fx.usd_jpy, 2)} JPY · ${f(fx.usd_eur, 4)} EUR`));
    if (fx.note) bf.append(textWithDates("p", { class: "sub" }, fx.note));
  }
  box.append(bf);

  box.append(wiki("wikipedia_ja", "Wikipedia · 日本語", 3));

  const x = w.x, bx = winBox("X", "a door, not data");
  if (x && x.url) {
    const a = link(x.url, "Search X for “bitcoin” that day ↗");
    a.className = "door";
    bx.append(a);
  }
  box.append(bx);
}

function niceTicks(lo, hi, count = 4) {
  const span = hi - lo || 0.02;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const f = raw / mag;
  const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { ticks: out, step };
}

function drawChart() {
  const svgEl = $("chart");
  const W = Math.max(280, Math.round(svgEl.getBoundingClientRect().width) || 360);
  const H = 230;
  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.textContent = "";
  const m = { l: 44, r: 56, t: 22, b: 28 };
  const { lo, hi, series } = view;
  let ymin = 0, ymax = 0;
  for (const s of series) for (const v of s.rep.path) if (v !== null) { ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
  if (ymax - ymin < 0.02) { ymin -= 0.01; ymax += 0.01; }
  const pad = (ymax - ymin) * 0.08;
  const { ticks, step } = niceTicks(ymin - pad, ymax + pad, 4);
  const y0 = Math.min(ticks[0], ymin - pad), y1 = Math.max(ticks[ticks.length - 1], ymax + pad);
  const X = (o) => m.l + ((o - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0)) * (H - m.t - m.b);
  view.X = X; view.Y = Y; view.W = W; view.H = H; view.m = m;

  const g = svg("g");
  svgEl.append(g); // 先に入れておく（文字の幅を測れるように）
  // grid + y ticks
  const digits = step < 0.01 ? 1 : 0;
  for (const t of ticks) {
    if (t < y0 - 1e-12 || t > y1 + 1e-12) continue;
    g.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
    g.append(svg("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)", style: "font-variant-numeric:tabular-nums" }, pct(t, digits)));
  }
  // x ticks
  for (const o of [-7, 0, 7, 14, 30]) {
    g.append(svg("text", { x: X(o), y: H - 8, "text-anchor": "middle", "font-size": 11, fill: o === 0 ? "var(--ink-2)" : "var(--muted)", "font-weight": o === 0 ? 700 : 400 },
      o === 0 ? "EVENT" : (o > 0 ? `+${o}d` : `${MINUS}${-o}d`)));
  }
  // the event line and D's unknown future
  g.append(svg("line", { x1: X(0), x2: X(0), y1: m.t - 6, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
  g.append(svg("text", { x: X(0) + 6, y: m.t - 8, "font-size": 11, fill: "var(--muted)" }, "after D: not yet known on D"));

  const lineOf = (vals) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v === null) { pen = false; return; }
      d += (pen ? "L" : "M") + X(lo + i).toFixed(1) + "," + Y(v).toFixed(1);
      pen = true;
    });
    return d;
  };
  const color = { context: "var(--context)", d: "var(--series-d)", sel: "var(--series-sel)" };
  for (const kind of ["context", "d", "sel"]) {
    for (const s of series.filter((x) => x.kind === kind)) {
      g.append(svg("path", { d: lineOf(s.rep.path), fill: "none", stroke: color[kind], "stroke-width": kind === "context" ? 1.5 : 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
    }
  }
  // end dots + selective direct labels (D at the event, the chosen past at +30d)
  const dS = series.find((s) => s.kind === "d");
  const dot = (x, y, c) => g.append(svg("circle", { cx: x, cy: y, r: 4, fill: c, stroke: "var(--surface)", "stroke-width": 2 }));
  const d0 = dS.rep.path[-lo];
  if (d0 !== null) {
    dot(X(0), Y(d0), "var(--series-d)");
    g.append(svg("text", { x: X(0) - 8, y: Y(d0) - 8, "text-anchor": "end", "font-size": 12, "font-weight": 700, fill: "var(--ink)" }, "D"));
  }
  const sS = series.find((s) => s.kind === "sel");
  if (sS) {
    let j = sS.rep.path.length - 1;
    while (j >= 0 && sS.rep.path[j] === null) j--;
    if (j >= 0) {
      const v = sS.rep.path[j];
      dot(X(lo + j), Y(v), "var(--series-sel)");
      const t = svg("text", { x: X(lo + j) + 8, y: Y(v) + 4, "font-size": 12, "font-weight": 700, fill: "var(--ink)", style: "font-variant-numeric:tabular-nums" }, pct(v));
      g.append(t);
      // 幅は実際に測る（端末ごとにフォントが違う）。はみ出すなら点の左上に置く
      let len = 0;
      try { len = t.getComputedTextLength(); } catch { len = 0; }
      if (!len || X(lo + j) + 8 + len > W - 2) {
        t.setAttribute("x", X(lo + j) - 2);
        t.setAttribute("y", Y(v) - 10);
        t.setAttribute("text-anchor", "end");
      }
    }
  }
  view.cursorLayer = svg("g");
  svgEl.append(view.cursorLayer);
  svgEl.setAttribute("aria-label", `Replay chart: price change from the event day, ${MINUS}7 to +30 days. D is ${S.day}${sS ? `; the chosen similar past is ${sS.name}` : ""}. The table below lists the same checkpoints.`);
  if (view.cursor !== null && view.cursor !== undefined) showAt(view.cursor);
}

function pointAt(e) {
  if (!view || !view.X) return;
  const rect = $("chart").getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * view.W;
  const o = Math.round(view.lo + ((x - view.m.l) / (view.W - view.m.l - view.m.r)) * (view.hi - view.lo));
  showAt(Math.max(view.lo, Math.min(view.hi, o)));
}

function showAt(o) {
  view.cursor = o;
  const L = view.cursorLayer;
  L.textContent = "";
  const x = view.X(o);
  L.append(svg("line", { x1: x, x2: x, y1: view.m.t - 6, y2: view.H - view.m.b, stroke: "var(--muted)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
  const order = [...view.series].sort((a, b) => ({ sel: 0, d: 1, context: 2 }[a.kind] - { sel: 0, d: 1, context: 2 }[b.kind]));
  const color = { context: "var(--context)", d: "var(--series-d)", sel: "var(--series-sel)" };
  const tip = $("tip");
  tip.textContent = "";
  tip.append(el("div", { class: "t" }, o === 0 ? "Event day" : `${o > 0 ? "+" : MINUS}${Math.abs(o)} days from the event`));
  for (const s of order) {
    const v = s.rep.path[o - view.lo];
    if (v !== null) L.append(svg("circle", { cx: x, cy: view.Y(v), r: s.kind === "context" ? 3 : 4, fill: color[s.kind], stroke: "var(--surface)", "stroke-width": 2 }));
    const row = el("div", { class: "r" });
    const day = ymdOf(dayNum(s.rep.event) + o);
    row.append(el("i", { style: `background:${color[s.kind]}` }), el("b", {}, v === null ? (s.kind === "d" && o > 0 ? "unknown" : "—") : pct(v)),
      el("span", {}, s.kind === "d" ? `D · ${day}` : `${s.name.split(".")[0]}. ${day}`));
    tip.append(row);
  }
  tip.style.display = "block";
  const wrap = $("chart").getBoundingClientRect();
  const px = (x / view.W) * wrap.width;
  const tw = tip.offsetWidth;
  tip.style.left = (px + 12 + tw < wrap.width ? px + 12 : Math.max(0, px - 12 - tw)) + "px";
}
function hideTip() {
  if (!view) return;
  view.cursor = null;
  if (view.cursorLayer) view.cursorLayer.textContent = "";
  $("tip").style.display = "none";
}

function renderTable(D, selRep, r) {
  const t = $("table");
  t.textContent = "";
  const thead = el("thead"), tr = el("tr");
  tr.append(el("th", { scope: "col" }, "Day"));
  const hD = el("th", { scope: "col" });
  hD.append(el("span", { class: "k", style: "background:var(--series-d)" }), document.createTextNode(`D · ${S.day}`));
  tr.append(hD);
  if (r) {
    const hS = el("th", { scope: "col" });
    hS.append(el("span", { class: "k", style: "background:var(--series-sel)" }), document.createTextNode(`${S.sel + 1}. ${r.day}`));
    tr.append(hS);
  }
  thead.append(tr);
  const tbody = el("tbody");
  REPLAY_OFFSETS.forEach((o, i) => {
    const row = el("tr", { class: o === 0 ? "event" : undefined });
    row.append(el("th", { scope: "row", style: "text-align:left;font-weight:inherit" }, o === 0 ? "EVENT" : `${o > 0 ? "+" : MINUS}${Math.abs(o)}d`));
    const cell = (p) => {
      if (p.state === "unknown") return el("td", { class: "unknown", title: "Not yet known on D" }, "?");
      if (p.state !== "seen") return el("td", { class: "unknown" }, "—");
      return el("td", {}, o === 0 ? usd(p.price) : pct(p.change));
    };
    row.append(cell(D.points[i]));
    if (selRep) row.append(cell(selRep.points[i]));
    tbody.append(row);
  });
  t.append(thead, tbody);
}

function renderWhy(r) {
  const box = $("why");
  box.textContent = "";
  $("why-wrap").style.display = r ? "" : "none";
  if (!r) return;
  const entries = Object.entries(r.axes).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of entries) {
    const m = el("span", { class: "meter", "aria-hidden": "true" });
    m.append(el("i", { style: `width:${Math.max(0, Math.min(1, v)) * 100}%` }));
    box.append(el("span", { class: "n" }, LABEL[k]), m, el("span", { class: "v" }, v.toFixed(2)));
  }
  const cov = coverageNote(r);
  if (cov) box.append(el("span", { class: "note", style: "grid-column:1 / 4" }, cov + " — shown next to the score, not mixed into it."));
  const offNow = (S.mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES).filter((k) => !(k in r.axes));
  if (offNow.length) box.append(el("span", { class: "note", style: "grid-column:1 / 4" }, `Not compared: ${offNow.map((k) => LABEL[k]).join(", ")}.`));
}

function renderFooter() {
  const f = $("footer");
  f.textContent = "";
  const lastOn = meta.last_on || {};
  f.append(el("div", {}, `Archive: ${ex.first} → ${ex.last}. Fear & Greed through ${lastOn.sentiment || "—"}.`));
  f.append(el("div", {}, "Data: CoinMarketCap API (quotes, OHLCV and Fear & Greed history), kept in RE:'s own archive. RE: observes; it does not predict."));
  f.append(el("div", {}, "Other windows: Wikimedia pageviews, Hacker News (Algolia), NASA APOD, USGS earthquakes, ECB rates via Frankfurter; X is a link only."));
}

boot();
