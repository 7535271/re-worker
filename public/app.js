/* RE: — the page. Reads /series once per coin, then every observation is computed here in the browser.
   Rearranged 2026-09-27 (Shu, Nova): the centre is a moment in time. Two ways in —
   from the world (a word: when was it happening?) and from the market (when did it move the most?) —
   then the same walk: stand on the day → look through the windows at 00:00 → open what happened next →
   go somewhere like it (another moment of the same word, or a day when the market looked the same). */
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

/* the markets RE: keeps (CMC ids). Attention follows the coin's own English Wikipedia article */
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
  coin: "1", t: "world", q: "", day: null, mode: "STATE", width: 7, off: new Set(),
  other: null, pk: "m", place: "tokyo", view: "home", open: null,
};
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
  S.t = h.get("t") === "market" ? "market" : "world";
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
  S.pk = h.get("pk") === "w" ? "w" : "m";
  S.place = PLACES.some((x) => x.id === h.get("pl")) ? h.get("pl") : PLACES[0].id;
  S.view = VIEWS.includes(h.get("v")) ? h.get("v") : "home";
  S.open = h.get("o") || null;
}
function writeHash(push = false) {
  const parts = [];
  if (S.coin !== "1") parts.push(`c=${S.coin}`);
  if (S.t !== "world") parts.push(`t=${S.t}`);
  if (S.q) parts.push(`q=${encodeURIComponent(S.q)}`);
  if (S.day) parts.push(`d=${S.day}`);
  if (S.mode !== "STATE") parts.push(`m=${S.mode}`);
  if (S.width !== 7) parts.push(`w=${S.width}`);
  if (S.off.size) parts.push(`off=${[...S.off].join(",")}`);
  if (S.other && S.view === "past") parts.push(`p=${S.other}`, `pk=${S.pk}`);
  if (S.place !== PLACES[0].id) parts.push(`pl=${S.place}`);
  if (S.view !== "home") parts.push(`v=${S.view}`);
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
  const sbox = $("s-width");
  for (const [w, name] of [[1, "1 day"], [7, "1 week"], [15, "2 weeks"], [30, "1 month"]]) {
    const b = el("button", { type: "button", "data-w": w, "aria-label": `alike over ${name}` }, name);
    b.addEventListener("click", () => { if (S.width !== w) { S.width = w; run(); } });
    sbox.append(b);
  }
  for (const b of $("mode").querySelectorAll("button")) b.addEventListener("click", () => { S.mode = b.dataset.mode; run(); });
  for (const b of $("entry").querySelectorAll("button")) b.addEventListener("click", () => go({ t: b.dataset.t }, false));
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
  $("pick-day").addEventListener("click", () => go({ view: "stand", open: null }));
  // the day you stand on: each part of the big date has an invisible wheel on top, holding only days the archive has
  for (const id of ["d-y", "d-m", "d-d"]) $(id).addEventListener("change", () => pickFromWheels(id));
  $("prev-day").addEventListener("click", () => stepDay(-1));
  $("next-day").addEventListener("click", () => stepDay(1));
  $("latest").addEventListener("click", () => setDay(ex.last));
  for (const id of ["how-link", "how-link2"]) $(id).addEventListener("click", () => go({ view: "how", open: null }));
  $("p-prev").addEventListener("click", () => stepPair(-1));
  $("p-next").addEventListener("click", () => stepPair(1));
  $("stand").addEventListener("click", standThere);
  // the mark: back to the start, from any screen
  $("mark").addEventListener("click", () => {
    if (S.view === "home") { window.scrollTo({ top: 0, behavior: "smooth" }); return; }
    go({ view: "home", open: null });
  });
  $("open-next").addEventListener("click", openNext);
  $("s-seal").addEventListener("click", openOwn);
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
  run(false);
  writeHash(true);
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
function run(write = true) {
  if (S.mode === "TRAJECTORY" && S.width < 2) S.width = 7;
  const axes = {};
  for (const k of AXES) axes[k] = !S.off.has(k);
  res = ex.search({ day: S.day, mode: S.mode, width: S.width, axes, top: 5 });
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
function renderHome() {
  renderCoins();
  for (const b of $("entry").querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.t === S.t));
  $("e-world").hidden = S.t !== "world";
  $("e-market").hidden = S.t !== "market";
  for (const x of document.querySelectorAll(".coin-sym")) x.textContent = sym();
  if (S.t === "world") renderWorld();
  else renderMarket();
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
    how.textContent = "Enter a word, topic, or event. RE: finds the days it left traces in the world — in what people read on Wikipedia and voted up on Hacker News.";
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
  const list = body.moments.filter((m) => m.day >= ex.first && m.day <= ex.last);
  const before = body.moments.length - list.length;
  found.textContent = list.length ? `${list.length} moment${list.length === 1 ? "" : "s"}` + (before ? ` · ${before} before ${sym()}'s history` : "") : "";
  rows.textContent = "";
  if (!list.length) rows.append(el("p", { class: "empty" }, body.moments.length ? `Found only before ${sym()}'s history begins (${ex.first}).` : "No traces stood out. Try another word, in English."));
  list.forEach((m, i) => rows.append(momentRow(m, i, () => standOn(m.day))));
  how.textContent = "";
  how.append(textWithDates("span", {}, `Public traces, found with today's records — not a list of events. When you stand on one of these days, you see only what was out by its 00:00 UTC.${body.article ? ` Wikipedia: “${body.article.title}”.` : ""}`));
}
function momentRow(m, i, onTap, compact = false) {
  const b = el("button", { type: "button", class: "row moment", style: `animation-delay:${i * 0.04}s` });
  b.append(whenCell(m.day), el("span", { class: "go" }, `${sym()} ${usdShort(priceAt(m.day))}`), el("span", { class: "chev", "aria-hidden": "true" }, "›"));
  if (m.hn && !compact) b.append(el("span", { class: "what" }, m.hn.title));
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
function renderMarket() {
  const box = $("m-rows");
  box.textContent = "";
  const { falls, rises } = bigMoves();
  let i = 0;
  for (const [label, list] of [["Biggest falls", falls], ["Biggest rises", rises]]) {
    box.append(el("div", { class: "divider" }, label));
    for (const m of list) {
      const b = el("button", { type: "button", class: "row", style: `animation-delay:${i++ * 0.03}s` });
      b.append(whenCell(m.day), el("span", { class: `go ${m.move < 0 ? "down" : "up"}` }, pct(m.move)), el("span", { class: "chev", "aria-hidden": "true" }, "›"));
      b.addEventListener("click", () => standOn(m.day));
      box.append(b);
    }
  }
}

/* ══ 2. the day you stand on ══ */
const ownOpen = new Set(); // "coin|day" whose own next 30 days were opened in this visit
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
    momentsList = b.moments.filter((m) => m.day >= ex.first && m.day <= ex.last);
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
  if (S.q && momentsFor !== `${S.q}|${S.coin}`) refreshMoments().then(() => { if (S.view === "stand") { contextLine(); renderGoMoments(); } });

  // at 00:00: each window from the newest day it had out
  renderTiles("s", { kind: "asof" });
  // what happened next: sealed until opened
  const open = ownOpen.has(ownKey());
  $("s-seal").hidden = open;
  $("s-seal-note").textContent = `the next ${HORIZON} days of ${sym()}, and the day itself as recorded now`;
  $("s-next").hidden = !open;
  if (open) drawOwn(false);
  renderGoMoments();
  renderSimilar();
}
function openOwn() {
  ownOpen.add(ownKey());
  $("s-seal").hidden = true;
  $("s-next").hidden = false;
  drawOwn(true);
}
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
}
function checksInto(box, rep) {
  box.textContent = "";
  for (const o of [1, 7, HORIZON]) {
    const p = rep.points.find((x) => x.offset === o);
    const c = el("div", { class: "check" });
    c.append(el("b", {}, p && p.state === "seen" ? pct(p.change) : "—"), el("small", {}, o === 1 ? "1 day later" : `${o} days later`));
    box.append(c);
  }
}
/* go somewhere like it: other moments of the same word */
function renderGoMoments() {
  const wrap = $("s-moments-wrap"), box = $("s-moments");
  const list = momentsNow().filter((m) => m.day !== S.day);
  wrap.hidden = !S.q || !list.length;
  if (wrap.hidden) return;
  $("s-moments-title").textContent = `Other moments of “${S.q}”`;
  box.textContent = "";
  list.forEach((m, i) => box.append(momentRow(m, i, () => go({ view: "past", pk: "w", other: m.day, open: null }), true)));
}
/* … or the days the market looked like this */
function renderSimilar() {
  for (const b of $("s-width").querySelectorAll("button")) {
    const w = Number(b.dataset.w);
    b.setAttribute("aria-pressed", String(w === S.width));
    b.disabled = S.mode === "TRAJECTORY" && w < 2;
  }
  $("found").textContent = "";
  const box = $("results");
  box.textContent = "";
  if (res.error) {
    const why = res.error === "no axis can be observed for this window"
      ? (S.off.size ? "Nothing is left to compare — turn something back on in the Observatory." : "There is too little past before this day. Try a later one.")
      : res.error;
    box.append(el("p", { class: "empty" }, why));
    return;
  }
  if (!res.results.length) {
    box.append(el("p", { class: "empty" }, res.searched ? "Every past day was left out: none had at least half of this day's axes to compare." : "There is no earlier day to compare with yet."));
    return;
  }
  const nLater = res.results.filter((r) => r.later).length;
  $("found").textContent = nLater
    ? `${res.results.length - nLater} from before it · ${nLater} later in history (its past is short)`
    : `${res.results.length} of ${int(res.candidates)} days before it`;
  res.results.forEach((r, i) => {
    if (r.later && (i === 0 || !res.results[i - 1].later)) {
      box.append(el("div", { class: "divider" }, "Later in history — shown because the past before this day is short"));
    }
    const b = el("button", { type: "button", class: "row", style: `animation-delay:${i * 0.04}s`, "aria-label": `${r.day}, ${Math.round(r.similarity * 100)}% alike` });
    b.append(whenCell(r.day), el("span", { class: "go" }, `${Math.round(r.similarity * 100)}%`), el("span", { class: "chev", "aria-hidden": "true" }, "›"));
    const tag = [r.later ? "later in history" : null, histTag(r.coverage_days && r.coverage_days.candidate, r.day)].filter(Boolean).join(" · ");
    if (tag) b.append(el("span", { class: "hist" }, tag));
    b.addEventListener("click", () => go({ view: "past", pk: "m", other: r.day, open: null }));
    box.append(b);
  });
}

