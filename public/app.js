/* frctlns — the page. Reads /series once per coin, then every observation is computed here in the browser.
   Rearranged 2026-09-28 (Shu, Nova): the centre is a pair of days. The start shows pairs already found —
   the same windows jumped, the same shape afterwards, the same word — and any day can be compared four ways
   (looked like this, moved like this, moved together, same word) or explored on its own.
   00:00 stays as the edge of what could be seen from a day; what came after is shown, and marked when it was used to find a pair. */
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
};
const MODE_HINT = {
  STATE: "Where each part of the market stood within its own past year, as seen on each day of the window (STATE).",
  TRAJECTORY: "How price, volume, volatility and Fear & Greed moved inside the window, from its first day (TRAJECTORY).",
};

/* the markets frctlns keeps (CMC ids). Attention follows the coin's own English Wikipedia article */
const COINS = [
  { id: "1", sym: "BTC", name: "Bitcoin", x: "bitcoin", wiki: "Bitcoin" },
  { id: "1027", sym: "ETH", name: "Ethereum", x: "ethereum", wiki: "Ethereum" },
  { id: "52", sym: "XRP", name: "XRP", x: "xrp", wiki: "XRP Ledger" },
  { id: "5426", sym: "SOL", name: "Solana", x: "solana", wiki: "Solana (blockchain platform)" },
  { id: "74", sym: "DOGE", name: "Dogecoin", x: "dogecoin", wiki: "Dogecoin" },
];
const coinNow = () => COINS.find((c) => c.id === S.coin) || COINS[0];
const sym = () => coinNow().sym;
/* words to try from the world side: light, curious things, not the news (Nova, 2026-09-27) */
const WORDS = [["eclipse", "eclipse"], ["iphone", "iPhone"], ["ai", "AI"], ["space", "space"], ["bitcoin", "bitcoin"]];

const VIEWS = ["home", "stand", "past", "how"];
const S = {
  coin: "1", t: "market", q: "", day: null, mode: "STATE", width: 7, off: new Set(),
  other: null, pk: "m", place: "tokyo", view: "home", open: null, mv: 7, mtv: "dots", x: false,
};
const SPANS = [[3, "3 days"], [7, "1 week"], [30, "1 month"]];
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
let ex = null, meta = {}, res = null;
const explorers = new Map(); // coin → Promise<{ ex, meta }>
let ready = { "1": true };   // which coins have a full archive (from /archive/status)

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
function setDated(node, text) {
  node.textContent = "";
  node.append(...textWithDates("span", {}, text).childNodes);
}
function svg(tag, attrs = {}, text) {
  const e = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

/* ── the URL remembers where you are (so a view can be shared, reopened, and the back swipe works) ── */
function readHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  S.coin = COINS.some((c) => c.id === h.get("c")) ? h.get("c") : "1";
  S.t = h.get("t") === "world" ? "world" : "market";
  S.q = normWord(h.get("q") || "");
  const d = h.get("d");
  S.day = d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
  S.mode = h.get("m") === "TRAJECTORY" ? "TRAJECTORY" : "STATE";
  const w = Number(h.get("w"));
  S.width = WIDTHS.includes(w) ? w : 7;
  S.off = new Set();
  for (const k of (h.get("off") || "").split(",")) if (AXES.includes(k)) S.off.add(k);
  const p = h.get("p");
  S.other = p && /^\d{4}-\d{2}-\d{2}$/.test(p) ? p : null;
  S.pk = ["w", "v", "p"].includes(h.get("pk")) ? h.get("pk") : "m";
  const mv = Number(h.get("mv"));
  S.mv = SPANS.some(([x]) => x === mv) ? mv : 7;
  S.mtv = h.get("mtv") === "lines" ? "lines" : "dots";
  S.place = PLACES.some((x) => x.id === h.get("pl")) ? h.get("pl") : PLACES[0].id;
  S.view = VIEWS.includes(h.get("v")) ? h.get("v") : "home";
  S.open = h.get("o") || null;
  S.x = h.get("x") === "1";
}
function writeHash(push = false) {
  const parts = [];
  if (S.view === "home") {
    if (S.coin !== "1") parts.push(`c=${S.coin}`);
    if (S.q) parts.push(`q=${encodeURIComponent(S.q)}`);
    if (S.place !== PLACES[0].id) parts.push(`pl=${S.place}`);
    history[push ? "pushState" : "replaceState"]({ re: true }, "", "#" + parts.join("&"));
    return;
  }
  if (S.coin !== "1") parts.push(`c=${S.coin}`);
  if (S.t !== "market") parts.push(`t=${S.t}`);
  if (S.q) parts.push(`q=${encodeURIComponent(S.q)}`);
  if (S.day) parts.push(`d=${S.day}`);
  if (S.mode !== "STATE") parts.push(`m=${S.mode}`);
  if (S.width !== 7) parts.push(`w=${S.width}`);
  if (S.off.size) parts.push(`off=${[...S.off].join(",")}`);
  if (S.other && S.view === "past") parts.push(`p=${S.other}`);
  if (S.mv !== 7) parts.push(`mv=${S.mv}`);
  if (S.mtv !== "dots") parts.push(`mtv=${S.mtv}`);
  if (S.place !== PLACES[0].id) parts.push(`pl=${S.place}`);
  if (S.view !== "home") parts.push(`v=${S.view}`);
  if (S.x && S.view === "stand") parts.push("x=1");
  if (S.open) parts.push(`o=${S.open}`);
  history[push ? "pushState" : "replaceState"]({ re: true }, "", "#" + parts.join("&"));
}

/* ── start ── */
function loadCoin(id) {
  if (!explorers.has(id)) {
    const p = fetch(`/series?id=${id}`, { cache: "no-store" }).then(async (r) => {
      const body = await r.json().catch(() => null);
      if (!r.ok || !body) throw new Error((body && body.error) || `HTTP ${r.status}`);
      return { ex: createExplorer(body), meta: body.meta || {} };
    });
    p.catch(() => explorers.delete(id));
    explorers.set(id, p);
  }
  return explorers.get(id);
}
async function useCoin(id) {
  const got = await loadCoin(id);
  ex = got.ex;
  meta = got.meta;
  S.coin = id;
  if (!S.day || S.day < ex.first || S.day > ex.last) S.day = S.day && S.day < ex.first ? ex.first : ex.last;
}
async function boot() {
  readHash();
  fetch("/archive/status", { cache: "no-store" }).then((r) => r.json()).then((st) => {
    const next = {};
    for (const a of st.archives || []) next[a.id] = a.complete === true;
    ready = { ...next, "1": true };
    if (S.view === "home") renderCoins();
  }).catch(() => {});
  try {
    await useCoin(S.coin);
  } catch (e) {
    try { await useCoin("1"); } catch (e2) {
      const st = $("status-home");
      st.textContent = "";
      st.append(el("div", { class: "error" }, `The archive could not be loaded yet (${e2.message}). It fills itself every few minutes; progress is at /archive/status.`));
      return;
    }
  }
  if (S.q) await refreshMoments(); // a shared link to two moments of a word opens on them
  if (S.view === "past") { try { await patternFor(S.day); } catch { /* the places found other ways still open */ } }
  setupControls();
  renderFooter();
  run(false);
  writeHash(false);
  // the back swipe (and the browser's back button) walks back through the screens
  window.addEventListener("popstate", async () => {
    const place = S.place; // the chosen place stays chosen while you walk back
    readHash();
    if (!new URLSearchParams(location.hash.slice(1)).has("pl")) S.place = place;
    try { await useCoin(S.coin); } catch { await useCoin("1"); }
    if (S.q) await refreshMoments();
    if (S.view === "past") { try { await patternFor(S.day); } catch { /* as above */ } }
    run(false);
    if (S.place !== PLACES[0].id) writeHash(false);
  });
  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { for (const v of Object.values(charts)) if (v && v.shown()) { v.animate = false; drawChart(v); } }, 120);
  });
}

function setupControls() {
  const wbox = $("width");
  for (const w of WIDTHS) {
    const b = el("button", { type: "button", "data-w": w, "aria-label": `${w}-day window` }, `${w}d`);
    b.addEventListener("click", () => { S.width = w; run(); });
    wbox.append(b);
  }
  for (const b of $("mode").querySelectorAll("button")) b.addEventListener("click", () => { S.mode = b.dataset.mode; run(); });
  // the world: a word
  $("ask").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = normWord($("q").value);
    $("q").blur();
    if (q) go({ q }, S.q !== q);
  });
  const words = $("words");
  for (const [w, label] of WORDS) {
    const b = el("button", { type: "button", "data-q": w }, label);
    b.addEventListener("click", () => { $("q").value = label; go({ q: w }, S.q !== w); });
    words.append(b);
  }
  // any day starts somewhere random (2026-09-28, Shu: today is usually a weak place to stand — nothing has happened after it yet)
  $("pick-day").addEventListener("click", () => { S.q = ""; standOn(randomDay()); });
  $("s-explore-link").addEventListener("click", () => go({ x: true, open: null }));
  // the day you stand on: each part of the big date has an invisible wheel on top, holding only days the archive has
  for (const id of ["d-y", "d-m", "d-d"]) $(id).addEventListener("change", () => pickFromWheels(id));
  $("prev-day").addEventListener("click", () => stepDay(-1));
  $("next-day").addEventListener("click", () => stepDay(1));
  $("latest").addEventListener("click", () => setDay(ex.last));
  $("random").addEventListener("click", () => standOn(randomDay()));
  for (const id of ["how-link", "how-link2"]) $(id).addEventListener("click", () => go({ view: "how", open: null }));
  $("p-prev").addEventListener("click", () => stepPair(-1));
  $("p-next").addEventListener("click", () => stepPair(1));
  $("stand").addEventListener("click", exploreThere);
  // the mark: back to a clean start, from any screen (2026-09-28, Shu): what you did before does not follow you home.
  // The coin and the weather's place stay: they are choices you can see
  $("mark").addEventListener("click", () => {
    Object.assign(S, { view: "home", day: ex.last, q: "", other: null, open: null, x: false, mode: "STATE", width: 7, mv: 7, mtv: "dots", off: new Set() });
    const input = $("q");
    if (input) input.value = "";
    run(false);
    writeHash(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  for (const b of $("mt-view").querySelectorAll("button")) b.addEventListener("click", () => { if (S.mtv !== b.dataset.v) { S.mtv = b.dataset.v; writeHash(false); renderTogether(); } });
  for (const v of Object.values(charts)) {
    const svgEl = $(v.svgId);
    svgEl.addEventListener("pointerdown", (e) => pointAt(v, e));
    svgEl.addEventListener("pointermove", (e) => pointAt(v, e));
    svgEl.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hideTip(v); });
    svgEl.addEventListener("keydown", (e) => {
      if (!v.series) return;
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const cur = v.cursor ?? 0;
        showAt(v, Math.max(v.lo, Math.min(v.hi, cur + (e.key === "ArrowLeft" ? -1 : 1))));
      } else if (e.key === "Escape") hideTip(v);
    });
    svgEl.addEventListener("blur", () => hideTip(v));
  }
}

/* ── moving around ── */
let shownView = null;
function go(patch, push = true) {
  Object.assign(S, patch);
  render();
  writeHash(push);
}
/* stand on a day (from a list): a new screen, so the back swipe returns to the list */
function standOn(d) {
  S.day = d < ex.first ? ex.first : d > ex.last ? ex.last : d;
  S.view = "stand";
  S.open = null;
  S.other = null;
  S.x = false;
  run(false);
  writeHash(true);
}
/* a random day (2026-09-28, Shu): one with a year of past behind it and a month after it, so every way of overlapping can look */
function randomDay() {
  const n = ex.tl.n, lo = Math.min(365, n - 1), hi = Math.max(lo, n - 1 - 30);
  let d;
  do { d = ymdOf(ex.tl.d0 + lo + Math.floor(Math.random() * (hi - lo + 1))); } while (d === S.day && hi > lo);
  return d;
}
function setDay(d) {
  S.day = d < ex.first ? ex.first : d > ex.last ? ex.last : d;
  S.open = null;
  run();
}
function stepDay(k) {
  setDay(ymdOf(dayNum(S.day) + k));
}
async function setCoin(id) {
  if (id === S.coin) return;
  document.body.classList.add("loading");
  try { await useCoin(id); } catch (e) { document.body.classList.remove("loading"); return; }
  document.body.classList.remove("loading");
  S.other = null;
  S.open = null;
  if (S.q) await refreshMoments();
  run(false);
  writeHash(false);
}

/* ── one observation (the market side: days that looked like the day you stand on) ── */
function search() {
  if (S.mode === "TRAJECTORY" && S.width < 2) S.width = 7;
  const axes = {};
  for (const k of AXES) axes[k] = !S.off.has(k);
  res = ex.search({ day: S.day, mode: S.mode, width: S.width, axes, top: 5 });
}
function run(write = true) {
  search();
  render();
  if (write) writeHash(false);
}
function render() {
  if (S.view === "past" && !pairNow()) S.view = "stand";
  for (const v of VIEWS) $(`v-${v}`).hidden = v !== S.view;
  if (shownView !== S.view) { window.scrollTo(0, 0); shownView = S.view; }
  if (S.view === "home") renderHome();
  else if (S.view === "stand") renderStand();
  else if (S.view === "past") renderPast();
  else renderHow();
}

