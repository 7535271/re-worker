/* RE: — the page. Reads /series once, then every observation is computed here in the browser. */
import { createExplorer, AXES, STATE_AXES, TRAJ_AXES, WIDTHS, HORIZON, REPLAY_OFFSETS, dayNum, ymdOf, asOfColumn, rangeState, mean7, windowSimilarity } from "./engine.js";

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
  STATE: "Where each part of the market stood within its own past year, as seen on each day of the window (STATE).",
  TRAJECTORY: "How price, volume, volatility and Fear & Greed moved inside the window, from its first day (TRAJECTORY).",
};

const S = { day: null, mode: "STATE", width: 7, off: new Set(), sel: 0, wv: "past", place: "tokyo" };
/* days to try first (from the conversation with Nova): the March 2020 crash, the December 2017 top, the FTX collapse */
const TRY_DAYS = ["2020-03-12", "2017-12-17", "2022-11-09"];
const WORLD_VIEWS = ["asof", "hind", "past"];
/* the weather window looks at one place, chosen by the viewer */
const PLACES = [
  { id: "tokyo", name: "Tokyo", lat: 35.68, lon: 139.69 },
  { id: "new-york", name: "New York", lat: 40.71, lon: -74.01 },
  { id: "london", name: "London", lat: 51.51, lon: -0.13 },
  { id: "san-francisco", name: "San Francisco", lat: 37.77, lon: -122.42 },
  { id: "singapore", name: "Singapore", lat: 1.35, lon: 103.82 },
  { id: "hong-kong", name: "Hong Kong", lat: 22.32, lon: 114.17 },
  { id: "seoul", name: "Seoul", lat: 37.57, lon: 126.98 },
  { id: "sydney", name: "Sydney", lat: -33.87, lon: 151.21 },
  { id: "sao-paulo", name: "São Paulo", lat: -23.55, lon: -46.63 },
  { id: "lagos", name: "Lagos", lat: 6.52, lon: 3.38 },
];
const placeNow = () => PLACES.find((x) => x.id === S.place) || PLACES[0];
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
  if (WORLD_VIEWS.includes(h.get("wv"))) S.wv = h.get("wv");
  if (PLACES.some((x) => x.id === h.get("pl"))) S.place = h.get("pl");
}
function writeHash() {
  const parts = [`d=${S.day}`, `m=${S.mode}`, `w=${S.width}`];
  if (S.off.size) parts.push(`off=${[...S.off].join(",")}`);
  if (S.sel) parts.push(`s=${S.sel}`);
  if (S.wv !== "past") parts.push(`wv=${S.wv}`);
  if (S.place !== PLACES[0].id) parts.push(`pl=${S.place}`);
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
  const tryBox = $("try");
  tryBox.append(el("span", {}, "Try"));
  for (const d of TRY_DAYS) {
    if (d < ex.first || d > ex.last) continue;
    const b = el("button", { type: "button", "data-day": d }, d);
    b.addEventListener("click", () => { S.day = d; S.sel = 0; run(); });
    tryBox.append(b);
  }
  for (const b of $("world-view").querySelectorAll("button")) {
    b.addEventListener("click", () => { if (b.disabled) return; S.wv = b.dataset.wv; writeHash(); renderWorld(res.results[S.sel] || null); });
  }
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
  for (const b of $("try").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.day === S.day));
  for (const b of $("width").querySelectorAll("button")) {
    const w = Number(b.dataset.w);
    b.setAttribute("aria-pressed", String(w === S.width));
    b.disabled = S.mode === "TRAJECTORY" && w < 2;
  }
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
  $("mode-hint").textContent = MODE_HINT[S.mode];

  const box = $("chips");
  box.textContent = "";
  // "attention" is a place kept in the market engine; the Attention window lives in its own column now
  const list = (S.mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES).filter((k) => k !== "attention");
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
  const st = $("status"), det = $("status-detail");
  st.textContent = ""; det.textContent = "";
  const q = ex.tl.axes.price[dayNum(S.day) - ex.tl.d0];
  if (res.error) {
    const why = res.error === "no axis can be observed for this window"
      ? (S.off.size ? "Nothing is left to compare — turn something back on under Adjust." : "There is too little past before this day. Try a later one.")
      : res.error;
    st.append(el("div", { class: "error" }, why));
    return;
  }
  const n = res.results.length;
  st.append(textWithDates("span", {}, n
    ? `BTC ${usd(q)} on ${S.day} · ${n} look-alike day${n === 1 ? "" : "s"} from ${int(res.candidates)} in its past`
    : `BTC ${usd(q)} on ${S.day} · nothing in its past to compare yet`));
  // the careful version lives in the drawer
  if (!res.searched) det.append(textWithDates("div", {}, `No past window ended by ${res.strict.last_candidate_end} (D − ${HORIZON} days). The archive starts on ${ex.first}; a past only counts if its ${HORIZON}-day replay had already happened on D.`));
  else det.append(textWithDates("div", {}, `Searched ${int(res.searched)} past windows that ended by ${res.strict.last_candidate_end} (D − ${HORIZON} days), so each replay had already happened on D.`));
  if (res.excluded) det.append(textWithDates("div", {}, `${int(res.candidates)} compared · ${int(res.excluded)} left out: less than half of D's axes (by weight) could be compared there.`));
  if (res.candidates > 0 && res.candidates < 365) det.append(el("div", { class: "note" }, "A small past: few windows could be compared before this day. That is part of what RE: observes here."));
  if (meta.complete === false && meta.missing_years && meta.missing_years.length) det.append(textWithDates("div", { class: "note" }, `The archive is still filling (missing: ${meta.missing_years.join(", ")}). Results use what is stored so far.`));
}