/* ══ 3. two days side by side: was it really alike? what happened next? stand there ══ */
/* the days you can step between: the market's look-alikes, or the other moments of the word */
function pairList() {
  if (S.pk === "w") {
    return momentsNow().filter((m) => m.day !== S.day).map((m, i) => ({ day: m.day, index: dayNum(m.day) - ex.tl.d0, kind: "w", moment: m, rank: i }));
  }
  return res.results.map((r, i) => ({ ...r, kind: "m", rank: i }));
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
const limitFor = (r) => (r && (r.later || r.kind === "w") ? ex.last : S.day);
const revealed = new Set(); // "coin|D|that day" pairs whose "next" has been opened in this visit
function standThere() {
  const r = pairNow();
  if (!r) return;
  S.day = r.day;
  S.other = null;
  S.view = "stand";
  S.open = null;
  run(false);
  writeHash(true);
}
function renderPast() {
  const r = pairNow();
  const list = pairList();
  const i = list.findIndex((x) => x.day === r.day);
  $("p-title").textContent = niceDay(r.day);
  setDated($("p-sub"), r.kind === "w"
    ? `Another moment of “${S.q}”, next to ${S.day}.`
    : r.later ? `Later in history. The market says this day felt like ${S.day}.` : `The market says this day felt like ${S.day}.`);
  $("p-what").textContent = r.kind === "w" && r.moment.hn ? r.moment.hn.title : "";
  $("p-hist").textContent = histTag(r.coverage_days && r.coverage_days.candidate, r.day) || "";
  $("p-prev").disabled = i <= 0;
  $("p-next").disabled = i >= list.length - 1;
  $("p-lead").textContent = r.kind === "w"
    ? "Two moments of the same word. Look at both through the same windows, as each looked at 00:00 UTC."
    : "The market says these two days felt the same. Look at both through the same windows, as each looked at 00:00 UTC.";
  $("k-d").textContent = S.day;
  $("k-p").textContent = r.day;
  renderPair(r);
  // what happened next stays sealed until it is opened
  const open = revealed.has(`${S.coin}|${S.day}|${r.day}`);
  $("open-next").hidden = open;
  $("seal-note").textContent = r.kind === "w" || r.later
    ? `the ${HORIZON} days after ${r.day}`
    : `the ${HORIZON} days after ${r.day} — the part nobody on ${S.day} could see for their own day`;
  $("next-body").hidden = !open;
  if (open) drawNext(r, false);
  $("stand").textContent = `Stand on ${r.day}`;
  $("stand-note").textContent = "It becomes your day, and you can go somewhere like it from there.";
}
function openNext() {
  const r = pairNow();
  if (!r) return;
  revealed.add(`${S.coin}|${S.day}|${r.day}`);
  $("open-next").hidden = true;
  $("next-body").hidden = false;
  drawNext(r, true);
}
function drawNext(r, animate) {
  // your own day: its line goes on only if you have opened its future yourself
  const mine = ownOpen.has(ownKey());
  const D = ex.replay(S.day, mine ? ex.last : S.day);
  const selRep = ex.replay(r.day, limitFor(r));
  checksInto($("checks"), selRep);
  const series = [];
  pairList().forEach((x) => { if (x.day !== r.day) series.push({ kind: "context", name: x.day, rep: ex.replay(x.day, limitFor(x)) }); });
  series.push({ kind: "d", name: S.day, rep: D, open: mine });
  series.push({ kind: "sel", name: r.day, rep: selRep });
  const v = charts.pair;
  Object.assign(v, { series, cursor: null, animate, note: mine ? null : "after your day: hidden" });
  const lg = $("legend");
  lg.textContent = "";
  const key = (color, text) => { const s = el("span"); s.append(el("i", { style: `background:var(${color})` }), document.createTextNode(text)); return s; };
  lg.append(key("--series-sel", `${r.day} (that day)`), key("--series-d", `${S.day} (your day)`));
  if (series.some((s) => s.kind === "context")) lg.append(key("--context", r.kind === "w" ? `the other moments of “${S.q}”` : "the other similar days"));
  drawChart(v);
  v.animate = false;
  $("p-hidden").textContent = mine
    ? `You opened what came after ${S.day} yourself, so both lines go on.`
    : `After ${S.day} the line stops: on that day, nobody knew what came next.` + (r.later ? ` ${r.day} is later in history, so everything shown for it happened after your day.` : "");
}

/* both days through the same windows, each as it looked at its own 00:00 UTC. RE: does not grade them */
const PAIR = [
  { k: "market", name: "Market" }, { k: "attention", name: "Attention" }, { k: "weather", name: "Weather" },
  { k: "network", name: "Bitcoin network" }, { k: "hn", name: "Hacker News" }, { k: "sky", name: "Sky" },
  { k: "earth", name: "Earth" }, { k: "money", name: "Money" }, { k: "x", name: "X" },
];
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
    PAIR.forEach((t, i) => {
      const b = el("button", { type: "button", class: "tile", "data-k": t.k, "aria-expanded": String(S.open === t.k), style: `animation-delay:${i * 0.03}s` });
      const two = el("span", { class: "two" });
      const g = [pairGlimpse(t.k, A, q, comps, loading), pairGlimpse(t.k, B, c, comps, loading)];
      g.forEach((text, j) => { const sp = el("span"); sp.append(el("i", { style: `background:var(${j ? "--series-sel" : "--series-d"})` }), el("em", {}, text)); two.append(sp); });
      b.append(el("span", { class: "tn" }, t.name), two);
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
/* X is a door: a search for the coin's name on one UTC day (RE: reads nothing from X) */
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
   On the day you stand on there are two sets: at 00:00 ("s"), and — once its future is open — the day itself ("h") */
const TILES = [
  { k: "market", name: "Market" },
  { k: "attention", name: "Attention" },
  { k: "weather", name: "Weather" },
  { k: "network", name: "Bitcoin network" },
  { k: "hn", name: "Hacker News" },
  { k: "sky", name: "Sky" },
  { k: "earth", name: "Earth" },
  { k: "money", name: "Money" },
  { k: "x", name: "X" },
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
  d.append(el("p", {}, "A date on a window is not the moment the world could see it. Each window shows the times it has — when it happened, when it could be seen, when the data came out, whether it changes later. At 00:00 RE: uses only what had come out by then."));
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
  { k: "attention", name: "Attention" },
  { k: "weather", name: "Weather" },
  { k: "network", name: "BTC network" },
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
  stand: { svgId: "s-chart", tipId: "s-tip", lo: LO, hi: HI, series: null, cursor: null, shown: () => S.view === "stand" && !$("s-next").hidden },
  pair: { svgId: "chart", tipId: "tip", lo: LO, hi: HI, series: null, cursor: null, shown: () => S.view === "past" && !$("next-body").hidden },
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
  const digits = step < 0.01 ? 1 : 0;
  for (const t of ticks) {
    if (t < y0 - 1e-12 || t > y1 + 1e-12) continue;
    g.append(svg("line", { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t), stroke: t === 0 ? "var(--axis)" : "var(--grid)", "stroke-width": 1, "shape-rendering": "crispEdges" }));
    g.append(svg("text", { x: m.l - 6, y: Y(t) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)", style: "font-variant-numeric:tabular-nums" }, pct(t, digits)));
  }
  for (const o of [-7, 0, 7, 14, 30]) {
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
  svgEl.setAttribute("aria-label", `Price change from the day, ${MINUS}7 to +30 days. D is ${S.day}${sS ? `; the other day is ${sS.name}` : ""}.`);
  if (v.cursor !== null && v.cursor !== undefined) showAt(v, v.cursor);
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
  for (const s of order) {
    const y = s.rep.path[o - v.lo];
    if (y !== null) L.append(svg("circle", { cx: x, cy: v.Y(y), r: s.kind === "context" ? 3 : 4, fill: color[s.kind], stroke: "var(--surface)", "stroke-width": 2 }));
    const row = el("div", { class: "r" });
    const day = ymdOf(dayNum(s.rep.event) + o);
    row.append(el("i", { style: `background:${color[s.kind]}` }), el("b", {}, y === null ? (s.kind === "d" && o > 0 && !s.open ? "unknown" : "—") : pct(y)), el("span", {}, s.kind === "d" ? `D · ${day}` : day));
    tip.append(row);
  }
  tip.style.display = "block";
  const wrap = $(v.svgId).getBoundingClientRect();
  const px = (x / v.W) * wrap.width;
  const tw = tip.offsetWidth;
  tip.style.left = (px + 12 + tw < wrap.width ? px + 12 : Math.max(0, px - 12 - tw)) + "px";
}
function hideTip(v) {
  v.cursor = null;
  if (v.cursorLayer) v.cursorLayer.textContent = "";
  $(v.tipId).style.display = "none";
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
    f.append(el("div", {}, "Data: CoinMarketCap API (quotes, OHLCV and Fear & Greed history for BTC, ETH, XRP, SOL and DOGE), kept in RE:'s own archive. RE: observes; it does not predict."));
    f.append(el("div", {}, "Other windows: Wikimedia pageviews, Hacker News (Algolia), NASA APOD, USGS earthquakes, Open-Meteo weather, Blockchain.com, ECB rates via Frankfurter; X is a link only."));
  }
}

boot();