/* a day with a thin past: say which kind, and how many days were there */
function histTag(cov, day) {
  if (cov === null || cov === undefined || cov >= 365) return null;
  const since = dayNum(day) - dayNum(ex.first) + 1;
  return since < 365 ? `short history · ${cov} days available` : `incomplete history · ${cov}/365 days available`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function ymdParts(d) { return d.split("-").map(Number); }
const niceDay = (d) => { const [y, m, dd] = ymdParts(d); return `${y} · ${MONTHS[m - 1]} ${String(dd).padStart(2, "0")}`; };
const priceAt = (day) => { const i = dayNum(day) - ex.tl.d0; return i >= 0 && i < ex.tl.n ? ex.tl.axes.price[i] : NaN; };
function whenCell(day) {
  const when = el("span", { class: "when" });
  when.append(el("small", {}, day.slice(0, 4)), document.createTextNode(niceDay(day).slice(7)));
  return when;
}

/* ══ 1. the start: where do you want to stand? ══ */
function renderCoins() {
  const box = $("coins");
  box.textContent = "";
  for (const c of COINS) {
    const ok = ready[c.id] === true;
    const b = el("button", { type: "button", class: "coin", "aria-pressed": String(c.id === S.coin), "aria-disabled": ok ? undefined : "true", title: ok ? c.name : `${c.name}: the archive is still filling` });
    b.append(document.createTextNode(c.sym));
    if (!ok) b.append(el("small", {}, "filling"));
    if (ok) b.addEventListener("click", () => setCoin(c.id));
    box.append(b);
  }
}
/* the start: three doors — the coin, any day, the world (2026-09-28, Shu and Nova: the start is a way in, the finding happens inside) */
function renderHome() {
  renderCoins();
  for (const x of document.querySelectorAll(".coin-sym")) x.textContent = sym();
  renderWorld();
}

/* the world side: a word → the days it was happening */
function normWord(s) {
  const q = String(s || "").normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
  return q.length >= 2 && q.length <= 40 && /^[\p{L}\p{N} .'&+-]+$/u.test(q) ? q : "";
}
const momentCache = new Map(); // word → Promise<body>
function loadMoments(q) {
  if (!momentCache.has(q)) {
    const p = fetch(`/moments?q=${encodeURIComponent(q)}`).then(async (r) => {
      const b = await r.json().catch(() => null);
      if (!r.ok || !b || !Array.isArray(b.moments)) throw new Error((b && b.error) || `HTTP ${r.status}`);
      return b;
    });
    p.catch(() => momentCache.delete(q));
    momentCache.set(q, p);
  }
  return momentCache.get(q);
}
let worldToken = 0;
async function renderWorld() {
  const input = $("q");
  if (document.activeElement !== input && normWord(input.value) !== S.q) input.value = S.q;
  for (const b of $("words").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.q === S.q));
  const rows = $("w-rows"), title = $("w-title"), found = $("w-found"), how = $("w-how");
  if (!S.q) {
    title.textContent = "";
    found.textContent = "";
    rows.hidden = true;
    how.textContent = "Enter a word, topic, or event. frctlns finds the days it left traces in the world — in what people read on Wikipedia and voted up on Hacker News.";
    return;
  }
  const token = ++worldToken;
  title.textContent = `“${S.q}”`;
  found.textContent = "looking…";
  rows.hidden = false;
  rows.textContent = "";
  rows.append(el("p", { class: "empty" }, "Looking for its traces on Wikipedia and Hacker News…"));
  how.textContent = "";
  let body;
  try { body = await loadMoments(S.q); } catch (e) {
    if (token !== worldToken) return;
    found.textContent = "";
    rows.textContent = "";
    rows.append(el("p", { class: "empty" }, `The world could not be searched this time (${e.message}). Try again in a moment.`));
    return;
  }
  if (token !== worldToken || S.view !== "home") return;
  const list = body.moments.filter((m) => m.day >= ex.first && m.day <= ex.last).sort((a, b) => b.score - a.score);
  const before = body.moments.length - list.length;
  found.textContent = list.length ? `${list.length} moment${list.length === 1 ? "" : "s"}` + (before ? ` · ${before} before ${sym()}'s history` : "") : "";
  rows.textContent = "";
  if (!list.length) rows.append(el("p", { class: "empty" }, body.moments.length ? `Found only before ${sym()}'s history begins (${ex.first}).` : "No traces stood out. Try another word, in English."));
  list.forEach((m, i) => rows.append(momentRow(m, i, async () => { await refreshMoments(); standOn(m.day); })));
  how.textContent = "";
  how.append(textWithDates("span", {}, `Public traces, found with today's records — not a list of events. Stand on one to see the places in time that overlap with it.${body.article ? ` Wikipedia: “${body.article.title}”.` : ""}`));
}

/* a day the word left traces */
function momentRow(m, i, onTap) {
  const b = el("button", { type: "button", class: "row moment", style: `animation-delay:${i * 0.04}s` });
  b.append(whenCell(m.day), el("span", { class: "go" }, `${sym()} ${usdShort(priceAt(m.day))}`), el("span", { class: "chev", "aria-hidden": "true" }, "›"));
  if (m.hn) b.append(el("span", { class: "what" }, m.hn.title));
  const clues = [];
  if (m.hn) clues.push(`HN ${int(m.hn.points)} pts`);
  if (m.wiki) clues.push(`Wikipedia ${m.wiki.times >= 10 ? Math.round(m.wiki.times) : m.wiki.times}× usual`);
  b.append(el("span", { class: "hist" }, clues.join(" · ")));
  b.addEventListener("click", onTap);
  return b;
}

/* the market side: the days it moved the most (00:00 → next 00:00, the coin you chose) */
const movesCache = new Map();
function bigMoves() {
  if (movesCache.has(S.coin)) return movesCache.get(S.coin);
  const p = ex.tl.axes.price, n = ex.tl.n;
  const all = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = p[i], b = p[i + 1];
    if (!(a > 0) || !(b > 0)) continue;
    all.push({ i, day: ymdOf(ex.tl.d0 + i), move: b / a - 1 });
  }
  const pick = (sorted) => {
    const out = [];
    for (const x of sorted) {
      if (out.every((y) => Math.abs(y.i - x.i) >= 30)) out.push(x);
      if (out.length === 5) break;
    }
    return out;
  };
  const got = { falls: pick([...all].sort((a, b) => a.move - b.move)), rises: pick([...all].sort((a, b) => b.move - a.move)) };
  movesCache.set(S.coin, got);
  return got;
}
/* ══ 2. the day you stand on ══ */
const ownKey = () => `${S.coin}|${S.day}`;
function contextLine() {
  const box = $("s-ctx");
  box.textContent = "";
  // arrived from a word: say what was happening; from the market: how it moved that day
  const m = S.q ? momentsNow().find((x) => x.day === S.day) : null;
  if (m) {
    box.append(el("span", { class: "tag" }, `“${S.q}”`));
    if (m.hn) box.append(document.createTextNode(m.hn.title));
    else if (m.wiki) box.append(document.createTextNode(`Wikipedia read ${Math.round(m.wiki.times)}× its usual day`));
    return;
  }
  const mv = [...bigMoves().falls, ...bigMoves().rises].find((x) => x.day === S.day);
  if (mv) box.append(el("span", { class: "tag" }, `${sym()} ${pct(mv.move)} that day`), document.createTextNode("one of its biggest moves — found with hindsight"));
}
/* the moments of the word you came with, within the chosen coin's history */
let momentsList = [], momentsFor = "";
const momentsNow = () => (momentsFor === `${S.q}|${S.coin}` ? momentsList : []);
async function refreshMoments() {
  const key = `${S.q}|${S.coin}`;
  if (!S.q) { momentsList = []; momentsFor = key; return; }
  try {
    const b = await loadMoments(S.q);
    if (key !== `${S.q}|${S.coin}`) return;
    momentsList = b.moments.filter((m) => m.day >= ex.first && m.day <= ex.last).sort((a, b) => b.score - a.score);
  } catch { momentsList = []; }
  momentsFor = key;
}
function renderStand() {
  const [y, m, d] = ymdParts(S.day);
  $("h-yr").textContent = String(y);
  $("h-mo").textContent = MONTHS[m - 1].toUpperCase();
  $("h-dd").textContent = String(d);
  renderWheels();
  const pr = $("h-price");
  pr.textContent = "";
  pr.append(document.createTextNode(`${sym()} ${usd(priceAt(S.day))}`), el("small", {}, "at 00:00 UTC that day"));
  const qc = res.results.length && res.results[0].coverage_days ? res.results[0].coverage_days.query : null;
  const qt = histTag(qc, S.day);
  if (qt) pr.append(el("span", { class: "hist" }, qt));
  $("prev-day").disabled = S.day <= ex.first;
  $("next-day").disabled = S.day >= ex.last;
  $("latest").setAttribute("aria-pressed", String(S.day === ex.last));
  contextLine();
  if (S.q && momentsFor !== `${S.q}|${S.coin}`) refreshMoments().then(() => { if (S.view === "stand") { contextLine(); renderPlaces(); } });

  renderPlaces();
  // the day on its own, when asked for: the windows at 00:00, what happened next, what moved with it
  $("s-explore").hidden = !S.x;
  $("s-explore-link").hidden = S.x;
  if (S.x) {
    renderTiles("s", { kind: "asof" });
    drawOwn(false);
  }
}
/* moved like this afterwards: the shape of the move after the day (hindsight) */
const movesCacheDay = new Map();
function movesOf(day, mv) {
  const key = `${S.coin}|${day}|${mv}`;
  if (!movesCacheDay.has(key)) movesCacheDay.set(key, ex.movesLike(day, mv, { top: 5 }));
  return movesCacheDay.get(key);
}
const movesNow = () => movesOf(S.day, S.mv);
function drawOwn(animate) {
  const rep = ex.replay(S.day, ex.last);
  checksInto($("s-checks"), rep);
  const v = charts.stand;
  v.series = [{ kind: "d", name: S.day, rep, open: true }];
  v.cursor = null;
  v.animate = animate;
  v.note = null;
  drawChart(v);
  v.animate = false;
  const last = rep.points[rep.points.length - 1];
  $("s-after").textContent = last.state === "unknown" ? `The archive ends on ${ex.last}: later days are not known yet.` : "";
  renderTiles("h", { kind: "hind" });
  renderTogether();
}

/* ── Moved together? (hindsight): the same 38 days, one line per window, stacked so they can be read down a column.
   A dot = an unusual day for that window: a change ≥ 3× its usual day-to-day change over the year before
   (robust: 1.4826 × the median absolute change). Hacker News counts: ≥ 3× the month's median and ≥ 5.
   frctlns does not say what caused what — together, later, or not at all are all results (Nova, 2026-09-28) ── */
const MT_BEFORE = 7, MT_AFTER = 30;
const TOGETHER = [
  { group: "Crypto" },
  { k: "price", name: () => `${sym()} price`, kind: "log", main: true },
  { k: "fg", name: () => "Fear & Greed", kind: "diff" },
  { k: "tx", name: () => "Bitcoin network", kind: "log", w: "tx" },
  { group: "Attention to it" },
  { k: "wiki", name: () => `${sym()} on Wikipedia`, kind: "log", w: "attention" },
  { k: "hn", name: () => `${sym()} on Hacker News`, kind: "count" },
  { group: "Money" },
  { k: "nasdaq", name: () => "Nasdaq", kind: "log", w: "nasdaq" },
  { k: "vix", name: () => "VIX", kind: "log", w: "vix" },
  { k: "usd", name: () => "US dollar", kind: "log", w: "usd" },
  { group: "The world" },
  { k: "wikitotal", name: () => "All of Wikipedia", kind: "log", w: "wikitotal" },
];
const talks = new Map();
function loadTalk(q, day) {
  const key = `${q}|${day}`;
  if (!talks.has(key)) {
    const p = fetch(`/talk?${new URLSearchParams({ q, day })}`).then(async (r) => {
      const b = await r.json().catch(() => null);
      if (!r.ok || !b || !Array.isArray(b.counts)) throw new Error((b && (b.detail || b.error)) || `HTTP ${r.status}`);
      return b;
    });
    p.catch(() => talks.delete(key));
    talks.set(key, p);
  }
  return talks.get(key);
}
/* what happened during UTC day d, for each window (the price and Fear & Greed of day d are read at the next 00:00) */
function dailyOf(row, got, day0) {
  const n = MT_BEFORE + MT_AFTER + 1, back = 365;
  const first = dayNum(day0) - MT_BEFORE - back;
  const len = n + back;
  const out = new Array(len).fill(null);
  const tl = ex.tl;
  for (let j = 0; j < len; j++) {
    const d = first + j;
    if (row.k === "price" || row.k === "fg") {
      const i = d + 1 - tl.d0;
      const v = i >= 0 && i < tl.n ? (row.k === "price" ? tl.axes.price[i] : tl.axes.sentiment[i]) : NaN;
      out[j] = Number.isNaN(v) ? null : v;
    } else if (row.k === "hn") {
      const t = got.hn;
      const k = d - (dayNum(day0) - MT_BEFORE);
      out[j] = t && k >= 0 && k < t.counts.length ? t.counts[k] : null;
    } else {
      const s = got[row.w];
      if (!s) continue;
      const k = d - dayNum(s.from);
      const v = k >= 0 && k < s.values.length ? s.values[k] : null;
      out[j] = typeof v === "number" && Number.isFinite(v) ? v : null;
    }
  }
  return { vals: out, back };
}
/* the change into each day (from the last day that had a value), and which days were unusual */
function unusualOf(row, vals, back) {
  const ch = new Array(vals.length).fill(null);
  let prev = null;
  for (let j = 0; j < vals.length; j++) {
    const v = vals[j];
    if (v === null) continue;
    if (prev !== null) {
      if (row.kind === "log") ch[j] = v > 0 && prev > 0 ? Math.log(v / prev) : null;
      else if (row.kind === "diff") ch[j] = v - prev;
      else ch[j] = Math.log((v + 1) / (prev + 1));
    }
    prev = v;
  }
  const win = vals.slice(back);
  const flags = new Array(win.length).fill(false);
  if (row.kind === "count") {
    const xs = win.filter((x) => x !== null).sort((a, b) => a - b);
    const med = xs.length ? xs[Math.floor(xs.length / 2)] : 0;
    win.forEach((x, i) => { flags[i] = x !== null && x >= 5 && x >= 3 * Math.max(1, med); });
    return { flags, ch: ch.slice(back), usual: med };
  }
  const base = ch.slice(0, back).filter((x) => x !== null).map(Math.abs).sort((a, b) => a - b);
  if (base.length < 30) return { flags, ch: ch.slice(back), usual: null };
  const sigma = 1.4826 * base[Math.floor(base.length / 2)];
  const c = ch.slice(back);
  c.forEach((x, i) => { flags[i] = x !== null && sigma > 0 && Math.abs(x) >= 3 * sigma; });
  return { flags, ch: c, usual: sigma };
}
let mtToken = 0;
async function renderTogether() {
  const token = ++mtToken;
  const day0 = S.day;
  const got = {};
  const status = {};
  const draw = () => { if (token === mtToken && S.view === "stand") drawTogether(day0, got, status); };
  for (const r of TOGETHER) if (r.w) status[r.k] = "wait";
  status.hn = "wait";
  draw();
  const jobs = TOGETHER.filter((r) => r.w).map((r) => loadSeries(r.w).then((s) => { got[r.w] = s; status[r.k] = "ok"; }).catch((e) => { status[r.k] = `could not be read (${e.message})`; }).then(draw));
  jobs.push(loadTalk(coinNow().x, day0).then((t) => { got.hn = t; status.hn = "ok"; }).catch((e) => { status.hn = `could not be read (${e.message})`; }).then(draw));
  await Promise.allSettled(jobs);
}
/* two ways to read the same rows: dots (the default — an unusual day is a big dot, so a column of big dots is things moving together)
   or lines (the shape of each window) */