function coverageNote(r) {
  if (!r.coverage_days) return null;
  const parts = [];
  if (r.coverage_days.candidate !== null && r.coverage_days.candidate < 365) parts.push(`this past: ${r.coverage_days.candidate} days`);
  if (r.coverage_days.query !== null && r.coverage_days.query < 365) parts.push(`D: ${r.coverage_days.query} days`);
  return parts.length ? `scaled on less than a year (${parts.join(", ")})` : null;
}

const BAR_WINDOWS = [["market", "Market"], ["attention", "Attention"], ["weather", "Weather"], ["network", "Network"]];
function renderResults() {
  const box = $("results");
  box.textContent = "";
  if (!res.results.length) {
    box.append(el("p", { class: "note" }, res.error ? "Nothing to compare for these conditions."
      : res.searched ? "Every past day was left out: none had at least half of D's axes to compare." : "There is no earlier day to compare with yet."));
    return;
  }
  res.results.forEach((r, i) => {
    const b = el("button", { type: "button", class: "result", "data-i": i, "aria-pressed": String(i === S.sel), "aria-label": `Past ${i + 1}: ${r.day}, market similarity ${r.similarity}` });
    b.append(
      el("i", { class: "key", "aria-hidden": "true" }),
      el("span", { class: "when" }, r.day),
      el("span", { class: "sim" }, r.similarity.toFixed(2)),
    );
    const bars = el("span", { class: "bars" });
    for (const [k, name] of BAR_WINDOWS) {
      const bar = el("span", { class: "bar", "data-w": k, "data-state": k === "market" ? "on" : "wait" });
      const m = el("span", { class: "meter", "aria-hidden": "true" });
      m.append(el("i", { style: `width:${k === "market" ? Math.max(0, Math.min(1, r.similarity)) * 100 : 0}%` }));
      bar.append(m, el("small", {}, name));
      bars.append(bar);
    }
    b.append(bars);
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
/* fill a result's window bar (from the comparison) */
function setBar(i, k, v) {
  const bar = document.querySelector(`#results .result[data-i="${i}"] .bar[data-w="${k}"]`);
  if (!bar) return;
  bar.dataset.state = v === null ? "none" : v === undefined ? "wait" : "on";
  bar.querySelector(".meter > i").style.width = `${v ? Math.max(0, Math.min(1, v)) * 100 : 0}%`;
  bar.title = v === null || v === undefined ? "" : v.toFixed(2);
}

/* ── replay: chart, checkpoint table, why ── */
function renderReplay() {
  const picker = $("picker");
  picker.textContent = "";
  picker.style.display = res.results.length > 1 ? "" : "none";
  res.results.forEach((r, i) => {
    const b = el("button", { type: "button", "aria-pressed": String(i === S.sel), "aria-label": `Replay past ${i + 1}, ${r.day}` }, String(i + 1));
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
  if (r) lg.append(key("--series-sel", `Past ${S.sel + 1} · ${r.day}`));
  if (res.results.length > 1) lg.append(key("--context", "The other look-alikes"));

  // one sentence first: what followed the chosen day
  const ro = $("readout");
  ro.textContent = "";
  const p30 = selRep ? selRep.points.find((p) => p.offset === HORIZON) : null;
  if (r && p30 && p30.state === "seen" && p30.change !== null) {
    ro.append(document.createTextNode(`${HORIZON} days after ${r.day}, BTC was `), el("span", { class: p30.change >= 0 ? "up" : "down" }, pct(p30.change)), document.createTextNode(". What follows D is not shown — on D, nobody knew it yet."));
  } else if (r) {
    ro.append(document.createTextNode("What follows D is not shown — on D, nobody knew it yet."));
  }

  drawChart();
  renderTable(D, selRep, r);
  renderWhy(r);
  renderWorld(r);
  renderCompare();
}

/* ── the world that day: other windows onto the chosen past's event day (/scene) ── */
const scenes = new Map(); // "day|place" → Promise<body>
let worldToken = 0;
function loadScene(day) {
  const pl = placeNow();
  const key = `${day}|${pl.id}`;
  if (!scenes.has(key)) {
    const q = new URLSearchParams({ day, lat: String(pl.lat), lon: String(pl.lon), place: pl.name });
    const p = fetch(`/scene?${q}`).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok || !body || !body.windows) throw new Error((body && body.error) || `HTTP ${r.status}`);
      return body;
    });
    p.catch(() => scenes.delete(key)); // a failure is not remembered: the next look tries again
    scenes.set(key, p);
  }
  return scenes.get(key);
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

function hashRate(th) {
  if (th === null || th === undefined) return "—";
  const units = [[1e6, "EH/s"], [1e3, "PH/s"], [1, "TH/s"], [1e-3, "GH/s"], [1e-6, "MH/s"], [1e-9, "kH/s"]];
  for (const [f, u] of units) if (th >= f) return `${(th / f).toFixed(th / f >= 100 ? 0 : 1)} ${u}`;
  return `${(th * 1e12).toFixed(0)} H/s`;
}
const todayUTC = () => new Date().toISOString().slice(0, 10);
const WORLD_NOTE = {
  asof: "What the world could already see at 00:00 UTC on D. Each window shows the newest day it had then — never D itself.",
  hind: "What happened on D, as we know it now. None of it could be seen at 00:00 UTC on D, and RE: never uses it to find look-alike days.",
  past: "Other windows onto the day you chose. It was long past by D, so all of this was already out — shown as each source reports it today.",
};
let worldShown = null;

/* which day each window is read from, for the view in use */
async function worldSource(r) {
  if (S.wv === "past") { const sc = await loadScene(r.day); return (k) => ({ w: sc.windows[k], day: r.day, time: sc.window_time || {} }); }
  if (S.wv === "hind") { const sc = await loadScene(S.day); return (k) => ({ w: sc.windows[k], day: S.day, time: sc.window_time || {} }); }
  // AS OF: each window from D − its as_of_lag (the newest day that was already published at D 00:00)
  const byLag = new Map();
  const [s1, s2] = await Promise.all([loadScene(ymdOf(dayNum(S.day) - 1)), loadScene(ymdOf(dayNum(S.day) - 2))]);
  byLag.set(1, s1); byLag.set(2, s2);
  const time = s1.window_time || {};
  const extra = [...new Set(Object.values(time).map((t) => t.as_of_lag).filter((l) => Number.isInteger(l) && l > 0 && !byLag.has(l)))];
  const more = await Promise.all(extra.map((l) => loadScene(ymdOf(dayNum(S.day) - l))));
  extra.forEach((l, i) => byLag.set(l, more[i]));
  return (k) => {
    const lag = time[k] && Number.isInteger(time[k].as_of_lag) && time[k].as_of_lag > 0 ? time[k].as_of_lag : 1;
    const sc = byLag.get(lag);
    return { w: sc.windows[k], day: ymdOf(dayNum(S.day) - lag), time };
  };
}

async function renderWorld(r) {
  if (S.wv === "past" && !r) S.wv = "asof";
  $("world").style.display = "";
  for (const b of $("world-view").querySelectorAll("button")) {
    b.setAttribute("aria-pressed", String(b.dataset.wv === S.wv));
    if (b.dataset.wv === "past") { b.disabled = !r; b.textContent = r ? `Past ${S.sel + 1} · ${r.day}` : "Past"; }
  }
  const shownKey = (S.wv === "past" ? `past|${r.day}|${S.sel}` : `${S.wv}|${S.day}`) + `|${S.place}`;
  if (shownKey === worldShown) return; // already on screen
  worldShown = shownKey;
  const token = ++worldToken;
  const head = $("world-day");
  head.textContent = "";
  const isD = S.wv !== "past";
  head.append(el("span", { class: "k", style: `background:var(${isD ? "--series-d" : "--series-sel"})` }),
    textWithDates("span", {}, S.wv === "asof" ? `D · ${S.day}, as seen at 00:00 UTC` : S.wv === "hind" ? `D · ${S.day}, as known now` : `Past ${S.sel + 1} · ${r.day}`));
  $("world-note").textContent = WORLD_NOTE[S.wv] + (S.wv === "hind" && S.day >= todayUTC() ? " D is today, so the day is not over yet." : "");
  const box = $("world-body");
  box.textContent = "";
  box.append(el("p", { class: "note" }, "Looking through other windows…"));
  box.classList.add("loading");
  let get;
  try { get = await worldSource(r); } catch (e) {
    if (token !== worldToken) return;
    worldShown = null; // not shown: the next look tries again
    box.classList.remove("loading");
    box.textContent = "";
    box.append(el("p", { class: "note" }, `The other windows could not be reached this time (${e.message}). Switching the view again will retry.`));
    return;
  }
  if (token !== worldToken) return; // the choice changed while this was loading
  box.classList.remove("loading");
  box.textContent = "";

  // the label on the right of each window: in AS OF, first the day it shows
  // the label on the right: in AS OF, first the day it shows; then the value status (Nova's second axis)
  const VALUE_MARK = { current: "value today", revised: "revised later" };
  const when = (k, day, extra, x) => {
    const vs = x && x.state === "on" && get(k).time[k] ? VALUE_MARK[get(k).time[k].value_status] : null;
    return [S.wv === "asof" ? day : null, extra, vs].filter(Boolean).join(" · ") || null;
  };
  const on = (x) => x && x.state === "on";

  const wiki = (key, title, n) => {
    const { w: x, day } = get(key), b = winBox(title, when(key, day, on(x) ? "most read" : null, x));
    if (!on(x)) b.append(absentLine(x || {}));
    else if (!x.items.length) b.append(absentLine({ reason: "no pages listed" }));
    else b.append(listOf(x.items.slice(0, n), (i) => i.title, (i) => int(i.views)));
    return b;
  };
  box.append(wiki("wikipedia_en", "Wikipedia · English", 5));

  { const { w: hn, day } = get("hacker_news"), b = winBox("Hacker News", when("hacker_news", day, null, hn));
    if (!on(hn)) b.append(absentLine(hn || {}));
    else if (!hn.items.length) b.append(absentLine({ reason: "no stories that day" }));
    else b.append(listOf(hn.items.slice(0, 3), (i) => i.title, (i) => `${int(i.points)} pts`));
    box.append(b); }

  { const { w: ap, day } = get("apod"), b = winBox("NASA · Picture of the Day", when("apod", day, null, ap));
    if (!on(ap)) b.append(absentLine(ap || {}));
    else {
      const p = el("p", { class: "one" });
      p.append(link(ap.page_url, ap.title || "(untitled)"));
      b.append(p);
      if (ap.credit) b.append(el("p", { class: "sub" }, ap.credit));
    }
    box.append(b); }

  { const { w: q, day } = get("earthquakes"), b = winBox("Earthquakes · M4.5+", when("earthquakes", day, null, q));
    if (!on(q)) b.append(absentLine(q || {}));
    else {
      b.append(el("p", { class: "one" }, q.count_m45 === null ? "count unavailable" : `${int(q.count_m45)} on this UTC day`));
      const big = (q.biggest || [])[0];
      if (big) b.append(el("p", { class: "sub" }, `Largest: M${Number(big.mag).toFixed(1)} · ${big.place || "unnamed place"}`));
    }
    box.append(b); }

  { const { w: fx, day } = get("fx"), b = winBox("Exchange rates · ECB", when("fx", day, null, fx));
    if (!on(fx)) b.append(absentLine(fx || {}));
    else {
      const f = (v, d) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
      b.append(el("p", { class: "one" }, `1 USD = ${f(fx.usd_jpy, 2)} JPY · ${f(fx.usd_eur, 4)} EUR`));
      if (fx.note) b.append(textWithDates("p", { class: "sub" }, fx.note));
    }
    box.append(b); }

  { const { w: bn, day } = get("bitcoin_network"), b = winBox("Bitcoin network", when("bitcoin_network", day, null, bn));
    if (!on(bn)) b.append(absentLine(bn || {}));
    else {
      const vs = (c, what) => (c === null || c === undefined ? "" : ` · ${pct(c)} vs ${what}`);
      b.append(el("p", { class: "one" }, bn.transactions === null ? `Transactions: ${bn.transactions_why || "—"}` : `${int(Math.round(bn.transactions))} transactions${vs(bn.transactions_change_7d, "a week before")}`));
      b.append(el("p", { class: "sub" }, bn.hash_rate_avg7_th_s === null ? `Hash rate: ${bn.hash_rate_why || "—"}` : `Hash rate ${hashRate(bn.hash_rate_avg7_th_s)} (7-day average)${vs(bn.hash_rate_avg7_change, "the week before")}`));
    }
    box.append(b); }

  { const { w: wx, day } = get("weather"), b = winBox("Weather", when("weather", day, null, wx));
    const sel = el("select", { class: "place", "aria-label": "Place for the weather window" });
    for (const pl of PLACES) { const o = el("option", { value: pl.id }, pl.name); if (pl.id === S.place) o.selected = true; sel.append(o); }
    sel.addEventListener("change", () => { S.place = sel.value; writeHash(); worldShown = null; renderWorld(res.results[S.sel] || null); renderCompare(); });
    b.append(sel);
    if (!on(wx)) b.append(absentLine(wx || {}));
    else {
      const t = (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}`);
      const sky = wx.weather ? wx.weather[0].toUpperCase() + wx.weather.slice(1) : "—";
      b.append(el("p", { class: "one" }, `${sky} · ${t(wx.temp_min_c)} to ${t(wx.temp_max_c)} °C`));
      b.append(el("p", { class: "sub" }, `Rain ${t(wx.precipitation_mm)} mm · wind up to ${t(wx.wind_max_kmh)} km/h · UTC day`));
    }
    box.append(b); }

  box.append(wiki("wikipedia_ja", "Wikipedia · 日本語", 3));

  { const { w: x, day } = get("x"), b = winBox("X", when("x", day, "a door, not data"));
    if (x && x.url) {
      const a = link(x.url, S.wv === "asof" ? "Search X for “bitcoin” up to D 00:00 ↗" : "Search X for “bitcoin” that day ↗");
      a.className = "door";
      b.append(a);
    }
    box.append(b); }

  box.append(timeDetails(get("x").time));
}

/* each window's four times (Nova's window metadata), as a table-like list */
const WINDOW_NAMES = { wikipedia_en: "Wikipedia · English", wikipedia_ja: "Wikipedia · 日本語", hacker_news: "Hacker News", apod: "NASA · Picture of the Day", earthquakes: "Earthquakes", fx: "Exchange rates · ECB", bitcoin_network: "Bitcoin network", weather: "Weather", x: "X" };
const VALUE_STATUS = { as_published: "as published", current: "today's value", revised: "revised later — today's value" };
function timeDetails(time) {
  const d = el("details", { class: "times" });
  d.append(el("summary", {}, "When each window knew what"));
  d.append(el("p", {}, "A date on a window is not the moment the world could see it. Each window shows the times it has — when it happened, when it could be seen, when the data came out, whether it changes later. AS OF uses only what had come out by D 00:00 UTC."));
  for (const k of Object.keys(WINDOW_NAMES)) {
    const t = time[k];
    if (!t) continue;
    const box = el("div", { class: "t" });
    box.append(el("h4", {}, WINDOW_NAMES[k]));
    const dl = el("dl");
    // the four times are a template: each window shows only the ones it has
    for (const [label, v] of [["Happened", t.event], ["Seen", t.observation], ["Came out", t.publication], ["Changes later", t.revision], ["Value shown", VALUE_STATUS[t.value_status] || t.value_status], ["AS OF uses", `D − ${t.as_of_lag} day${t.as_of_lag === 1 ? "" : "s"}`]]) {
      if (v) dl.append(el("dt", {}, label), el("dd", {}, v));
    }
    box.append(dl);
    d.append(box);
  }
  return d;
}

/* ── similar, through which window? (Market ranked the pasts; each other window says how alike they look from there) ── */
const CMP_WINDOWS = [
  { k: "attention", name: "Attention" },
  { k: "weather", name: "Weather" },
  { k: "network", name: "Network" },
];
const wseries = new Map();   // "w" or "weather|place" → Promise<body>
const wcomps = new Map();    // same key → { comps, raw, lag } (computed once)
const seriesKey = (w) => (w === "weather" ? `weather|${S.place}` : w);
function loadSeries(w) {
  const key = seriesKey(w);
  if (!wseries.has(key)) {
    const q = new URLSearchParams({ w });
    if (w === "weather") { const pl = placeNow(); q.set("lat", String(pl.lat)); q.set("lon", String(pl.lon)); q.set("place", pl.name); }
    const p = fetch(`/window-series?${q}`).then(async (r) => {
      const b = await r.json().catch(() => null);
      if (!r.ok || !b) throw new Error((b && (b.detail || b.error)) || `HTTP ${r.status}`);
      return b;
    });
    p.catch(() => wseries.delete(key));
    wseries.set(key, p);
  }
  return wseries.get(key);
}
const logOf = (v) => (v > 0 ? Math.log(v) : NaN);
async function windowComps(k) {
  const key = seriesKey(k === "network" ? "tx" : k);
  if (wcomps.has(key)) return wcomps.get(key);
  const tl = ex.tl;
  let out;
  if (k === "attention") {
    const s = await loadSeries("attention");
    out = { comps: [rangeState(asOfColumn(tl, s.from, s.values, s.as_of_lag, logOf))], raw: { views: asOfColumn(tl, s.from, s.values, s.as_of_lag) }, lag: s.as_of_lag };
  } else if (k === "network") {
    const [tx, hash] = await Promise.all([loadSeries("tx"), loadSeries("hash")]);
    const txc = asOfColumn(tl, tx.from, tx.values, tx.as_of_lag);
    out = { comps: [rangeState(txc), rangeState(asOfColumn(tl, hash.from, mean7(hash.values), hash.as_of_lag, logOf))], raw: { tx: txc }, lag: tx.as_of_lag };
  } else {
    const s = await loadSeries("weather");
    const col = (v, f) => asOfColumn(tl, s.from, v, s.as_of_lag, f);
    const tmax = col(s.tmax), tmin = col(s.tmin);
    out = { comps: [rangeState(tmax), rangeState(tmin), rangeState(col(s.precip, (v) => Math.log1p(Math.max(0, v))))], raw: { tmax, code: col(s.code) }, lag: s.as_of_lag, place: s.place };
  }
  wcomps.set(key, out);
  return out;
}
const SKY = (c) => (Number.isNaN(c) ? "" : c === 0 ? "clear" : c <= 3 ? "cloudy" : c <= 48 ? "fog" : c <= 57 ? "drizzle" : c <= 67 ? "rain" : c <= 77 ? "snow" : c <= 82 ? "showers" : c <= 86 ? "snow" : "storm");
function compact(v) {
  if (Number.isNaN(v)) return "–";
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e5) return `${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}
function usdShort(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  if (v >= 1e5) return `$${Math.round(v / 1e3)}k`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  if (v >= 10) return `$${Math.round(v)}`;
  return usd(v);
}
function cmpCell(big, small, meter) {
  const c = el("span", { class: "c" });
  c.append(el("b", {}, big));
  if (meter !== undefined && meter !== null) { const m = el("span", { class: "meter", "aria-hidden": "true" }); m.append(el("i", { style: `width:${Math.max(0, Math.min(1, meter)) * 100}%` })); c.append(m); }
  if (small) c.append(el("small", {}, small));
  return c;
}
let cmpToken = 0;
async function renderCompare() {
  if (!res || !ex) return;
  if (res.error || !res.results.length) { $("compare-grid").textContent = ""; $("compare-notes").textContent = ""; return; }
  const token = ++cmpToken;
  // what is already known draws at once; windows still loading show "…" and fill in
  const ready = {}, why = {};
  const pending = [];
  for (const w of CMP_WINDOWS) {
    const key = seriesKey(w.k === "network" ? "tx" : w.k);
    if (wcomps.has(key)) ready[w.k] = wcomps.get(key);
    else pending.push(w.k);
  }
  drawCompare(ready, why, pending);
  if (!pending.length) return;
  const got = await Promise.allSettled(pending.map((k) => windowComps(k)));
  if (token !== cmpToken) return;
  got.forEach((g, i) => { if (g.status === "fulfilled") ready[pending[i]] = g.value; else why[pending[i]] = `could not be read this time (${g.reason && g.reason.message ? g.reason.message : "no answer"})`; });
  drawCompare(ready, why, []);
}
function drawCompare(ready, why, loading) {
  const tl = ex.tl, q = dayNum(S.day) - tl.d0, w = res.width;
  const grid = $("compare-grid");
  grid.textContent = "";
  const head = el("div", { class: "cmp-row head", role: "row" });
  head.append(el("span", { role: "columnheader" }, ""), el("span", { role: "columnheader" }, "Market"));
  for (const x of CMP_WINDOWS) head.append(el("span", { role: "columnheader" }, x.name));
  grid.append(head);

  // D: the values each window had at D 00:00
  const dRow = el("div", { class: "cmp-row d", role: "row" });
  const who = el("span", { class: "who" });
  who.append(el("i", { class: "k", style: "background:var(--series-d)" }), el("b", {}, "D"), el("small", {}, S.day));
  dRow.append(who, cmpCell(usdShort(tl.axes.price[q]), "price"));
  for (const x of CMP_WINDOWS) {
    const W = ready[x.k];
    if (!W) { dRow.append(cmpCell(loading.includes(x.k) ? "…" : "–", "")); continue; }
    if (x.k === "attention") dRow.append(cmpCell(compact(W.raw.views[q]), "views"));
    else if (x.k === "network") dRow.append(cmpCell(compact(W.raw.tx[q]), "tx"));
    else dRow.append(cmpCell(Number.isNaN(W.raw.tmax[q]) ? "–" : `${Math.round(W.raw.tmax[q])}°`, SKY(W.raw.code[q])));
  }
  grid.append(dRow);

  // each similar past: how alike it looks to D, window by window
  res.results.forEach((r, i) => {
    const b = el("button", { type: "button", class: "cmp-row", role: "row", "aria-pressed": String(i === S.sel), "aria-label": `Similar past ${i + 1}, ${r.day}` });
    const wk = el("span", { class: "who" });
    wk.append(el("i", { class: "k", style: `background:var(${i === S.sel ? "--series-sel" : "--context"})` }), el("b", {}, `Past ${i + 1}`), el("small", {}, r.day));
    b.append(wk, cmpCell(r.similarity.toFixed(2), null, r.similarity));
    for (const x of CMP_WINDOWS) {
      const W = ready[x.k];
      if (!W) { b.append(cmpCell(loading.includes(x.k) ? "…" : "–", null)); setBar(i, x.k, loading.includes(x.k) ? undefined : null); continue; }
      const s = windowSimilarity(W.comps, q, r.index, w);
      b.append(s ? cmpCell(s.similarity.toFixed(2), null, s.similarity) : cmpCell("–", null));
      setBar(i, x.k, s ? s.similarity : null);
    }
    b.addEventListener("click", () => { S.sel = i; renderResults(); renderReplay(); writeHash(); });
    grid.append(b);
  });

  // notes: what each column means, and why a cell is empty
  const notes = $("compare-notes");
  notes.textContent = "";
  const lag = (ready.attention || ready.network || ready.weather || {}).lag ?? 2;
  notes.append(el("div", {}, `The market found these days (${res.mode === "STATE" ? "where it stood" : "how it moved"}, ${w}-day window). The other windows did not: each one only says how alike the same ${w} days look from there — where each stood within its own past year (STATE). 1 = the same, 0 = nothing alike.`));
  notes.append(el("div", {}, `Each window uses only what had come out by 00:00 UTC of that day, so Attention, Weather and Network are read ${lag} days back.`));
  notes.append(el("div", {}, `Attention = daily views of English Wikipedia's “Bitcoin” article · Weather = ${placeNow().name} (change the place in The world that day) · Network = transactions and hash rate (7-day average).`));
  for (const x of CMP_WINDOWS) {
    if (why[x.k]) { notes.append(el("div", {}, `– ${x.name}: ${why[x.k]}`)); continue; }
    const W = ready[x.k];
    if (W && W.comps.every((a) => Number.isNaN(a[q]))) {
      const reason = x.k === "attention" ? "Wikipedia's daily counts start on 2015-07-01, and a value needs 30 days of past before it has a place in its year"
        : "no value for D yet (a window needs 30 days of past, and the newest days are not out yet)";
      notes.append(textWithDates("div", {}, `– ${x.name}: ${reason}.`));
    }
  }
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
  const offNow = (S.mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES).filter((k) => k !== "attention" && !(k in r.axes));
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