function drawTogether(day0, got, status) {
  const box = $("mt");
  for (const b of $("mt-view").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === S.mtv));
  const dots = S.mtv !== "lines";
  const W = Math.max(300, Math.round(box.getBoundingClientRect().width) - 12 || 360);
  const L = 6, R = 6, ROW = dots ? 32 : 44, LINE_TOP = 17, GROUP = 22, TOP = dots ? 18 : 2, AX = 22;
  const n = MT_BEFORE + MT_AFTER + 1;
  const X = (j) => L + 5 + (j / (n - 1)) * (W - L - R - 10);
  // first pass: every row's values and unusual days (so the columns can be counted before drawing)
  const rows = [];
  for (const r of TOGETHER) {
    if (r.group) { rows.push({ r }); continue; }
    const st = status[r.k];
    if (st && st !== "ok") { rows.push({ r, st }); continue; }
    const { vals, back } = dailyOf(r, got, day0);
    const win = vals.slice(back);
    rows.push({ r, win, u: unusualOf(r, vals, back) });
  }
  const colCount = new Array(n).fill(0);
  for (const x of rows) if (x.u) x.u.flags.forEach((f, j) => { if (f && x.win[j] !== null) colCount[j]++; });
  let H = TOP + AX;
  for (const x of rows) H += x.r.group ? GROUP : ROW;
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  const g = svg("g");
  root.append(g);
  // the day itself, down every row; and in dots, every column where 3+ windows were unusual lights up
  g.append(svg("rect", { x: X(MT_BEFORE) - 5, y: TOP, width: 10, height: H - TOP - AX, rx: 4, fill: "var(--wash)" }));
  if (dots) {
    colCount.forEach((cnt, j) => {
      if (cnt < 3) return;
      g.append(svg("rect", { x: X(j) - 5, y: TOP, width: 10, height: H - TOP - AX, rx: 4, fill: "var(--series-sel)", opacity: Math.min(0.32, 0.1 + 0.05 * cnt) }));
      g.append(svg("text", { x: X(j), y: TOP - 5, "text-anchor": "middle", "font-size": 10.5, "font-weight": 800, fill: "var(--series-sel)" }, String(cnt)));
    });
  }
  let y = TOP;
  const around = [], later = [];
  for (const x of rows) {
    const r = x.r;
    if (r.group) {
      g.append(svg("text", { x: L, y: y + 16, "font-size": 10, "font-weight": 700, "letter-spacing": "0.06em", fill: "var(--muted)" }, r.group.toUpperCase()));
      y += GROUP;
      continue;
    }
    const mid = dots ? y + 23 : y + LINE_TOP + (ROW - LINE_TOP) / 2;
    g.append(svg("line", { x1: L, x2: W - R, y1: y + ROW - 0.5, y2: y + ROW - 0.5, stroke: "var(--grid)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
    g.append(svg("text", { x: L, y: y + 12, "font-size": 11.5, "font-weight": r.main ? 700 : 600, fill: r.main ? "var(--ink)" : "var(--ink-2)" }, r.name()));
    if (x.st) {
      g.append(svg("text", { x: L, y: mid + 4, "font-size": 11, fill: "var(--muted)" }, x.st === "wait" ? "…" : x.st.length > 48 ? x.st.slice(0, 47) + "…" : x.st));
      y += ROW;
      continue;
    }
    const { win, u } = x;
    const xs = win.filter((v) => v !== null);
    if (!xs.length) {
      const why = r.k === "fg" ? `the index starts on ${meta.fng_from || "2023-06-29"}` : r.k === "wiki" || r.k === "wikitotal" ? "Wikipedia's daily counts start on 2015-07-01" : "no values for these days";
      g.append(svg("text", { x: L, y: mid + 4, "font-size": 11, fill: "var(--muted)" }, why));
      y += ROW;
      continue;
    }
    const color = r.main ? "var(--series-d)" : "var(--ink)";
    if (dots) {
      win.forEach((v, j) => {
        if (v === null) return;
        if (u.flags[j]) g.append(svg("circle", { cx: X(j), cy: mid, r: 4.3, fill: color }));
        else g.append(svg("circle", { cx: X(j), cy: mid, r: 1.5, fill: "var(--axis)" }));
      });
    } else {
      const lo = Math.min(...xs), hi = Math.max(...xs);
      const Y = (v) => (hi === lo ? mid : y + ROW - 4 - ((v - lo) / (hi - lo)) * (ROW - LINE_TOP - 6));
      let d = "";
      win.forEach((v, j) => { if (v !== null) d += (d ? "L" : "M") + X(j).toFixed(1) + "," + Y(v).toFixed(1); });
      g.append(svg("path", { d, fill: "none", stroke: r.main ? "var(--series-d)" : "var(--ink-2)", "stroke-width": r.main ? 1.8 : 1.3, "stroke-linejoin": "round", "stroke-linecap": "round", opacity: r.main ? 1 : 0.85 }));
      win.forEach((v, j) => { if (u.flags[j] && v !== null) g.append(svg("circle", { cx: X(j), cy: Y(v), r: 3.4, fill: color, stroke: "var(--surface)", "stroke-width": 1.5 })); });
    }
    win.forEach((v, j) => {
      if (!u.flags[j] || v === null) return;
      const o = j - MT_BEFORE;
      if (Math.abs(o) <= 1) { if (!around.includes(r.name())) around.push(r.name()); } else if (o > 1 && !later.some((z) => z[0] === r.name())) later.push([r.name(), o]);
    });
    // what that window did on the day itself
    const c = u.ch[MT_BEFORE];
    let lab = "—";
    if (win[MT_BEFORE] === null) lab = r.w && ["nasdaq", "vix", "usd"].includes(r.w) ? "closed" : "—";
    else if (c !== null && c !== undefined) lab = r.kind === "diff" ? `${c > 0 ? "+" : c < 0 ? MINUS : ""}${Math.abs(Math.round(c))}` : r.kind === "count" ? `${win[MT_BEFORE]}` : pct(Math.exp(c) - 1, 0);
    g.append(svg("text", { x: W - R, y: y + 12, "text-anchor": "end", "font-size": 11.5, "font-weight": 650, fill: u.flags[MT_BEFORE] ? "var(--ink)" : "var(--muted)", style: "font-variant-numeric:tabular-nums" }, `the day ${lab}`));
    y += ROW;
  }
  for (const o of [-7, 0, 7, 14, 30]) {
    g.append(svg("text", { x: X(o + MT_BEFORE), y: H - 6, "text-anchor": o === -7 ? "start" : o === 30 ? "end" : "middle", "font-size": 10.5, fill: o === 0 ? "var(--ink-2)" : "var(--muted)", "font-weight": o === 0 ? 700 : 400 }, o === 0 ? "the day" : o > 0 ? `+${o}d` : `${MINUS}${-o}d`));
  }
  box.textContent = "";
  box.append(root);
  const waiting = Object.values(status).some((z) => z === "wait");
  const sum = $("mt-sum");
  if (waiting) { sum.textContent = ""; return; }
  const parts = [];
  if (!around.length) parts.push("Around the day (−1 to +1), no window had an unusual day.");
  else if (around.length === 1) parts.push(`Around the day (−1 to +1), only ${around[0]} had an unusual day.`);
  else parts.push(`Around the day (−1 to +1), these had an unusual day: ${around.join(", ")}.`);
  if (later.length) parts.push(`Later: ${later.map(([nme, o]) => `${nme} (+${o}d)`).join(", ")}.`);
  const busiest = Math.max(...colCount);
  if (busiest >= 3) parts.push(`The most at once: ${busiest} windows, on ${colCount.map((c, j) => (c === busiest ? j - MT_BEFORE : null)).filter((o) => o !== null).map((o) => (o === 0 ? "the day" : o > 0 ? `+${o}d` : `${MINUS}${-o}d`)).join(", ")}.`);
  sum.textContent = parts.join(" ");
  $("mt-note").textContent = dots
    ? "A big dot is an unusual day for that window; a small dot is an ordinary one. A lit column: three or more windows were unusual on the same day. “The day”: what each window did on the day itself, against the day before."
    : "Each line is scaled to its own range, so heights cannot be compared across rows. Markets are closed at weekends. “The day”: what each window did on the day itself, against the day before.";
}

/* ── Unusual days for every window over the coin's whole history (used by Together).
   frctlns does not choose which windows should go together — it counts, and shows which ones did (Nova, 2026-09-28).
   Hacker News counts are left out here (they can only be read a month at a time). ── */
function fullDaily(row, got) {
  const tl = ex.tl, n = tl.n;
  const out = new Array(n).fill(null);
  if (row.k === "price" || row.k === "fg") {
    const a = row.k === "price" ? tl.axes.price : tl.axes.sentiment;
    for (let i = 0; i + 1 < n; i++) { const v = a[i + 1]; out[i] = Number.isNaN(v) ? null : v; }
    return out;
  }
  const s = got[row.w];
  if (!s) return out;
  const off = dayNum(s.from) - tl.d0;
  for (let i = 0; i < n; i++) {
    const k = i - off;
    const v = k >= 0 && k < s.values.length ? s.values[k] : null;
    out[i] = typeof v === "number" && Number.isFinite(v) ? v : null;
  }
  return out;
}
/* the same rule as Moved together?: a change ≥ 3× the usual change of the year before (1.4826 × median |change|, refreshed weekly) */
function fullFlags(row, vals) {
  const n = vals.length;
  const ch = new Array(n).fill(null);
  let prev = null;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (v === null) continue;
    if (prev !== null) ch[i] = row.kind === "log" ? (v > 0 && prev > 0 ? Math.log(v / prev) : null) : v - prev;
    prev = v;
  }
  const flags = new Int8Array(n), z = new Float64Array(n);
  let sigma = null, lastAt = -Infinity;
  for (let i = 0; i < n; i++) {
    if (i - lastAt >= 7) {
      const base = [];
      for (let j = Math.max(0, i - 365); j < i; j++) if (ch[j] !== null) base.push(Math.abs(ch[j]));
      if (base.length >= 30) { base.sort((a, b) => a - b); sigma = 1.4826 * base[base.length >> 1]; } else sigma = null;
      lastAt = i;
    }
    const c = ch[i];
    if (c === null || !sigma) continue;
    const zz = Math.abs(c) / sigma;
    if (zz >= 3) { flags[i] = c > 0 ? 1 : -1; z[i] = zz; }
  }
  return { flags, z };
}
/* every window's unusual days over the coin's whole history (computed once per coin) */
const flagCache = new Map(); // coin → Promise<{ per, missing }>
const flagReady = new Map(); // coin → { per, missing }, once read
function flagData() {
  const coin = S.coin;
  if (flagCache.has(coin)) return flagCache.get(coin);
  const p = (async () => {
    const rows = TOGETHER.filter((r) => r.k && r.k !== "hn");
    const got = {};
    await Promise.allSettled(rows.filter((r) => r.w).map((r) => loadSeries(r.w).then((s) => { got[r.w] = s; })));
    const per = rows.map((r) => { const vals = fullDaily(r, got); return { r, name: r.name(), vals, ...fullFlags(r, vals) }; });
    const out = { per, missing: rows.filter((r) => r.w && !got[r.w]).map((r) => r.name()) };
    flagReady.set(coin, out);
    return out;
  })();
  p.catch(() => flagCache.delete(coin));
  flagCache.set(coin, p);
  return p;
}
/* a window counts for a day if it was unusual that day or the next (some windows answer a day late) */
const litAt = (q, j) => (q.flags[j] ? j : q.flags[j + 1] ? j + 1 : -1);
/* ── Same windows moved together (hindsight): the set of windows that jumped at once on a day, looked for on every other day.
   Only which windows — not which way (Nova, 2026-09-28): the directions are shown, so a match in direction is something you notice. ── */
const patternCache = new Map(); // "coin|day" → { pattern, results }
const patternKey = (day) => `${S.coin}|${day}`;
async function patternFor(day) {
  const key = patternKey(day);
  if (patternCache.has(key)) return patternCache.get(key);
  const { per } = await flagData();
  const i = dayNum(day) - ex.tl.d0;
  const pattern = [];
  per.forEach((q, k) => { const f = litAt(q, i); if (f >= 0) pattern.push({ k, name: q.name, dir: q.flags[f] }); });
  const out = { pattern, results: [] };
  if (pattern.length >= 2) {
    const found = [];
    for (let j = 0; j + 1 < ex.tl.n; j++) {
      if (Math.abs(j - i) < 14) continue;
      let ok = true, score = 0;
      const dirs = [];
      for (const pt of pattern) {
        const q = per[pt.k], f = litAt(q, j);
        if (f < 0) { ok = false; break; }
        dirs.push(q.flags[f]);
        score += Math.min(q.z[f], 12);
      }
      if (!ok) continue;
      const extras = per.filter((q, k) => !pattern.some((pt) => pt.k === k) && litAt(q, j) >= 0).map((q) => q.name);
      found.push({ index: j, day: ymdOf(ex.tl.d0 + j), dirs, extras, same: dirs.filter((d, x) => d === pattern[x].dir).length, score, later: j > i });
    }
    found.sort((a, b) => a.extras.length - b.extras.length || b.score - a.score);
    for (const f of found) {
      if (out.results.every((o) => Math.abs(o.index - f.index) >= 14)) out.results.push(f);
      if (out.results.length === 8) break;
    }
  }
  patternCache.set(key, out);
  return out;
}
const arrow = (d) => (d > 0 ? "↑" : "↓");
const patternText = (pattern, dirs) => pattern.map((pt, x) => `${pt.name} ${arrow(dirs ? dirs[x] : pt.dir)}`).join(" · ");
/* the coin 1, 7 and 30 days later. On the pair screen each box holds both days, your day first, in the days' colours */
function checksInto(box, rep, repD) {
  box.textContent = "";
  const val = (r, o) => { const p = r.points.find((x) => x.offset === o); return p && p.state === "seen" ? pct(p.change) : "—"; };
  for (const o of [1, 7, HORIZON]) {
    const c = el("div", { class: repD ? "check both" : "check" });
    if (repD) {
      for (const [r, color] of [[repD, "--series-d"], [rep, "--series-sel"]]) {
        const b = el("b");
        b.append(el("i", { style: `background:var(${color})` }), document.createTextNode(val(r, o)));
        c.append(b);
      }
    } else c.append(el("b", {}, val(rep, o)));
    c.append(el("small", {}, o === 1 ? "1 day later" : `${o} days later`));
    box.append(c);
  }
}
/* ── Places that overlap (2026-09-28, Shu and Nova: one search, several observations — "the kamakura").
   Behind it, every way runs with one fixed condition each; the day shows where the overlaps are, most overlap first, without the numbers.
   at 00:00  — where the market stood over the S.width days up to each day (default a week; the Observatory can change it). Nothing after either day.
   afterwards — the shape of the price from a little before to S.mv days after (a week). Hindsight.
   together  — the same set of windows jumped, on the day or the day after. Hindsight.
   the word  — another day the word left traces (when you came from the world). ── */
const SPAN_NAME = { 3: "3 days", 7: "week", 30: "month" };
const KIND_ORDER = ["p", "m", "v", "w"];
function kindTag(k, r) {
  if (k === "p") return `${r.pattern.length} windows`;
  if (k === "m") return "at 00:00";
  if (k === "v") return "afterwards";
  return `“${S.q}”`;
}
/* every place found for the day you stand on, merged by day: { day, index, by: { kind → what found it }, kind (the first of p, m, v, w), …that kind's fields } */
function placesNow() {
  const map = new Map();
  const add = (k, r) => {
    if (!r || r.day === S.day) return;
    let p = map.get(r.day);
    if (!p) { p = { day: r.day, index: dayNum(r.day) - ex.tl.d0, by: {} }; map.set(r.day, p); }
    p.by[k] = r;
  };
  if (res && !res.error) res.results.forEach((r) => add("m", r));
  movesNow().results.forEach((r) => add("v", r));
  const pr = patternCache.get(patternKey(S.day));
  if (pr) pr.results.forEach((r) => add("p", { ...r, pattern: pr.pattern }));
  if (S.q) momentsNow().filter((m) => m.day !== S.day).slice(0, 5).forEach((m) => add("w", { day: m.day, moment: m }));
  return [...map.values()]
    .map((p) => { const kind = KIND_ORDER.find((k) => p.by[k]); return { ...p.by[kind], ...p, kind, later: Object.values(p.by).some((x) => x.later), overlap: overlapOf(p.day) }; })
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index);
}
/* how much two days overlap, for the order of places (2026-09-28, Shu: most overlap first; the number itself is not shown):
   the mean of what "What overlapped?" shows for the pair — at 00:00, afterwards (an opposite shape counts as 0), and the share of your day's
   jumping windows that also jumped there (once the windows have been read) */
const overlapCache = new Map();
function overlapOf(day) {
  const fr = flagReady.get(S.coin);
  const key = `${S.coin}|${S.day}|${day}|${S.mode}|${S.width}|${[...S.off].sort()}|${S.mv}|${fr ? 1 : 0}`;
  if (overlapCache.has(key)) return overlapCache.get(key);
  const axes = {};
  for (const k of AXES) axes[k] = !S.off.has(k);
  const pa = ex.pairAlike(S.day, day, { mode: S.mode, width: S.width, axes, span: S.mv });
  const vals = [];
  if (!pa.looked.error) vals.push(pa.looked.similarity);
  if (!pa.moved.error) vals.push(Math.max(0, pa.moved.similarity));
  if (fr) {
    const i = dayNum(S.day) - ex.tl.d0, j = dayNum(day) - ex.tl.d0;
    const a = fr.per.filter((q) => litAt(q, i) >= 0);
    if (a.length) vals.push(a.filter((q) => litAt(q, j) >= 0).length / a.length);
  }
  const v = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
  overlapCache.set(key, v);
  return v;
}
/* how far away a place is in time: "4 years earlier" */
function howFar(day) {
  const d = dayNum(day) - dayNum(S.day), n = Math.abs(d), side = d < 0 ? "earlier" : "later";
  if (n >= 548) return `${Math.round(n / 365.25)} years ${side}`;
  if (n >= 60) return `${Math.round(n / 30.44)} months ${side}`;
  return `${n} day${n === 1 ? "" : "s"} ${side}`;
}
/* why a way found nothing for this day (nothing lining up is a result too) */
function noneWhy() {
  const out = [];
  if (!res || res.error) out.push(["at 00:00", res && res.error === "no axis can be observed for this window" && !S.off.size ? "too little past before this day" : "nothing could be compared"]);
  else if (!res.results.length) out.push(["at 00:00", res.searched ? "no earlier day had enough of this day's market to compare" : "no earlier day to compare with yet"]);
  const mv = movesNow();
  if (!mv.results.length) out.push(["afterwards", mv.error ? mv.error : "no other day moved like this"]);
  const pr = patternCache.get(patternKey(S.day));
  if (pr && pr.pattern.length < 2) out.push(["together", pr.pattern.length ? `only ${pr.pattern[0].name} jumped on this day` : "no window jumped on this day"]);
  else if (pr && !pr.results.length) out.push(["together", `${patternText(pr.pattern)} — this set never jumped together again`]);
  return out;
}
let placesToken = 0;
async function renderPlaces() {
  const box = $("s-places"), note = $("s-places-note");
  const token = ++placesToken;
  const draw = (looking) => {
    const list = placesNow();
    box.textContent = "";
    list.forEach((p, i) => {
      const b = el("button", { type: "button", class: "row place", style: `animation-delay:${i * 0.03}s`, "aria-label": `${p.day}: ${KIND_ORDER.filter((k) => p.by[k]).map((k) => kindTag(k, p.by[k])).join(", ")}` });
      const tags = el("span", { class: "tags" });
      for (const k of KIND_ORDER) if (p.by[k]) tags.append(el("span", { class: `tag k-${k}` }, kindTag(k, p.by[k])));
      b.append(whenCell(p.day), el("span", { class: "chev", "aria-hidden": "true" }, "›"), tags, el("span", { class: "hist far" }, howFar(p.day)));
      b.addEventListener("click", () => go({ view: "past", other: p.day, open: null, x: false }));
      box.append(b);
    });
    if (!list.length) box.append(el("p", { class: "empty" }, "No other day overlapped with this one."));
    if (looking) box.append(el("p", { class: "empty" }, "Still looking through every window…"));
    note.textContent = "";
    const why = noneWhy();
    if (why.length) note.append(textWithDates("span", {}, `No overlap ${why.map(([k, w]) => `${k}: ${w}`).join(" · ")}.`));
  };
  draw(!patternCache.has(patternKey(S.day)));
  if (!patternCache.has(patternKey(S.day))) {
    try { await patternFor(S.day); } catch { /* the windows could not be read: the other ways still stand */ }
    if (token !== placesToken || S.view !== "stand") return;
    draw(false);
  }
}

/* ══ 3. two days side by side: was it really alike? what happened next? stand there ══ */
/* the days you can step between: the market's look-alikes, or the other moments of the word */
function pairList() {
  return placesNow();
}
function pairNow() {
  if (!S.other) return null;
  return pairList().find((r) => r.day === S.other) || null;
}
function stepPair(k) {
  const list = pairList();
  const i = list.findIndex((r) => r.day === S.other);
  const j = i + k;
  if (j >= 0 && j < list.length) go({ other: list[j].day, open: null }, false);
}
/* a later day (filled in when the past is short) is after D: its replay is hindsight, so it may run to the archive's end.
   A moment of a word is chosen with today's records, so it too is shown to the archive's end */
const limitFor = (r) => (r && (r.later || r.kind === "w" || r.kind === "v" || r.kind === "p") ? ex.last : S.day);
/* go deeper into that day on its own */
function exploreThere() {
  const r = pairNow();
  if (!r) return;
  S.day = r.day;
  S.other = null;
  S.view = "stand";
  S.x = true;
  S.open = null;
  run(false);
  writeHash(true);
}
const kindObj = (place, k) => ({ ...place.by[k], kind: k, day: place.day, index: place.index });
function renderPast() {
  const r = pairNow();
  const list = pairList();
  const i = list.findIndex((x) => x.day === r.day);
  const t = $("p-title");
  t.textContent = "";
  const dayTag = (d, color) => { const sp = el("span", { style: "white-space:nowrap" }); sp.append(el("i", { style: `background:var(${color})` }), document.createTextNode(d)); return sp; };
  t.append(dayTag(S.day, "--series-d"), el("span", { class: "ar", "aria-label": "and" }, "↔"), dayTag(r.day, "--series-sel"));
  const found = KIND_ORDER.filter((k) => r.by[k]);
  const sub = $("p-sub");
  sub.textContent = "";
  const tags = el("span", { class: "tags" });
  for (const k of found) tags.append(el("span", { class: `tag k-${k}` }, kindTag(k, r.by[k])));
  sub.append(tags, el("span", { class: "nth" }, `${howFar(r.day)}${list.length > 1 ? ` · place ${i + 1} of ${list.length}` : ""}`));
  const w = r.by.w, pp = r.by.p;
  $("p-what").textContent = w && w.moment.hn ? w.moment.hn.title
    : pp ? `${pp.same === pp.pattern.length ? "Every window moved the same way on both days." : `${pp.same} of ${pp.pattern.length} windows moved the same way on both days.`}${pp.extras.length ? ` Here, also: ${pp.extras.join(", ")}.` : ""}` : "";
  $("p-hist").textContent = histTag(r.by.m && r.by.m.coverage_days && r.by.m.coverage_days.candidate, r.day) || "";
  $("p-prev").disabled = i <= 0;
  $("p-next").disabled = i >= list.length - 1;
  $("k-d").textContent = S.day;
  $("k-p").textContent = r.day;
  renderLens(r);
  renderWhyPair(r, found);
  renderPair(r);
  drawNext(r, false);
  $("stand").textContent = `Explore ${r.day}`;
  $("stand-note").textContent = "That day on its own: its windows at 00:00, what happened next, what moved with it — and the places that overlap with it.";
}
/* Why this pair? — the conditions each way used, and what exactly was compared (Nova: the number is the result, the condition is the explanation) */
function renderWhyPair(r, found) {
  const box = $("p-cmp");
  box.textContent = "";
  const cond = {
    m: `At 00:00 — ${S.mode === "TRAJECTORY" ? "how the market moved" : "where the market stood"} over the ${S.width === 1 ? "day itself" : `${S.width} days up to each day`}, each at its own 00:00. Nothing after either day is used.`,
    v: `Afterwards — the shape of the price from ${Math.max(1, Math.round(S.mv / 3))} days before to ${S.mv === 3 ? "3 days" : `a ${SPAN_NAME[S.mv]}`} after each day. Shape only, at the same or half or twice the speed. Hindsight.`,
    p: "Together — which of 8 windows made an unusual jump (at least 3× that window's usual day-to-day change over the year before) on the day or the day after. Hindsight.",
    w: `The word — the days “${S.q}” left traces: a Wikipedia peak or a top Hacker News story. Found with today's records.`,
  };
  box.append(el("p", { class: "t" }, `Found by: ${found.map((k) => kindTag(k, r.by[k])).join(" · ")}`));
  const ul = el("ul", { class: "conds" });
  for (const k of KIND_ORDER) if (k !== "w" || S.q) ul.append(el("li", { class: found.includes(k) ? "on" : "" }, cond[k]));
  box.append(ul);
  for (const k of found) renderCompared(kindObj(r, k), box);
}
/* the pair chart starts early enough to show the whole compared range (a 30-day match starts at −29d, 2026-09-28, Shu) */
function wideRep(day, limitDay, lo) {
  const rep = ex.replay(day, limitDay);
  if (lo >= LO) return rep;
  const tl = ex.tl, P = tl.axes.price;
  const i = dayNum(day) - tl.d0, lim = dayNum(limitDay) - tl.d0, p0 = P[i];
  const path = [];
  for (let o = lo; o <= HI; o++) {
    const j = i + o;
    if (j < 0 || j >= tl.n || j > lim) { path.push(null); continue; }
    const p = P[j];
    path.push(Number.isNaN(p) || !(p0 > 0) ? null : p / p0 - 1);
  }
  return { ...rep, path, from: lo };
}
/* which days around your day the match was made on, as offsets from the day (null: nothing was compared) */
function comparedSpan(r) {
  if (r.kind === "w") return null;
  if (r.kind === "p") return [0, 1];
  if (r.kind === "v") { const m = movesNow(); return [-m.lead, m.span]; }
  const w = res && res.width ? res.width : S.width;
  return [-(w - 1), 0];
}
function drawNext(r, animate) {
  const band = comparedSpan(r);
  const lo = Math.min(LO, band ? band[0] : LO);
  const D = wideRep(S.day, ex.last, lo);
  const selRep = wideRep(r.day, limitFor(r), lo);
  checksInto($("checks"), selRep, D);
  const series = [];
  pairList().forEach((x) => { if (x.day !== r.day && x.by[r.kind]) series.push({ kind: "context", name: x.day, rep: wideRep(x.day, limitFor(x), lo) }); });
  series.push({ kind: "d", name: S.day, rep: D, open: true });
  series.push({ kind: "sel", name: r.day, rep: selRep });
  const v = charts.pair;
  Object.assign(v, { series, cursor: null, animate, lo, band, note: null });
  const lg = $("legend");
  lg.textContent = "";
  const key = (color, text) => { const s = el("span"); s.append(el("i", { style: `background:var(${color})` }), document.createTextNode(text)); return s; };
  lg.append(key("--series-d", `${S.day} (your day)`), key("--series-sel", `${r.day} (that day)`));
  if (series.some((s) => s.kind === "context")) lg.append(key("--context", `the other places found ${r.kind === "w" ? `by “${S.q}”` : r.kind === "v" ? "afterwards" : r.kind === "p" ? "by the same windows" : "at 00:00"}`));
  drawChart(v);
  v.animate = false;
  // what came after is shown for both days; what differs is whether it was used to find the pair (Nova, 2026-09-28)
  const by = r.by || { [r.kind]: r };
  const parts = [];
  if (by.m) parts.push(`At 00:00 used only what the market showed up to 00:00 on each day${by.m.later ? ` (${r.day} is later in history)` : ""}.`);
  if (by.v || by.p) parts.push(`${by.v && by.p ? "Afterwards and together" : by.v ? "Afterwards" : "Together"} used what happened after (hindsight)${by.v && by.v.stretch !== 1 ? ` — that day's move took ${by.v.stretch < 1 ? "about half" : "about twice"} as long` : ""}.`);
  if (by.w) parts.push(`The word was found with today's records of “${S.q}”.`);
  $("p-hidden").textContent = parts.join(" ");
  const p1 = D.points.find((p) => p.offset === 1);
  if (p1 && p1.state === "unknown") $("p-hidden").textContent += ` ${S.day} is the newest day in the archive, so what came after it is not known yet.`;
}

/* ── what was compared: the two ranges of days, drawn as two lines on the same axis ──
   Looked alike (STATE): the price's place within its own past year, day by day (frctlns compares every part of the market; the price stands for them here).
   Looked alike (TRAJECTORY): the price path from the window's first day.
   Moved alike: the shape of the price, each line on its own scale (the other day stretched to the same length) */
function comparedOf(r) {
  const tl = ex.tl, P = tl.axes.price;
  const q = dayNum(S.day) - tl.d0, c = r.index;
  const day = (i) => ymdOf(tl.d0 + i);
  if (r.kind === "w") return { title: `Found by the word “${S.q}”, not by the market — nothing was compared.`, lines: null };
  if (r.kind === "p") return { title: "Compared: which windows jumped at once (a day's change at least 3× that window's usual), on the day or the day after — not the shape of the market.", lines: null, table: r.pattern.map((pt, x) => [pt.name, arrow(pt.dir), arrow(r.dirs[x])]) };
  if (r.kind === "v") {
    const m = movesNow();
    const k = r.stretch;
    const a0 = q - m.lead, a1 = q + m.span;
    const b0 = c - Math.max(1, Math.round(m.lead * k)), b1 = c + Math.max(1, Math.round(m.span * k));
    const N = 40;
    const shape = (a, b) => {
      const out = [];
      for (let j = 0; j < N; j++) {
        const t = a + ((b - a) * j) / (N - 1), x0 = Math.floor(t), x1 = Math.min(b, x0 + 1), f = t - x0;
        const v = P[x0] > 0 && P[x1] > 0 ? Math.log(P[x0]) * (1 - f) + Math.log(P[x1]) * f : NaN;
        out.push(v);
      }
      const ok = out.filter((v) => !Number.isNaN(v));
      const mean = ok.reduce((s, v) => s + v, 0) / ok.length;
      const sd = Math.sqrt(ok.reduce((s, v) => s + (v - mean) ** 2, 0) / ok.length) || 1;
      return out.map((v) => (Number.isNaN(v) ? null : (v - mean) / sd));
    };
    return {
      title: `Compared: the shape of the price from ${m.lead} day${m.lead === 1 ? "" : "s"} before to ${m.span} days after each day${k !== 1 ? ` (that day's move took ${k < 1 ? "half" : "twice"} as long, so its days are squeezed or stretched to fit)` : ""}.`,
      ranges: [[day(a0), day(a1)], [day(b0), day(b1)]],
      lines: [shape(a0, a1), shape(b0, b1)],
      mark: m.lead / (m.lead + m.span),
      axis: [`${MINUS}${m.lead}d`, "the day", `+${m.span}d`],
      note: "Shape only: each line is on its own scale.",
    };
  }
  const w = res.width;
  if (w === 1) return { title: `Compared: the day itself, as it stood at 00:00 UTC (a 1-day window) — every part of the market, at once.`, ranges: [[S.day, S.day], [r.day, r.day]], lines: null };
  const traj = res.mode === "TRAJECTORY";
  const line = (e) => {
    const out = [];
    for (let i = e - w + 1; i <= e; i++) {
      if (traj) out.push(P[i] > 0 && P[e - w + 1] > 0 ? P[i] / P[e - w + 1] - 1 : null);
      else { const v = ex.st.value.price[i]; out.push(Number.isNaN(v) ? null : v); }
    }
    return out;
  };
  return {
    title: traj ? `Compared: how the market moved over the ${w} days up to each day.` : `Compared: where the market stood over the ${w} days up to each day, day by day.`,
    ranges: [[day(q - w + 1), S.day], [day(c - w + 1), r.day]],
    lines: [line(q), line(c)],
    mark: 1,
    axis: [`${MINUS}${w - 1}d`, "", "the day"],
    note: traj ? "The price's change from the first day of each range (frctlns also compares volume, volatility and Fear & Greed)." : "The price's place within its own past year: 0 = its lowest, 1 = its highest (frctlns compares every part of the market this way; the price stands for them here).",
    fixed01: !traj,
  };
}
/* ── the same two days through each lens (2026-09-28, Shu and Nova: the same pair, different ways of looking).
   Each row measures this pair the way that search measures, and says over which days. ── */
async function pairTogether(dq, dc) {
  const { per } = await flagData();
  const i = dayNum(dq) - ex.tl.d0, j = dayNum(dc) - ex.tl.d0;
  const a = per.filter((q) => litAt(q, i) >= 0).map((q) => q.name);
  const b = per.filter((q) => litAt(q, j) >= 0).map((q) => q.name);
  return { a, b, both: a.filter((x) => b.includes(x)) };
}
let lensToken = 0;
async function renderLens(r) {
  const box = $("p-lens");
  const token = ++lensToken;
  const axes = {};
  for (const k of AXES) axes[k] = !S.off.has(k);
  const pa = ex.pairAlike(S.day, r.day, { mode: S.mode, width: S.width, axes, span: S.mv });
  const rows = [];
  const L = pa.looked;
  rows.push({ pk: "m", name: "At 00:00", v: L.error ? "—" : `${Math.round(L.similarity * 100)}%`, off: !!L.error,
    d: L.error ? L.error : `${L.mode === "TRAJECTORY" ? "how the market moved" : "where the market stood"} over the ${L.width === 1 ? "day itself" : `${L.width} days up to each day`}, each at its own 00:00` });
  const M = pa.moved;
  rows.push({ pk: "v", name: "Afterwards", v: M.error ? "—" : M.similarity > 0 ? `${Math.round(M.similarity * 100)}%` : "opposite", off: !!M.error || M.similarity <= 0,
    d: M.error ? M.error : `the shape of the price from ${M.lead} day${M.lead === 1 ? "" : "s"} before to ${SPAN_NAME[M.span] === "3 days" ? "3 days" : `a ${SPAN_NAME[M.span]}`} after${M.stretch !== 1 && M.similarity > 0 ? ` (that day's move took ${M.stretch < 1 ? "half" : "twice"} as long)` : ""} · ${pct(M.queryMove)} here, ${pct(M.move)} there · hindsight` });
  const draw = (tg) => {
    const all = [...rows];
    if (tg === null) all.push({ pk: "p", name: "Together", v: "…", off: true, d: "looking at every window…" });
    else if (tg.error) all.push({ pk: "p", name: "Together", v: "—", off: true, d: `could not be looked at this time (${tg.error})` });
    else all.push({ pk: "p", name: "Together", v: tg.a.length ? `${tg.both.length} of ${tg.a.length}` : "—", off: !tg.both.length,
      d: !tg.a.length ? "no window jumped on your day (on the day or the day after)"
        : tg.both.length ? `jumped on both days: ${tg.both.join(", ")} · hindsight` : `none of your day's ${tg.a.length} windows jumped on that day · hindsight` });
    if (S.q) {
      const ms = momentsNow();
      const inQ = ms.some((m) => m.day === S.day), inC = ms.some((m) => m.day === r.day);
      all.push({ pk: "w", name: "The word", v: inQ && inC ? "both" : inQ || inC ? "one" : "—", off: !(inQ && inC),
        d: inQ && inC ? `each is a moment of “${S.q}”` : inQ || inC ? `only ${inQ ? "your day" : "that day"} is a moment of “${S.q}”` : `neither is a moment of “${S.q}”` });
    }
    box.textContent = "";
    box.append(el("h3", {}, "What overlapped?"));
    for (const x of all) {
      const row = el("div", { class: `lr${r.by && r.by[x.pk] ? " cur" : ""}${x.off ? " off" : ""}` });
      row.append(el("span", { class: "ln" }, x.name), el("span", { class: "lv" }, x.v), textWithDates("span", { class: "ld" }, x.d));
      box.append(row);
    }
  };
  draw(null);
  let tg;
  try { tg = await pairTogether(S.day, r.day); } catch (e) { tg = { error: e.message }; }
  if (token !== lensToken || S.view !== "past") return;
  draw(tg);
}
function renderCompared(r, into) {
  const box = el("div", { class: "cmpk" });
  into.append(box);
  const cmp = comparedOf(r);
  box.append(el("p", { class: "t" }, cmp.title));
  if (cmp.ranges) {
    const rr = el("div", { class: "r" });
    cmp.ranges.forEach(([a, b], j) => {
      const sp = el("span");
      sp.append(el("i", { style: `background:var(${j ? "--series-sel" : "--series-d"})` }), document.createTextNode(a === b ? a : `${a} → ${b}`));
      rr.append(sp);
    });
    box.append(rr);
  }
  if (cmp.table) {
    const t = el("div", { class: "ptab" });
    t.append(el("span", {}, ""), el("span", { class: "h" }, "your day"), el("span", { class: "h" }, "that day"));
    for (const [name, a, b] of cmp.table) t.append(el("span", { class: "n2" }, name), el("span", { class: `d${a === b ? " same" : ""}`, style: "color:var(--series-d)" }, a), el("span", { class: `d${a === b ? " same" : ""}`, style: "color:var(--series-sel)" }, b));
    box.append(t, el("p", { class: "n" }, "↑ went up that day, ↓ went down. frctlns looked only for the same windows, not the same directions."));
    return;
  }
  if (!cmp.lines) return;
  const W = Math.max(280, Math.round(box.getBoundingClientRect().width) - 24 || 330), H = 96;
  const m = { l: 4, r: 4, t: 8, b: 18 };
  const all = cmp.lines.flat().filter((v) => v !== null);
  let lo = cmp.fixed01 ? 0 : Math.min(...all), hi = cmp.fixed01 ? 1 : Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
  const root = svg("svg", { viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  const n = cmp.lines[0].length;
  const X = (j) => m.l + (n === 1 ? 0.5 : j / (n - 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * (H - m.t - m.b);
  if (cmp.mark !== undefined) {
    const xm = m.l + cmp.mark * (W - m.l - m.r);
    root.append(svg("line", { x1: xm, x2: xm, y1: m.t - 4, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
  }
  cmp.lines.forEach((ln, j) => {
    let d = "";
    ln.forEach((v, i) => { if (v !== null) d += (d && ln[i - 1] !== null ? "L" : "M") + X(i).toFixed(1) + "," + Y(v).toFixed(1); });
    root.append(svg("path", { d, fill: "none", stroke: `var(${j ? "--series-sel" : "--series-d"})`, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  });
  const [l0, l1, l2] = cmp.axis;
  root.append(svg("text", { x: m.l, y: H - 4, "font-size": 10.5, fill: "var(--muted)" }, l0));
  if (l1) root.append(svg("text", { x: m.l + cmp.mark * (W - m.l - m.r), y: H - 4, "text-anchor": "middle", "font-size": 10.5, "font-weight": 700, fill: "var(--ink-2)" }, l1));
  root.append(svg("text", { x: W - m.r, y: H - 4, "text-anchor": "end", "font-size": 10.5, "font-weight": l2 === "the day" ? 700 : 400, fill: l2 === "the day" ? "var(--ink-2)" : "var(--muted)" }, l2));
  box.append(root, el("p", { class: "n" }, cmp.note));
}

/* both days through the same windows, each as it looked at its own 00:00 UTC.
   The windows are ordered by how much the two days overlap through them (Shu, 2026-09-28: what has little to do with the pair should not sit on top).
   Ties and windows without a number keep this order: crypto, attention to it, money, the world */
const PAIR = [
  { k: "market", name: "Market" }, { k: "network", name: "Bitcoin network" }, { k: "attention", name: "Attention" },
  { k: "hn", name: "Hacker News" }, { k: "x", name: "X" }, { k: "money", name: "Money" },
  { k: "earth", name: "Earth" }, { k: "sky", name: "Sky" }, { k: "weather", name: "Weather" },
];
/* how alike the two days look through one window: 1 − the mean gap between their places within each one's own past year
   (the market: every part of it; the others as in the Observatory's "Through each window"). Headlines, pictures and a door have no number */
function pairScore(k, q, c, comps) {
  const cols = k === "market" ? AXES.filter((a) => !S.off.has(a)).map((a) => ex.st.value[a]).filter(Boolean) : comps[k] ? comps[k].comps : null;
  if (!cols) return null;
  let sum = 0, n = 0;
  for (const col of cols) {
    const a = col[q], b = col[c];
    if (a === undefined || b === undefined || Number.isNaN(a) || Number.isNaN(b)) continue;
    sum += Math.abs(a - b);
    n++;
  }
  return n ? 1 - sum / n : null;
}
function pairOrder(q, c, comps) {
  return PAIR.map((t, i) => ({ t, i, score: pairScore(t.k, q, c, comps) }))
    .sort((x, y) => (y.score ?? -1) - (x.score ?? -1) || x.i - y.i);
}
const SCENE_KEY = { hn: "hacker_news", sky: "apod", earth: "earthquakes", money: "fx", weather: "weather", x: "x" };
/* what the world had published by 00:00 UTC of a day: each window from day − its as_of_lag */
async function asOfSource(day) {
  const byLag = new Map();
  const [s1, s2] = await Promise.all([loadScene(ymdOf(dayNum(day) - 1)), loadScene(ymdOf(dayNum(day) - 2))]);
  byLag.set(1, s1); byLag.set(2, s2);
  const time = s1.window_time || {};
  const extra = [...new Set(Object.values(time).map((t) => t.as_of_lag).filter((l) => Number.isInteger(l) && l > 0 && !byLag.has(l)))];
  const more = await Promise.all(extra.map((l) => loadScene(ymdOf(dayNum(day) - l))));
  extra.forEach((l, i) => byLag.set(l, more[i]));
  return (k) => {
    const lag = time[k] && Number.isInteger(time[k].as_of_lag) && time[k].as_of_lag > 0 ? time[k].as_of_lag : 1;
    return { w: byLag.get(lag).windows[k], day: ymdOf(dayNum(day) - lag), time };
  };
}
let pairToken = 0;
async function renderPair(r) {
  const grid = $("p-tiles"), openBox = $("p-open");
  const token = ++pairToken;
  const q = dayNum(S.day) - ex.tl.d0, c = r.index;
  const draw = (A, B, comps, loading) => {
    grid.textContent = "";
    pairOrder(q, c, comps).forEach(({ t, score }, i) => {
      const b = el("button", { type: "button", class: "tile", "data-k": t.k, "aria-expanded": String(S.open === t.k), style: `animation-delay:${i * 0.03}s` });
      const two = el("span", { class: "two" });
      const g = [pairGlimpse(t.k, A, q, comps, loading), pairGlimpse(t.k, B, c, comps, loading)];
      g.forEach((text, j) => { const sp = el("span"); sp.append(el("i", { style: `background:var(${j ? "--series-sel" : "--series-d"})` }), el("em", {}, text)); two.append(sp); });
      const tn = el("span", { class: "tn" }, t.name);
      if (score !== null && !loading) tn.append(el("span", { class: "ta", title: "how alike the two days look through this window" }, `${Math.round(score * 100)}%`));
      b.append(tn, two);
      b.addEventListener("click", () => go({ open: S.open === t.k ? null : t.k }, false));
      grid.append(b);
    });
    openBox.textContent = "";
    if (S.open && !loading) openBox.append(openPair(S.open, A, B, comps, q, c, r));
  };
  draw(null, null, {}, true);
  let A = null, B = null;
  const comps = {};
  const fail = (e) => () => ({ w: { state: "absent", reason: `could not be read this time (${e.message})` }, day: S.day, time: {} });
  await Promise.allSettled([
    asOfSource(S.day).then((g) => { A = g; }).catch((e) => { A = fail(e); }),
    asOfSource(r.day).then((g) => { B = g; }).catch((e) => { B = fail(e); }),
    windowComps("attention").then((x) => { comps.attention = x; }).catch(() => { comps.attention = null; }),
    windowComps("network").then((x) => { comps.network = x; }).catch(() => { comps.network = null; }),
    windowComps("weather").then((x) => { comps.weather = x; }).catch(() => { comps.weather = null; }),
  ]);
  if (token !== pairToken || S.view !== "past") return;
  draw(A, B, comps, false);
}
function pairGlimpse(k, get, idx, comps, loading) {
  if (k === "market") return usdShort(ex.tl.axes.price[idx]);
  if (loading) return "…";
  if (k === "attention") { const W = comps.attention; return W && !Number.isNaN(W.raw.views[idx]) ? `${compact(W.raw.views[idx])} views` : "–"; }
  if (k === "network") { const W = comps.network; return W && !Number.isNaN(W.raw.tx[idx]) ? `${compact(W.raw.tx[idx])} tx` : "–"; }
  if (k === "x") return "search ↗";
  const { w } = get(SCENE_KEY[k]);
  if (!on(w)) return "–";
  if (k === "weather") return `${Math.round(w.temp_max_c)}° ${w.weather || ""}`.trim();
  if (k === "hn") return w.items.length ? w.items[0].title : "–";
  if (k === "sky") return w.title || "(untitled)";
  if (k === "earth") return w.count_m45 === null ? "–" : `${int(w.count_m45)} quakes`;
  if (k === "money") return w.usd_jpy === null ? "–" : `¥${Number(w.usd_jpy).toFixed(1)}`;
  return "–";
}
/* one window, opened: your day above, that day below — the same view of both */
function openPair(k, A, B, comps, q, c, r) {
  const name = (PAIR.find((t) => t.k === k) || {}).name || k;
  const box = winBox(k === "sky" ? "Sky · NASA Picture of the Day" : k === "earth" ? "Earth · earthquakes M4.5+" : k === "money" ? "Money · ECB rates" : k === "network" ? "Bitcoin network · the same for every coin" : name, null);
  if (k === "weather") box.append(placeSelect());
  const side = (label, day, color, get, idx) => {
    const d = el("div", { class: "side" });
    const h = el("h5");
    h.append(el("i", { style: `background:var(${color})` }), document.createTextNode(`${label} · ${day}`));
    const body = sideBody(k, get, idx, comps, day);
    if (body.shows && body.shows !== day) h.append(el("small", {}, `shows ${body.shows}`));
    d.append(h, ...body.nodes);
    return d;
  };
  box.append(side("Your day", S.day, "--series-d", A, q), side("That day", r.day, "--series-sel", B, c));
  return box;
}
function sideBody(k, get, idx, comps, day) {
  const nodes = [];
  if (k === "market") { nodes.push(el("p", { class: "one" }, `${sym()} ${usd(ex.tl.axes.price[idx])} at 00:00 UTC`)); return { nodes }; }
  if (k === "attention") {
    const W = comps.attention;
    if (W && !Number.isNaN(W.raw.views[idx])) nodes.push(el("p", { class: "sub" }, `${int(W.raw.views[idx])} views of the English Wikipedia article “${coinNow().wiki}”`));
    const { w, day: shows } = get("wikipedia_en");
    if (!on(w)) nodes.push(absentLine(w || {}));
    else if (!w.items.length) nodes.push(absentLine({ reason: "no pages listed" }));
    else nodes.push(listOf(w.items.slice(0, 3), (i) => i.title, (i) => int(i.views)));
    const ja = get("wikipedia_ja").w;
    if (on(ja) && ja.items.length) nodes.push(listOf(ja.items.slice(0, 2), (i) => i.title, (i) => int(i.views)));
    return { nodes, shows };
  }
  if (k === "network") {
    const { w: bn, day: shows } = get("bitcoin_network");
    if (!on(bn)) nodes.push(absentLine(bn || {}));
    else {
      nodes.push(el("p", { class: "one" }, bn.transactions === null ? `Transactions: ${bn.transactions_why || "—"}` : `${int(Math.round(bn.transactions))} transactions`));
      nodes.push(el("p", { class: "sub" }, bn.hash_rate_avg7_th_s === null ? `Hash rate: ${bn.hash_rate_why || "—"}` : `Hash rate ${hashRate(bn.hash_rate_avg7_th_s)} (7-day average)`));
    }
    return { nodes, shows };
  }
  const { w, day: shows } = get(SCENE_KEY[k]);
  if (k === "x") {
    const a = link(xUrl(shows), `Search X for “${coinNow().x}” on ${shows} ↗`);
    a.className = "door";
    nodes.push(a);
    return { nodes, shows };
  }
  if (!on(w)) { nodes.push(absentLine(w || {})); return { nodes, shows }; }
  if (k === "weather") {
    const t = (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}`);
    nodes.push(el("p", { class: "one" }, `${w.weather ? w.weather[0].toUpperCase() + w.weather.slice(1) : "—"} · ${t(w.temp_min_c)} to ${t(w.temp_max_c)} °C`));
    nodes.push(el("p", { class: "sub" }, `${w.place || placeNow().name} · rain ${t(w.precipitation_mm)} mm · wind up to ${t(w.wind_max_kmh)} km/h`));
  } else if (k === "hn") {
    nodes.push(w.items.length ? listOf(w.items.slice(0, 3), (i) => i.title, (i) => `${int(i.points)} pts`) : absentLine({ reason: "no stories that day" }));
  } else if (k === "sky") {
    const p = el("p", { class: "one" });
    p.append(link(w.page_url, w.title || "(untitled)"));
    nodes.push(p);
    if (w.credit) nodes.push(el("p", { class: "sub" }, w.credit));
  } else if (k === "earth") {
    nodes.push(el("p", { class: "one" }, w.count_m45 === null ? "count unavailable" : `${int(w.count_m45)} on this UTC day`));
    const big = (w.biggest || [])[0];
    if (big) nodes.push(el("p", { class: "sub" }, `Largest: M${Number(big.mag).toFixed(1)} · ${big.place || "unnamed place"}`));
  } else if (k === "money") {
    const f = (v, d) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
    nodes.push(el("p", { class: "one" }, `1 USD = ${f(w.usd_jpy, 2)} JPY · ${f(w.usd_eur, 4)} EUR`));
    if (w.note) nodes.push(textWithDates("p", { class: "sub" }, w.note));
  }
  return { nodes, shows };
}
/* X is a door: a search for the coin's name on one UTC day (frctlns reads nothing from X) */
function xUrl(day) {
  const q = `${coinNow().x} since:${day} until:${ymdOf(dayNum(day) + 1)}`;
  return `https://x.com/search?q=${encodeURIComponent(q)}&src=typed_query&f=top`;
}
function placeSelect() {
  const sel = el("select", { class: "place", "aria-label": "Place for the weather window" });
  for (const pl of PLACES) { const o = el("option", { value: pl.id }, pl.name); if (pl.id === S.place) o.selected = true; sel.append(o); }
  sel.addEventListener("change", () => { S.place = sel.value; render(); writeHash(false); });
  return sel;
}

/* ── the nine windows of a day ──
   Each tile shows a glimpse; tap it to open that window. Only one is open at a time.
   On the day you stand on there are two sets: at 00:00 ("s"), and the day itself as recorded now ("h") */
const TILES = [
  { k: "market", name: "Market" },
  { k: "network", name: "Bitcoin network" },
  { k: "attention", name: "Attention" },
  { k: "hn", name: "Hacker News" },
  { k: "x", name: "X" },
  { k: "money", name: "Money" },
  { k: "earth", name: "Earth" },
  { k: "sky", name: "Sky" },
  { k: "weather", name: "Weather" },
];
const tileTokens = {};
/* which day each scene window is read from, for this view */
async function sceneSource(ctx) {
  if (ctx.kind === "hind") { const sc = await loadScene(S.day); return (k) => ({ w: sc.windows[k], day: S.day, time: sc.window_time || {} }); }
  return asOfSource(S.day);
}
const on = (x) => x && x.state === "on";
const VALUE_MARK = { current: "value today", revised: "revised later" };
async function renderTiles(prefix, ctx) {
  const grid = $(`${prefix}-tiles`), openBox = $(`${prefix}-open`);
  const token = (tileTokens[prefix] = (tileTokens[prefix] || 0) + 1);
  const q = dayNum(S.day) - ex.tl.d0;
  const openKey = (k) => `${prefix}.${k}`;
  // draw the tiles at once (glimpses fill in as the windows answer)
  const draw = (get, comps) => {
    grid.textContent = "";
    TILES.forEach((t, i) => {
      const b = el("button", { type: "button", class: "tile", "data-k": t.k, "aria-expanded": String(S.open === openKey(t.k)), style: `animation-delay:${i * 0.03}s` });
      const g = glimpse(t.k, ctx, get, comps, q);
      b.append(el("span", { class: "tn" }, t.name), el("span", { class: `tt${g.dim ? " dim" : ""}` }, g.text));
      b.addEventListener("click", () => go({ open: S.open === openKey(t.k) ? null : openKey(t.k) }, false));
      grid.append(b);
    });
    openBox.textContent = "";
    if (S.open && S.open.startsWith(prefix + ".") && get) {
      const w = openWindow(S.open.slice(prefix.length + 1), ctx, get, comps, q);
      if (w) openBox.append(w);
    }
  };
  draw(null, {});
  let get = null;
  const comps = {};
  const tasks = [sceneSource(ctx).then((g) => { get = g; }).catch((e) => { get = () => ({ w: { state: "absent", reason: `could not be read this time (${e.message})` }, day: S.day, time: {} }); })];
  for (const k of ["attention", "network"]) tasks.push(windowComps(k).then((c) => { comps[k] = c; }).catch(() => { comps[k] = null; }));
  await Promise.allSettled(tasks);
  if (token !== tileTokens[prefix] || S.view !== "stand") return;
  draw(get, comps);
}
/* the numeric windows (Attention, the network) are read at 00:00 from D − lag; "as recorded now" reads the day itself */
function numAt(W, key, q, ctx) {
  if (!W) return NaN;
  if (ctx.kind !== "hind") return W.raw[key][q];
  const v = W.day[key] ? W.day[key][q] : NaN;
  return v === undefined ? NaN : v;
}
function glimpse(k, ctx, get, comps, q) {
  const wait = { text: "…", dim: true };
  if (k === "market") return { text: usdShort(ex.tl.axes.price[q]) };
  if (k === "attention") {
    const W = comps.attention;
    if (W === undefined) return wait;
    const v = numAt(W, "views", q, ctx);
    return !Number.isNaN(v) ? { text: `${compact(v)} views` } : { text: "not open yet", dim: true };
  }
  if (k === "network") {
    const W = comps.network;
    if (W === undefined) return wait;
    const v = numAt(W, "tx", q, ctx);
    return !Number.isNaN(v) ? { text: `${compact(v)} tx` } : { text: "–", dim: true };
  }
  if (k === "x") return { text: "search ↗" };
  if (!get) return wait;
  const { w } = get(SCENE_KEY[k] || k);
  if (!on(w)) return { text: "–", dim: true };
  if (k === "weather") return { text: `${w.weather ? w.weather[0].toUpperCase() + w.weather.slice(1) : "—"} · ${Math.round(w.temp_max_c)}°` };
  if (k === "hn") return w.items.length ? { text: w.items[0].title } : { text: "–", dim: true };
  if (k === "sky") return { text: w.title || "(untitled)" };
  if (k === "earth") return { text: w.count_m45 === null ? "–" : `${int(w.count_m45)} quakes` };
  if (k === "money") return { text: w.usd_jpy === null ? "–" : `¥${Number(w.usd_jpy).toFixed(2)}` };
  return { text: "–", dim: true };
}
function openWindow(k, ctx, get, comps, q) {
  const label = (key, day, x) => {
    const t = get(key).time[key];
    const vs = x && on(x) && t ? VALUE_MARK[t.value_status] : null;
    return [ctx.kind === "asof" ? `shows ${day}` : null, vs].filter(Boolean).join(" · ") || null;
  };
  if (k === "market") {
    const b = winBox("Market", null);
    b.append(el("p", { class: "one" }, `${sym()} ${usd(ex.tl.axes.price[q])} at 00:00 UTC`));
    const rep = ex.replay(S.day, S.day);
    const p1 = rep.points.find((x) => x.offset === -1), p7 = rep.points.find((x) => x.offset === -7);
    b.append(el("p", { class: "sub" }, `${pct(p1 && p1.state === "seen" ? -p1.change / (1 + p1.change) : NaN)} since the day before · ${pct(p7 && p7.state === "seen" ? -p7.change / (1 + p7.change) : NaN)} since a week before`));
    const fg = ex.tl.axes.sentiment[q];
    if (!Number.isNaN(fg)) b.append(el("p", { class: "sub" }, `Fear & Greed ${Math.round(fg)} — the whole crypto market, not only ${sym()}`));
    return b;
  }
  if (k === "attention") {
    const b = winBox("Attention", null);
    const W = comps.attention;
    const v = numAt(W, "views", q, ctx);
    if (!Number.isNaN(v)) b.append(el("p", { class: "one" }, `${int(v)} views of the English Wikipedia article “${coinNow().wiki}”`), el("p", { class: "sub" }, ctx.kind === "hind" ? "that day's own count" : `the day's count that had come out by 00:00 UTC (${W.lag} days back)`));
    for (const [key, title, n] of [["wikipedia_en", "Most read · English Wikipedia", 5], ["wikipedia_ja", "Most read · Japanese Wikipedia", 3]]) {
      const { w, day } = get(key);
      b.append(el("h4", {}, [title, label(key, day, w)].filter(Boolean).join(" · ")));
      if (!on(w)) b.append(absentLine(w || {}));
      else if (!w.items.length) b.append(absentLine({ reason: "no pages listed" }));
      else b.append(listOf(w.items.slice(0, n), (i) => i.title, (i) => int(i.views)));
    }
    return b;
  }
  if (k === "weather") {
    const { w, day } = get("weather");
    const b = winBox("Weather", label("weather", day, w));
    b.append(placeSelect());
    if (!on(w)) b.append(absentLine(w || {}));
    else {
      const t = (v) => (v === null || v === undefined ? "—" : `${Number(v).toFixed(1)}`);
      b.append(el("p", { class: "one" }, `${w.weather ? w.weather[0].toUpperCase() + w.weather.slice(1) : "—"} · ${t(w.temp_min_c)} to ${t(w.temp_max_c)} °C`));
      b.append(el("p", { class: "sub" }, `Rain ${t(w.precipitation_mm)} mm · wind up to ${t(w.wind_max_kmh)} km/h · UTC day`));
    }
    return b;
  }
  if (k === "network") {
    const { w: bn, day } = get("bitcoin_network");
    const b = winBox("Bitcoin network", label("bitcoin_network", day, bn));
    if (!on(bn)) b.append(absentLine(bn || {}));
    else {
      const vs = (c, what) => (c === null || c === undefined ? "" : ` · ${pct(c)} vs ${what}`);
      b.append(el("p", { class: "one" }, bn.transactions === null ? `Transactions: ${bn.transactions_why || "—"}` : `${int(Math.round(bn.transactions))} transactions${vs(bn.transactions_change_7d, "a week before")}`));
      b.append(el("p", { class: "sub" }, bn.hash_rate_avg7_th_s === null ? `Hash rate: ${bn.hash_rate_why || "—"}` : `Hash rate ${hashRate(bn.hash_rate_avg7_th_s)} (7-day average)${vs(bn.hash_rate_avg7_change, "the week before")}`));
    }
    if (S.coin !== "1") b.append(el("p", { class: "sub" }, `Bitcoin's own chain, shown for every coin — the ground the whole market grew from, not ${sym()}'s network.`));
    return b;
  }
  if (k === "hn") {
    const { w: hn, day } = get("hacker_news");
    const b = winBox("Hacker News", label("hacker_news", day, hn));
    if (!on(hn)) b.append(absentLine(hn || {}));
    else if (!hn.items.length) b.append(absentLine({ reason: "no stories that day" }));
    else b.append(listOf(hn.items.slice(0, 5), (i) => i.title, (i) => `${int(i.points)} pts`));
    return b;
  }
  if (k === "sky") {
    const { w: ap, day } = get("apod");
    const b = winBox("Sky · NASA Picture of the Day", label("apod", day, ap));
    if (!on(ap)) b.append(absentLine(ap || {}));
    else {
      const p = el("p", { class: "one" });
      p.append(link(ap.page_url, ap.title || "(untitled)"));
      b.append(p);
      if (ap.credit) b.append(el("p", { class: "sub" }, ap.credit));
    }
    return b;
  }
  if (k === "earth") {
    const { w: eq, day } = get("earthquakes");
    const b = winBox("Earth · earthquakes M4.5+", label("earthquakes", day, eq));
    if (!on(eq)) b.append(absentLine(eq || {}));
    else {
      b.append(el("p", { class: "one" }, eq.count_m45 === null ? "count unavailable" : `${int(eq.count_m45)} on this UTC day`));
      const big = (eq.biggest || [])[0];
      if (big) b.append(el("p", { class: "sub" }, `Largest: M${Number(big.mag).toFixed(1)} · ${big.place || "unnamed place"}`));
    }
    return b;
  }
  if (k === "money") {
    const { w: fx, day } = get("fx");
    const b = winBox("Money · ECB rates", label("fx", day, fx));
    if (!on(fx)) b.append(absentLine(fx || {}));
    else {
      const f = (v, d) => (v === null || v === undefined ? "—" : Number(v).toFixed(d));
      b.append(el("p", { class: "one" }, `1 USD = ${f(fx.usd_jpy, 2)} JPY · ${f(fx.usd_eur, 4)} EUR`));
      if (fx.note) b.append(textWithDates("p", { class: "sub" }, fx.note));
    }
    return b;
  }
  if (k === "x") {
    const { day } = get("x");
    const b = winBox("X", "a door, not data");
    const a = link(xUrl(day), `Search X for “${coinNow().x}” on ${day} ↗`);
    a.className = "door";
    b.append(a);
    return b;
  }
  return null;
}

function coverageNote(r) {
  if (!r || !r.coverage_days) return null;
  const parts = [];
  if (r.coverage_days.candidate !== null && r.coverage_days.candidate < 365) parts.push(`this past day: ${r.coverage_days.candidate} days`);
  if (r.coverage_days.query !== null && r.coverage_days.query < 365) parts.push(`D: ${r.coverage_days.query} days`);
  return parts.length ? `scaled on less than a full year (${parts.join(", ")})` : null;
}

/* ══ 4. the Observatory: how it works, and the knobs ══ */
function renderHow() {
  $("how-coin").textContent = `${coinNow().name} · standing on ${S.day}`;
  for (const b of $("width").querySelectorAll("button")) {
    const w = Number(b.dataset.w);
    b.setAttribute("aria-pressed", String(w === S.width));
    b.disabled = S.mode === "TRAJECTORY" && w < 2;
  }
  for (const b of $("mode").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
  $("mode-hint").textContent = MODE_HINT[S.mode];
  const box = $("chips");
  box.textContent = "";
  // "attention" is a place kept in the market engine; the Attention window lives with the other windows
  const list = (S.mode === "TRAJECTORY" ? TRAJ_AXES : STATE_AXES).filter((k) => k !== "attention");
  for (const k of list) {
    const absent = res.presence[k] === "absent";
    const state = absent ? "absent" : S.off.has(k) ? "off" : "on";
    const b = el("button", { type: "button", class: "chip", "data-state": state, "aria-pressed": absent ? undefined : String(state === "on"), "aria-disabled": absent ? "true" : undefined, title: absent ? (ABSENT_WHY[k] || `${LABEL[k]} has no data for this window.`) : `Tap to turn ${state === "on" ? "off" : "on"}` });
    b.append(el("span", { class: "mark", "aria-hidden": "true" }, state === "on" ? "●" : state === "off" ? "○" : "–"), document.createTextNode(LABEL[k]));
    if (!absent) b.addEventListener("click", () => { S.off.has(k) ? S.off.delete(k) : S.off.add(k); run(); });
    box.append(b);
  }
  const why = $("absent-why");
  why.textContent = "";
  for (const k of list) {
    if (res.presence[k] !== "absent") continue;
    let reason;
    if (k === "sentiment") {
      const from = meta.fng_from || "2023-06-29";
      const lastF = (meta.last_on || {}).sentiment;
      if (S.day < from) reason = `the index starts on ${from}`;
      else if (lastF && S.day > lastF) reason = `the value for ${S.day} is not in CMC's history yet (new days arrive there with a delay)`;
      else reason = "not enough values in this window";
    } else reason = "less than 30 days of past to scale it, or no values in this window";
    why.append(el("div", {}, `– ${LABEL[k]}: ${reason}`));
  }

  const det = $("status-detail");
  det.textContent = "";
  if (res.error) det.append(el("div", {}, res.error));
  else if (!res.searched) det.append(textWithDates("div", {}, `No past window ended by ${res.strict.last_candidate_end} (D − ${HORIZON} days). The archive starts on ${ex.first}; a past only counts if its ${HORIZON}-day replay had already happened on D.`));
  else det.append(textWithDates("div", {}, `D = ${S.day}. Searched ${int(res.searched)} past windows that ended by ${res.strict.last_candidate_end} (D − ${HORIZON} days), so each replay had already happened on D.`));
  if (res.excluded) det.append(textWithDates("div", {}, `${int(res.candidates)} compared · ${int(res.excluded)} left out: less than half of D's axes (by weight) could be compared there.`));
  if (res.later_filled) det.append(textWithDates("div", {}, `Fewer than five days before D could be found, so ${res.later_filled} later day${res.later_filled === 1 ? " was" : "s were"} added (marked "later in history"). Their replays start after D's own next ${HORIZON} days, so D's future stays hidden.`));
  if (meta.complete === false && meta.missing_years && meta.missing_years.length) det.append(textWithDates("div", { class: "note" }, `The archive is still filling (missing: ${meta.missing_years.join(", ")}). Results use what is stored so far.`));
  const i = Math.max(0, res.results.findIndex((x) => x.day === S.other));
  const r = res.results[i] || null;
  renderTable(ex.replay(S.day, S.day), r ? ex.replay(r.day, limitFor(r)) : null, r, i);
  renderWhy(r);
  renderCompare();
  const times = $("times");
  times.textContent = "";
  loadScene(ymdOf(dayNum(S.day) - 1)).then((sc) => { if (S.view === "how") { times.textContent = ""; times.append(timeDetails(sc.window_time || {}, true)); } }).catch(() => {});
}

/* ── wheels for the big date ── */
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/* the months and days a wheel may offer, for the archive's first and last year */
function wheelRange(y, m) {
  const [fy, fm, fd] = ymdParts(ex.first), [ly, lm, ld] = ymdParts(ex.last);
  const m0 = y === fy ? fm : 1, m1 = y === ly ? lm : 12;
  const mm = Math.min(Math.max(m, m0), m1);
  const d0 = y === fy && mm === fm ? fd : 1, d1 = y === ly && mm === lm ? ld : daysIn(y, mm);
  return { fy, ly, m0, m1, mm, d0, d1 };
}
function fillSelect(sel, from, to, label, value) {
  const key = `${from}-${to}`;
  if (sel.dataset.key !== key) { // rebuild only when the choices change (a spinning wheel is left alone)
    sel.textContent = "";
    for (let v = from; v <= to; v++) sel.append(el("option", { value: v }, label(v)));
    sel.dataset.key = key;
  }
  sel.value = String(value);
}
function renderWheels() {
  const [y, m, d] = ymdParts(S.day);
  const r = wheelRange(y, m);
  fillSelect($("d-y"), r.fy, r.ly, String, y);
  fillSelect($("d-m"), r.m0, r.m1, (v) => MONTHS[v - 1], r.mm);
  fillSelect($("d-d"), r.d0, r.d1, String, Math.min(Math.max(d, r.d0), r.d1));
}
function pickFromWheels() {
  const y = Number($("d-y").value);
  const r = wheelRange(y, Number($("d-m").value));
  const d = Math.min(Math.max(Number($("d-d").value), r.d0), r.d1);
  const next = `${y}-${String(r.mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  if (next === S.day) return;
  setDay(next);
}

/* ── the scenes of a day (/scene) ── */
const scenes = new Map(); // "day|place" → Promise<body>
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

/* each window's four times (Nova's window metadata), as a table-like list */
const WINDOW_NAMES = { wikipedia_en: "Wikipedia · English", wikipedia_ja: "Wikipedia · 日本語", hacker_news: "Hacker News", apod: "NASA · Picture of the Day", earthquakes: "Earthquakes", fx: "Exchange rates · ECB", bitcoin_network: "Bitcoin network", weather: "Weather", x: "X" };
const VALUE_STATUS = { as_published: "as published", current: "today's value", revised: "revised later — today's value" };
function timeDetails(time, flat = false) {
  const d = el(flat ? "div" : "details", { class: "times" });
  if (!flat) d.append(el("summary", {}, "When each window knew what"));
  d.append(el("p", {}, "A date on a window is not the moment the world could see it. Each window shows the times it has — when it happened, when it could be seen, when the data came out, whether it changes later. At 00:00 frctlns uses only what had come out by then."));
  for (const k of Object.keys(WINDOW_NAMES)) {
    const t = time[k];
    if (!t) continue;
    const box = el("div", { class: "t" });
    box.append(el("h4", {}, WINDOW_NAMES[k]));
    const dl = el("dl");
    // the four times are a template: each window shows only the ones it has
    for (const [label, v] of [["Happened", t.event], ["Seen", t.observation], ["Came out", t.publication], ["Changes later", t.revision], ["Value shown", VALUE_STATUS[t.value_status] || t.value_status], ["At 00:00 uses", `D − ${t.as_of_lag} day${t.as_of_lag === 1 ? "" : "s"}`]]) {
      if (v) dl.append(el("dt", {}, label), el("dd", {}, v));
    }
    box.append(dl);
    d.append(box);
  }
  return d;
}

/* ── similar, through which window? (Market ranked the pasts; each other window says how alike they look from there) ── */
const CMP_WINDOWS = [
  { k: "network", name: "BTC network" },
  { k: "attention", name: "Attention" },
  { k: "weather", name: "Weather" },
];
const wseries = new Map();   // raw /window-series answers
const wcomps = new Map();    // "coin|window" → { comps, raw, day, lag } (computed once per coin: each coin has its own days)
const rawKey = (w) => (w === "weather" ? `weather|${S.place}` : w === "attention" ? `attention|${S.coin}` : w);
function loadSeries(w) {
  const key = rawKey(w);
  if (!wseries.has(key)) {
    const q = new URLSearchParams({ w });
    if (w === "weather") { const pl = placeNow(); q.set("lat", String(pl.lat)); q.set("lon", String(pl.lon)); q.set("place", pl.name); }
    if (w === "attention" && S.coin !== "1") q.set("id", S.coin);
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
  const key = `${S.coin}|${rawKey(k === "network" ? "tx" : k)}`;
  if (wcomps.has(key)) return wcomps.get(key);
  const tl = ex.tl;
  let out;
  if (k === "attention") {
    const s = await loadSeries("attention");
    out = { comps: [rangeState(asOfColumn(tl, s.from, s.values, s.as_of_lag, logOf))], raw: { views: asOfColumn(tl, s.from, s.values, s.as_of_lag) }, day: { views: asOfColumn(tl, s.from, s.values, 0) }, lag: s.as_of_lag };
  } else if (k === "network") {
    const [tx, hash] = await Promise.all([loadSeries("tx"), loadSeries("hash")]);
    const txc = asOfColumn(tl, tx.from, tx.values, tx.as_of_lag);
    out = { comps: [rangeState(txc), rangeState(asOfColumn(tl, hash.from, mean7(hash.values), hash.as_of_lag, logOf))], raw: { tx: txc }, day: { tx: asOfColumn(tl, tx.from, tx.values, 0) }, lag: tx.as_of_lag };
  } else {
    const s = await loadSeries("weather");
    const col = (v, f) => asOfColumn(tl, s.from, v, s.as_of_lag, f);
    const tmax = col(s.tmax), tmin = col(s.tmin);
    out = { comps: [rangeState(tmax), rangeState(tmin), rangeState(col(s.precip, (v) => Math.log1p(Math.max(0, v))))], raw: { tmax, code: col(s.code) }, day: {}, lag: s.as_of_lag, place: s.place };
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
  const got0 = {}, why = {};
  const pending = [];
  for (const w of CMP_WINDOWS) {
    const key = `${S.coin}|${rawKey(w.k === "network" ? "tx" : w.k)}`;
    if (wcomps.has(key)) got0[w.k] = wcomps.get(key);
    else pending.push(w.k);
  }
  drawCompare(got0, why, pending);
  if (!pending.length) return;
  const got = await Promise.allSettled(pending.map((k) => windowComps(k)));
  if (token !== cmpToken) return;
  got.forEach((g, i) => { if (g.status === "fulfilled") got0[pending[i]] = g.value; else why[pending[i]] = `could not be read this time (${g.reason && g.reason.message ? g.reason.message : "no answer"})`; });
  drawCompare(got0, why, []);
}
function drawCompare(readyW, why, loading) {
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
    const W = readyW[x.k];
    if (!W) { dRow.append(cmpCell(loading.includes(x.k) ? "…" : "–", "")); continue; }
    if (x.k === "attention") dRow.append(cmpCell(compact(W.raw.views[q]), "views"));
    else if (x.k === "network") dRow.append(cmpCell(compact(W.raw.tx[q]), "tx"));
    else dRow.append(cmpCell(Number.isNaN(W.raw.tmax[q]) ? "–" : `${Math.round(W.raw.tmax[q])}°`, SKY(W.raw.code[q])));
  }
  grid.append(dRow);

  // each similar past: how alike it looks to D, window by window
  res.results.forEach((r, i) => {
    const b = el("button", { type: "button", class: "cmp-row", role: "row", "aria-pressed": String(r.day === S.other), "aria-label": `Similar past ${i + 1}, ${r.day}` });
    const wk = el("span", { class: "who" });
    wk.append(el("i", { class: "k", style: `background:var(${r.day === S.other ? "--series-sel" : "--context"})` }), el("b", {}, `${r.later ? "Later" : "Past"} ${i + 1}`), el("small", {}, r.day));
    b.append(wk, cmpCell(r.similarity.toFixed(2), null, r.similarity));
    for (const x of CMP_WINDOWS) {
      const W = readyW[x.k];
      if (!W) { b.append(cmpCell(loading.includes(x.k) ? "…" : "–", null)); continue; }
      const s = windowSimilarity(W.comps, q, r.index, w);
      b.append(s ? cmpCell(s.similarity.toFixed(2), null, s.similarity) : cmpCell("–", null));
    }
    b.addEventListener("click", () => go({ view: "past", pk: "m", other: r.day, open: null }));
    grid.append(b);
  });

  // notes: what each column means, and why a cell is empty
  const notes = $("compare-notes");
  notes.textContent = "";
  const lag = (readyW.attention || readyW.network || readyW.weather || {}).lag ?? 2;
  notes.append(el("div", {}, `The market found these days (${res.mode === "STATE" ? "where it stood" : "how it moved"}, ${w}-day window). The other windows did not: each one only says how alike the same ${w} days look from there — where each stood within its own past year (STATE). 1 = the same, 0 = nothing alike.`));
  notes.append(el("div", {}, `Each window uses only what had come out by 00:00 UTC of that day, so Attention, Weather and the Bitcoin network are read ${lag} days back.`));
  notes.append(el("div", {}, `Attention = daily views of English Wikipedia's “${coinNow().wiki}” article · Weather = ${placeNow().name} (change the place in a day's Weather window) · BTC network = Bitcoin's transactions and hash rate (7-day average), the same for every coin.`));
  for (const x of CMP_WINDOWS) {
    if (why[x.k]) { notes.append(el("div", {}, `– ${x.name}: ${why[x.k]}`)); continue; }
    const W = readyW[x.k];
    if (W && W.comps.every((a) => Number.isNaN(a[q]))) {
      const reason = x.k === "attention" ? "Wikipedia's daily counts start on 2015-07-01, and a value needs 30 days of past before it has a place in its year"
        : "no value for D yet (a window needs 30 days of past, and the newest days are not out yet)";
      notes.append(textWithDates("div", {}, `– ${x.name}: ${reason}.`));
    }
  }
}

/* ── the replay charts (one on the day you stand on, one for two days side by side) ── */
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
const LO = REPLAY_OFFSETS[0], HI = REPLAY_OFFSETS[REPLAY_OFFSETS.length - 1];
const charts = {
  stand: { svgId: "s-chart", tipId: "s-tip", lo: LO, hi: HI, series: null, cursor: null, shown: () => S.view === "stand" && S.x },
  pair: { svgId: "chart", tipId: "tip", lo: LO, hi: HI, series: null, cursor: null, shown: () => S.view === "past" },
};
function drawChart(v) {
  const svgEl = $(v.svgId);
  const W = Math.max(280, Math.round(svgEl.getBoundingClientRect().width) || 360);
  const H = 230;
  svgEl.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svgEl.textContent = "";
  const m = { l: 44, r: 56, t: 22, b: 28 };
  const { lo, hi, series } = v;
  let ymin = 0, ymax = 0;
  for (const s of series) for (const x of s.rep.path) if (x !== null) { ymin = Math.min(ymin, x); ymax = Math.max(ymax, x); }
  if (ymax - ymin < 0.02) { ymin -= 0.01; ymax += 0.01; }
  const pad = (ymax - ymin) * 0.08;
  const { ticks, step } = niceTicks(ymin - pad, ymax + pad, 4);
  const y0 = Math.min(ticks[0], ymin - pad), y1 = Math.max(ticks[ticks.length - 1], ymax + pad);
  const X = (o) => m.l + ((o - lo) / (hi - lo)) * (W - m.l - m.r);
  const Y = (x) => m.t + (1 - (x - y0) / (y1 - y0)) * (H - m.t - m.b);
  Object.assign(v, { X, Y, W, H, m });

  const g = svg("g");
  svgEl.append(g); // 先に入れておく（文字の幅を測れるように）
  // the days the match was made on, shaded under everything else
  if (v.band) {
    const a = X(Math.max(lo, v.band[0])), b = X(Math.min(hi, v.band[1]));
    const x0 = Math.min(a, b - 4), wd = Math.max(4, b - a);
    g.append(svg("rect", { x: x0, y: m.t, width: wd, height: H - m.t - m.b, fill: "var(--band)", rx: 3 }));
    g.append(svg("text", { x: x0 + 2, y: m.t - 8, "font-size": 10.5, "font-weight": 650, fill: "var(--muted)" }, "compared"));
  }
  const digits = step < 0.01 ? 1 : 0;
  for (const t of ticks) {
    if (t < y0 - 1e-12 || t > y1 + 1e-12) continue;
    g.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
    g.append(svg("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)", style: "font-variant-numeric:tabular-nums" }, pct(t, digits)));
  }
  for (const o of lo < -7 ? [lo, 0, 14, 30] : [-7, 0, 7, 14, 30]) {
    g.append(svg("text", { x: X(o), y: H - 8, "text-anchor": "middle", "font-size": 11, fill: o === 0 ? "var(--ink-2)" : "var(--muted)", "font-weight": o === 0 ? 700 : 400 },
      o === 0 ? "that day" : (o > 0 ? `+${o}d` : `${MINUS}${-o}d`)));
  }
  g.append(svg("line", { x1: X(0), x2: X(0), y1: m.t - 6, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
  if (v.note) g.append(svg("text", { x: X(0) + 6, y: m.t - 8, "font-size": 11, fill: "var(--muted)" }, v.note));

  const lineOf = (vals) => {
    let d = "", pen = false;
    vals.forEach((x, i) => {
      if (x === null) { pen = false; return; }
      d += (pen ? "L" : "M") + X(lo + i).toFixed(1) + "," + Y(x).toFixed(1);
      pen = true;
    });
    return d;
  };
  const color = { context: "var(--context)", d: "var(--series-d)", sel: "var(--series-sel)" };
  const hasSel = series.some((s) => s.kind === "sel");
  for (const kind of ["context", "d", "sel"]) {
    for (const s of series.filter((x) => x.kind === kind)) {
      const path = svg("path", { d: lineOf(s.rep.path), fill: "none", stroke: color[kind], "stroke-width": kind === "context" ? 1.5 : 2, "stroke-linejoin": "round", "stroke-linecap": "round" });
      g.append(path);
      // opening a future: its line draws itself from the left
      if (v.animate && (kind === "sel" || (kind === "d" && !hasSel))) {
        try { const len = Math.ceil(path.getTotalLength()); if (len > 0) { path.style.setProperty("--len", String(len)); path.classList.add("draw"); } } catch { /* no layout yet */ }
      }
    }
  }
  // end dots + selective direct labels (D at the event; an opened line at its last day)
  const dot = (x, y, c) => g.append(svg("circle", { cx: x, cy: y, r: 4, fill: c, stroke: "var(--surface)", "stroke-width": 2 }));
  const endLabel = (s, c) => {
    let j = s.rep.path.length - 1;
    while (j >= 0 && s.rep.path[j] === null) j--;
    if (j <= -lo) return;
    const x = s.rep.path[j];
    dot(X(lo + j), Y(x), c);
    const t = svg("text", { x: X(lo + j) + 8, y: Y(x) + 4, "font-size": 12, "font-weight": 700, fill: "var(--ink)", style: "font-variant-numeric:tabular-nums" }, pct(x));
    g.append(t);
    // 幅は実際に測る（端末ごとにフォントが違う）。はみ出すなら点の左上に置く
    let len = 0;
    try { len = t.getComputedTextLength(); } catch { len = 0; }
    if (!len || X(lo + j) + 8 + len > W - 2) { t.setAttribute("x", X(lo + j) - 2); t.setAttribute("y", Y(x) - 10); t.setAttribute("text-anchor", "end"); }
  };
  const dS = series.find((s) => s.kind === "d");
  const d0 = dS.rep.path[-lo];
  if (d0 !== null) {
    dot(X(0), Y(d0), "var(--series-d)");
    g.append(svg("text", { x: X(0) - 8, y: Y(d0) - 8, "text-anchor": "end", "font-size": 12, "font-weight": 700, fill: "var(--ink)" }, "D"));
  }
  const sS = series.find((s) => s.kind === "sel");
  if (sS) endLabel(sS, "var(--series-sel)");
  else if (dS.open) endLabel(dS, "var(--series-d)");
  v.cursorLayer = svg("g");
  svgEl.append(v.cursorLayer);
  svgEl.setAttribute("aria-label", `Price change from the day, ${MINUS}${-lo} to +${hi} days.${v.band ? ` Shaded: the days that were compared.` : ""} D is ${S.day}${sS ? `; the other day is ${sS.name}` : ""}.`);
  if (v.cursor !== null && v.cursor !== undefined) showAt(v, v.cursor);
  else tipHint(v);
}
function pointAt(v, e) {
  if (!v.series || !v.X) return;
  const rect = $(v.svgId).getBoundingClientRect();
  const x = ((e.clientX - rect.left) / rect.width) * v.W;
  const o = Math.round(v.lo + ((x - v.m.l) / (v.W - v.m.l - v.m.r)) * (v.hi - v.lo));
  showAt(v, Math.max(v.lo, Math.min(v.hi, o)));
}
function showAt(v, o) {
  v.cursor = o;
  const L = v.cursorLayer;
  L.textContent = "";
  const x = v.X(o);
  L.append(svg("line", { x1: x, x2: x, y1: v.m.t - 6, y2: v.H - v.m.b, stroke: "var(--muted)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
  const rank = { sel: 0, d: 1, context: 2 };
  const order = [...v.series].sort((a, b) => rank[a.kind] - rank[b.kind]).filter((s, i) => s.kind !== "context" || i < 4);
  const color = { context: "var(--context)", d: "var(--series-d)", sel: "var(--series-sel)" };
  const tip = $(v.tipId);
  tip.textContent = "";
  tip.append(el("div", { class: "t" }, o === 0 ? "That day" : `${o > 0 ? "+" : MINUS}${Math.abs(o)} days from the day`));
  order.sort((a, b) => (a.kind === "d" ? -1 : b.kind === "d" ? 1 : 0)); // your day first, as in the legend
  for (const s of order) {
    const y = s.rep.path[o - v.lo];
    if (y !== null) L.append(svg("circle", { cx: x, cy: v.Y(y), r: s.kind === "context" ? 3 : 4, fill: color[s.kind], stroke: "var(--surface)", "stroke-width": 2 }));
    const row = el("div", { class: "r" });
    const day = ymdOf(dayNum(s.rep.event) + o);
    row.append(el("i", { style: `background:${color[s.kind]}` }), el("b", {}, y === null ? (s.kind === "d" && o > 0 && !s.open ? "unknown" : "—") : pct(y)), el("span", {}, s.kind === "d" ? `D · ${day}` : day));
    tip.append(row);
  }
}
/* the readout under the chart, when nothing is touched */
function tipHint(v) {
  const tip = $(v.tipId);
  tip.textContent = "";
  tip.append(el("div", { class: "hint" }, "Touch the chart to read any day."));
}
function hideTip(v) {
  v.cursor = null;
  if (v.cursorLayer) v.cursorLayer.textContent = "";
  tipHint(v);
}

function renderTable(D, selRep, r, i) {
  const t = $("table");
  t.textContent = "";
  const thead = el("thead"), tr = el("tr");
  tr.append(el("th", { scope: "col" }, "Day"));
  const hD = el("th", { scope: "col" });
  hD.append(el("span", { class: "k", style: "background:var(--series-d)" }), document.createTextNode(`D · ${S.day}`));
  tr.append(hD);
  if (r) {
    const hS = el("th", { scope: "col" });
    hS.append(el("span", { class: "k", style: "background:var(--series-sel)" }), document.createTextNode(`${i + 1}. ${r.day}`));
    tr.append(hS);
  }
  thead.append(tr);
  const tbody = el("tbody");
  REPLAY_OFFSETS.forEach((o, j) => {
    const row = el("tr", { class: o === 0 ? "event" : undefined });
    row.append(el("th", { scope: "row", style: "text-align:left;font-weight:inherit" }, o === 0 ? "that day" : `${o > 0 ? "+" : MINUS}${Math.abs(o)}d`));
    const cell = (p) => {
      if (p.state === "unknown") return el("td", { class: "unknown", title: "Not yet known on D" }, "?");
      if (p.state !== "seen") return el("td", { class: "unknown" }, "—");
      return el("td", {}, o === 0 ? usd(p.price) : pct(p.change));
    };
    row.append(cell(D.points[j]));
    if (selRep) row.append(cell(selRep.points[j]));
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
  for (const id of ["footer", "footer-how"]) {
    const f = $(id);
    f.textContent = "";
    f.append(el("div", {}, "frctlns — a temporal exploration playground."));
    f.append(el("div", {}, "Data: CoinMarketCap API (quotes, OHLCV and Fear & Greed history for BTC, ETH, XRP, SOL and DOGE), kept in its own archive. frctlns observes; it does not predict."));
    f.append(el("div", {}, "Other windows: Wikimedia pageviews, Hacker News (Algolia), NASA APOD, USGS earthquakes, Open-Meteo weather, Blockchain.com, ECB rates via Frankfurter, FRED (Nasdaq, VIX, US dollar); X is a link only."));
  }
}

boot();
