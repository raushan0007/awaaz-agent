import {
  $, CATEGORY, chakraHtml, countUp, DEPARTMENTS, esc, evidenceHtml, formatTime, hoursText, ICON, mapLink, mountChrome, plusCode,
  animateLists, celebrate, shrinkPhoto, STATUS, takePhoto, TOUCH, WORK_STAGES,
  starsHtml, timeAgo, toast, traceHtml, URGENCY, WAVES,
  LOCALE, mountTrend, STATUS_COLOUR, tt,
} from "./shared.js";

mountChrome("officer");
$("hero").insertAdjacentHTML("afterbegin", chakraHtml());
$("hero").insertAdjacentHTML("beforeend", WAVES);
$("headerExtra").innerHTML = `<button type="button" class="bell" id="bell" hidden aria-label="नई शिकायतें">🔔<b id="bellCount" hidden>0</b></button>
  <div class="who" id="who" hidden></div>`;

const SCOPES = { ...DEPARTMENTS, all: "सभी विभाग (ज़िला)" };
// What an officer can do next from each state; mirrors TRANSITIONS on the server.
// Open and in-progress work moves through the stage track (see stageTrack); these are the other moves.
const ACTIONS = {
  open: [["rejected", "बंद करें"]],
  in_progress: [],
  needs_review: [["open", "विभाग को भेजें"], ["rejected", "बंद करें"]],
  // a wrong 'fixed' or a wrong closing is undone here, with a reason
  resolved: [["reopened", "↩️ फिर से खोलें"]],
  rejected: [["reopened", "↩️ फिर से खोलें"]],
};
const OVERDUE_TEXT = { open: "काम शुरू नहीं हुआ", in_progress: "कोई नया अपडेट नहीं", needs_review: "जाँच नहीं हुई" };
// Donut slices: label and colour per status (kept in step with the tile tones in style.css).
const SLICES = [
  ["open", "खुली", STATUS_COLOUR.open],
  ["in_progress", "काम चल रहा", STATUS_COLOUR.in_progress],
  ["resolved", "हल हुईं", STATUS_COLOUR.resolved],
  ["needs_review", "जाँच बाकी", "#a9b6ff"],
];  // closed-as-invalid reports are counted apart, as everywhere else (KPIs, public dashboard)
// Any stage of the work can carry a photo of it (the server checks the same).
const PROOF_STATES = ["inspected", "approved", "in_progress", "resolved"];

/** Where the work stands, and a button for each stage still ahead: done ones ticked, the next one glowing. */
function stageTrack(c) {
  if (!["open", "in_progress"].includes(c.status)) return "";
  const at = c.status === "open" ? -1 : WORK_STAGES.findIndex(([k]) => k === (c.stage || "in_progress"));
  const now = at >= 0 ? WORK_STAGES[at][3] : "अभी कोई कदम नहीं — शिकायत दर्ज है";
  return `<div class="stage-track">${WORK_STAGES.map(([k, icon, short], i) => i <= at
    ? `<button type="button" class="stage-btn done" disabled><span>${icon}</span>${short}</button>`
    : `<button type="button" class="act stage-btn ${i === at + 1 ? "next" : ""}" data-status="${k}"><span>${icon}</span>${short}</button>`).join("")}</div>
    <p class="stage-hint">अभी: <b>${now}</b> · अगला कदम चुनें — हर कदम नागरिक को दिखेगा</p>`;
}
const REFRESH_MS = 30000;

let token = null;
try { token = localStorage.getItem("awaaz-officer-token"); } catch { /* private mode: log in each time */ }
let queue = [];
let filter = "all";
let days = 30;
let hours = 0;  // 1 or 24: the last hour or the last day, counted by the hour
const win = () => `days=${days}&hours=${hours}`;
const PULSE_MS = 10000;
let lastSeen = 0;           // newest complaint id the officer has been told about
const fresh = new Set();    // complaints that came in while the dashboard was open: marked "new"
let unread = 0;
let insight = null;
let listKey = "most_reported";
let firstPaint = true;
let dept = "";  // "" = the officer's whole scope; else one department ("review": not routed yet)
let me = null;
const deptName = (k) => (k === "review" ? "AI जाँच बाकी" : DEPARTMENTS[k] || k);
const deptOf = (c) => c.category || "review";
const dq = () => (dept ? `dept=${dept}` : "");

async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token || ""}`, ...(options.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401) {
    logout();
    throw new Error(body.detail || "Please log in again.");
  }
  if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
  return body;
}

function saveToken(t) {
  token = t;
  try { t ? localStorage.setItem("awaaz-officer-token", t) : localStorage.removeItem("awaaz-officer-token"); } catch { /* ignore */ }
}

function logout() {
  saveToken(null);
  $("dash").hidden = true;
  $("who").hidden = true;
  $("loginCard").hidden = false;
}

async function login(e) {
  e.preventDefault();
  $("loginStatus").textContent = "जाँच रहे हैं…";
  try {
    const r = await fetch("/api/officer/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("user").value.trim(), password: $("pass").value }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.detail || "Login failed");
    saveToken(body.token);
    $("pass").value = "";
    $("loginStatus").textContent = "";
    await start(body.officer);
  } catch (err) {
    $("loginStatus").textContent = "लॉगिन नहीं हुआ: " + err.message;
  }
}

const age = timeAgo;

function donutHtml(byStatus) {
  const parts = SLICES.map(([k, label, colour]) => [label, colour, byStatus[k] || 0]).filter(([, , v]) => v);
  const total = parts.reduce((sum, [, , v]) => sum + v, 0);
  if (!total) return `<p class="status">अभी कोई शिकायत नहीं।</p>`;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const rings = parts.map(([, colour, v]) => {
    const len = (v / total) * c;
    const ring = `<circle r="${r}" cx="70" cy="70" fill="none" stroke="${colour}" stroke-width="20"
      stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;
    offset += len;
    return ring;
  }).join("");
  const closed = byStatus.rejected ? `<p class="hint donut-note">🚫 इसके अलावा ${byStatus.rejected} शिकायतें अमान्य मानकर बंद की गईं</p>` : "";
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="स्थिति के हिसाब से ${total} शिकायतें">
      ${rings}<text x="70" y="70" text-anchor="middle" font-size="30" font-weight="800">${total}</text>
      <text x="70" y="92" text-anchor="middle" font-size="12" fill="currentColor" opacity=".6">शिकायतें</text></svg>
    <ul class="legend">${parts.map(([label, colour, v]) =>
      `<li><i style="background:${colour}"></i>${label} <b>${v}</b></li>`).join("")}</ul>${closed}`;
}

// --- the analysis: KPIs, daily trend, rankings and attention lists ------------------------------------

const rateHtml = (v) => `<div class="rate"><div class="bar"><i style="width:${v}%"></i></div><b>${v}%</b></div>`;
const daysTxt = (v) => (v == null ? "–" : `${v} दिन`);
const hoursTxt = (v) => (v == null ? "–" : v < 24 ? `${Math.round(v)} घंटे` : `${(v / 24).toFixed(1)} दिन`);

function renderKpis(k) {
  const tiles = [
    ["", "रिपोर्ट", k.reports],
    ["info", "समस्याएँ", k.issues],
    ["good", "हल हुईं", k.resolved],
    ["good", "हल दर %", k.rate],
    ["warn", "औसत समाधान (दिन)", k.avg_days ?? 0],
    [k.unheard ? "bad" : "", "अनसुनी", k.unheard],
  ];
  const jump = ["all", "all", "closed", "closed", "closed", "unheard"];
  $("kpis").innerHTML = tiles.map(([tone, label], i) =>
    `<button type="button" class="kpi ${tone}" data-jump="${jump[i]}" title="नीचे सूची में देखें"><b>0</b><span>${label}</span><i class="go">सूची देखें →</i></button>`).join("");
  [...$("kpis").querySelectorAll("b")].forEach((b, i) => countUp(b, tiles[i][2]));
}

function deptTableHtml(rows) {
  if (!rows.length) return `<p class="status">इस अवधि में कोई शिकायत नहीं।</p>`;
  return `<table class="tbl"><thead><tr><th>विभाग</th><th>समस्याएँ</th><th>रिपोर्ट</th><th>खुली</th><th>हल</th><th>हल दर</th>
    <th>औसत समाधान</th><th>पहला जवाब</th><th>अनसुनी</th></tr></thead><tbody>${rows.map((d) => `<tr>
    <td><button type="button" class="link" data-dept="${esc(d.category)}">${ICON[d.category] || "🔎"} ${esc(deptName(d.category))}</button>${d.badge ? `<span class="rbadge ${d.badge}">${d.badge === "best" ? "सबसे अच्छा" : "पीछे"}</span>` : ""}</td>
    <td class="num">${d.issues}</td><td class="num">${d.reports}</td><td class="num">${d.open}</td><td class="num">${d.resolved}</td>
    <td>${rateHtml(d.rate)}</td><td class="num">${daysTxt(d.avg_days)}</td><td class="num">${hoursTxt(d.avg_response_hours)}</td>
    <td class="num">${d.unheard ? `<b style="color:var(--bad)">${d.unheard}</b>` : 0}</td></tr>`).join("")}</tbody></table>
    ${rows.some((d) => d.badge) ? "" : `<p class="hint">रैंकिंग के लिए हर विभाग में कम से कम 3 शिकायतें चाहिए।</p>`}`;
}

/** One bar per department, split into open / work on / fixed, longest first. A click narrows the dashboard. */
function deptChartHtml(rows) {
  if (!rows.length) return `<p class="status">इस अवधि में कोई शिकायत नहीं।</p>`;
  const sorted = [...rows].sort((a, b) => b.issues - a.issues || b.open - a.open);
  const max = Math.max(...sorted.map((d) => d.issues));
  const seg = (k, v, total) => v ? `<i class="seg" style="width:${(v / total) * 100}%;background:${STATUS_COLOUR[k]}" title="${v}"></i>` : "";
  return `<div class="dchart">${sorted.map((d) => {
    const waiting = d.open - d.in_progress;
    const other = d.issues - d.open - d.resolved;  // closed without a fix
    return `<button type="button" class="drow ${dept === d.category ? "on" : ""} ${dept && dept !== d.category ? "dim" : ""}"
        data-dept="${esc(d.category)}" aria-pressed="${dept === d.category}">
      <span class="dname">${ICON[d.category] || "🔎"} ${esc(deptName(d.category))}</span>
      <span class="dtrack"><span class="dfill" style="width:${(d.issues / max) * 100}%">
        ${seg("open", waiting, d.issues)}${seg("in_progress", d.in_progress, d.issues)}${seg("resolved", d.resolved, d.issues)}${other ? `<i class="seg" style="width:${(other / d.issues) * 100}%;background:#7c8098"></i>` : ""}
      </span></span>
      <span class="dnum"><b>${d.issues}</b><small>${d.rate}% हल</small></span>
      <span class="dsub">🕒 ${waiting} खुली · 🔧 ${d.in_progress} काम चल रहा · ✅ ${d.resolved} हल${d.unheard ? ` · <b style="color:var(--bad)">🔕 ${d.unheard} अनसुनी</b>` : ""}</span>
    </button>`;
  }).join("")}</div>
  <div class="lg">${[["open", "खुली"], ["in_progress", "काम चल रहा"], ["resolved", "हल"]].map(([k, l]) =>
    `<span><i style="background:${STATUS_COLOUR[k]}"></i>${l}</span>`).join("")}<span><i style="background:#7c8098"></i>बंद</span></div>`;
}

/** The sticky department picker, each with how much open work it has right now. */
function renderDeptChips() {
  if (!me || !["all", "other"].includes(me.department)) return;
  const keys = me.department === "all" ? [...Object.keys(DEPARTMENTS), "review"] : ["other", "review"];
  const open = (k) => queue.filter((c) => deptOf(c) === k && inWindow(c)).length;
  const chip = (k, label, n) => `<button class="chip" type="button" data-dept="${k}" aria-pressed="${dept === k}"
    title="${esc(k ? deptName(k) : "")}">${label} <b>${n}</b></button>`;
  const html = chip("", me.department === "all" ? "🏛️ सभी विभाग" : "📋 सभी", queue.filter(inWindow).length)
    + keys.filter((k) => k !== "review" || open(k) || dept === k)
      .map((k) => chip(k, `${ICON[k] || "🔎"} ${esc(k === "review" ? "AI जाँच बाकी" : CATEGORY[k])}`, open(k))).join("");
  if ($("deptChips")._html !== html) { $("deptChips").innerHTML = html; $("deptChips")._html = html; }
  $("deptBar").hidden = false;
}

// The numbers for one view (a time window and a department), kept for a minute: switching back and forth
// is instant, and the views an officer is likely to open next are fetched ahead.
const views = new Map();
const viewKey = (v = { days, hours, dept }) => `${v.days}|${v.hours}|${v.dept}`;
const viewQuery = (v) => `days=${v.days}&hours=${v.hours}${v.dept ? `&dept=${v.dept}` : ""}`;

async function fetchView(v = { days, hours, dept }) {
  const [stats, ins] = await Promise.all([api(`/api/officer/stats?${viewQuery(v)}`), api(`/api/officer/insights?${viewQuery(v)}`)]);
  const entry = { stats, ins, at: Date.now() };
  views.set(viewKey(v), entry);
  return entry;
}

let paintedView = "";
function paintView(entry, key) {
  const donut = donutHtml(entry.stats.by_status);
  if ($("donut").innerHTML !== donut) $("donut").innerHTML = donut;
  // Re-draw the analysis only when it changed, so the animations do not replay on every refresh.
  if (key !== paintedView || JSON.stringify(entry.ins) !== JSON.stringify(insight)) renderInsights(entry.ins);
  paintedView = key;
}

/** Show the current view: from the cache at once if it is there, then fresh from the server. */
async function showView() {
  const key = viewKey();
  const cached = views.get(key);
  document.body.classList.toggle("view-loading", !cached);
  if (cached) paintView(cached, key);
  renderQueue();
  try {
    const entry = cached && Date.now() - cached.at < 15000 ? cached : await fetchView();
    if (key === viewKey()) paintView(entry, key);  // the officer may have clicked on meanwhile
  } finally {
    if (key === viewKey()) document.body.classList.remove("view-loading");
  }
}

function prefetchViews() {
  const ahead = [{ days, hours: 1, dept }, { days, hours: 24, dept }, { days: 7, hours: 0, dept }, { days: 30, hours: 0, dept }];
  ahead.filter((v) => !views.has(viewKey(v))).forEach((v, i) => setTimeout(() => fetchView(v).catch(() => {}), 400 * i));
}

/** Bring the work list into view, and optionally one complaint in it, briefly highlighted. */
function goToQueue(id) {
  const card = id && document.querySelector(`#queue .item[data-id="${id}"]`);
  (card || $("queueSection")).scrollIntoView({ behavior: "smooth", block: card ? "center" : "start" });
  if (card) { card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash"); }
}

/** Open one complaint from a notification: clear whatever filter would hide it, then scroll to it. */
function openComplaint(id) {
  const c = queue.find((x) => x.id === id || (x.merged_ids || []).includes(id));
  if (c && dept && deptOf(c) !== dept) { dept = ""; renderDeptChips(); showView().catch(() => {}); }
  if (c && !inWindow(c)) { hours = 24; markPreset(); showView().catch(() => {}); }
  $("search").value = "";
  setFilter("all");
  requestAnimationFrame(() => goToQueue(c ? c.id : id));
}

async function setDept(k) {
  if (k !== dept) {
    dept = k;
    renderDeptChips();
    await showView();
    prefetchViews();
  }
}

function areaTableHtml(rows) {
  if (!rows.length) return `<p class="status">इस अवधि में कोई शिकायत नहीं।</p>`;
  return `<table class="tbl"><thead><tr><th>इलाक़ा</th><th>समस्याएँ</th><th>खुली</th><th>हल दर</th></tr></thead><tbody>${rows.map((a) =>
    `<tr><td>${esc(a.area)}</td><td class="num">${a.issues}</td><td class="num">${a.open}</td><td>${rateHtml(a.rate)}</td></tr>`).join("")}</tbody></table>`;
}

function listHtml(key) {
  const rows = insight.lists[key] || [];
  if (!rows.length) return `<p class="status">कुछ नहीं — अच्छी बात है।</p>`;
  const extra = (p) => key === "unheard" ? `<b style="color:var(--bad)">${p.waiting_days} दिन से इंतज़ार</b>`
    : key === "times" ? `<b style="color:var(--ok)">${p.fix_days} दिन में हल</b>`
    : key === "most_reported" ? `👥 ${p.supporters}` : esc(timeAgo(p.created_at));
  return `<table class="tbl"><tbody>${rows.slice(0, 8).map((p) => `<tr>
    <td>#${p.id} ${ICON[p.category] || ""} ${esc(tt(p) || CATEGORY[p.category] || "")}<br><small class="hint">📍 ${esc(p.area || "")}</small></td>
    <td class="num">${extra(p)}</td></tr>`).join("")}</tbody></table>`;
}

function renderInsights(ins) {
  insight = ins;
  const span = ins.hours ? (ins.hours === 1 ? "पिछला 1 घंटा" : `पिछले ${ins.hours} घंटे`) : `पिछले ${ins.days} दिन`;
  $("period").textContent = `(${span}${dept ? ` · ${deptName(dept)}` : ""})`;
  renderKpis(ins.kpis);
  $("deptChart").innerHTML = deptChartHtml(ins.departments);
  $("deptChartCard").hidden = ins.departments.length < 2 && !dept;
  $("trendTitle").textContent = ins.hours === 1 ? "⏱️ पिछले 1 घंटे का हिसाब (हर 5 मिनट)"
    : ins.hours ? "⏱️ आज का हिसाब, घंटे-घंटे का" : "📈 रोज़ का हिसाब: नई, हल और बाकी";
  mountTrend($("trend"), ins.trend);
  $("deptTable").innerHTML = deptTableHtml(ins.departments);
  $("areaTable").innerHTML = areaTableHtml(ins.areas);
  $("list").innerHTML = listHtml(listKey);
}

function renderPublic(s) {
  $("tFiled").textContent = s.today.filed;
  $("tFixed").textContent = s.today.fixed;
  if (s.just_fixed.length) {
    const items = s.just_fixed.map((f) =>
      `<span>✅ #${f.id} ${esc(tt(f))} · ${esc(f.area || "")} · ${esc(timeAgo(f.fixed_at))}</span>`).join("");
    // left alone when nothing new was fixed, so the running strip does not jump back to the start
    if ($("tickerTrack")._items !== items) { $("tickerTrack").innerHTML = items + items; $("tickerTrack")._items = items; }
    $("ticker").hidden = false;
  }
}

function actionsHtml(c) {
  const actions = ACTIONS[c.status] || [];
  const track = stageTrack(c);
  if (!actions.length && !track) return "";
  const routing = c.status === "needs_review"
    ? `<label>किस विभाग को भेजें</label><select data-role="category">${Object.entries(DEPARTMENTS)
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>`
    : "";
  return `<div class="actions">
    ${routing}
    <label>नोट (नागरिक को सरल हिंदी में बताया जाएगा)</label>
    <textarea data-role="note" rows="2" maxlength="500" placeholder="जैसे: JE ne site dekh li, kal se kaam shuru"></textarea>
    ${track}
    ${track || actions.some(([s]) => PROOF_STATES.includes(s)) ? `<div class="proof-pick">
      <button type="button" class="pick-btn" data-role="cam">📷 कैमरा</button>
      <input type="file" accept="image/*" capture="environment" data-role="proofcam" hidden>
      <label class="pick-btn alt">🖼️ गैलरी<input type="file" accept="image/*" data-role="proof" hidden></label>
      <span class="hint" data-role="proofName">ज़रूरी नहीं — नागरिक को काम होता दिखेगा</span></div>` : ""}
    ${actions.length ? `<div class="action-buttons">${actions.map(([status, label]) =>
      `<button type="button" class="act ${status}" data-status="${status}">${label}</button>`).join("")}</div>` : ""}
    <p class="status" data-role="msg" translate="no"></p>
  </div>`;
}

function itemHtml(c) {
  const d = c.decision || {};
  const updates = (c.updates || []).map((u) =>
    `<li><time>${esc(formatTime(u.created_at))}</time> <small class="gap">(दर्ज होने के ${esc(hoursText((new Date(u.created_at) - new Date(c.created_at)) / 36e5))} बाद)</small>
      <b>${esc(STATUS[u.status] || u.status)}</b> — <span translate="no">${esc(u.message_hi)}</span>
      ${u.photo ? `<a href="/api/updates/${u.id}/photo" target="_blank" rel="noopener">📷 फ़ोटो</a>` : ""}</li>`).join("");
  const late = c.overdue
    ? `<p class="late">⏰ ${Math.floor(c.idle_days)} दिन से ${OVERDUE_TEXT[c.status] || "कोई कार्रवाई नहीं"} — जल्दी देखें</p>` : "";
  const reopened = (c.updates || []).some((u) => u.status === "reopened");
  const isNew = fresh.has(c.id) || (c.merged_ids || []).some((i) => fresh.has(i));
  return `<article class="card item ${esc(c.urgency || "")} ${c.overdue ? "is-late" : ""} ${isNew ? "is-new" : ""}" data-id="${c.id}">
    <div class="item-head">
      <h3>${isNew ? `<span class="new-tag">🆕 नई</span> ` : ""}#${c.id} ${esc(tt(d) || c.text.slice(0, 80))}</h3>
      <span class="status">${esc(age(c.created_at))}</span>
    </div>
    ${late}${reopened ? `<p class="late reopen">↩️ यह शिकायत पहले "हल" की गई थी, फिर से खोली गई है</p>` : ""}
    <div class="badges">
      ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency])}</span>` : ""}
      <span class="badge ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span>
      ${c.supporters > 1 ? `<span class="badge merged">👥 ${c.supporters} लोगों ने बताया</span>` : ""}
      ${(c.merged_ids || []).length ? `<span class="badge merged" title="इस शिकायत में जुड़ी रिपोर्ट">🔗 जुड़ी: ${c.merged_ids.map((i) => `#${i}`).join(", ")}</span>` : ""}
      <span class="badge">📍 ${esc(c.area || "जगह नहीं बताई")}</span>
      ${c.location ? `<a class="badge resolved" href="${mapLink(c.location)}" target="_blank" rel="noopener"
        title="नागरिक के फ़ोन की सटीक जगह">🗺️ नक्शे पर · ${esc(plusCode(c.location.lat, c.location.lon))}${c.location.accuracy != null ? ` · ±${c.location.accuracy} मी.` : ""}</a>` : ""}
      ${c.photo ? `<span class="badge">📷 फ़ोटो</span>` : ""}
      <span class="badge">${starsHtml(c.info_level)}</span>${c.gave_mobile ? `<span class="badge">📱 मोबाइल दिया</span>` : ""}
    </div>
    ${d.urgency_reason ? `<p class="why">क्यों ${esc(URGENCY[c.urgency] || "")}: ${esc(d.urgency_reason)}</p>` : ""}
    <p class="citizen-text" translate="no">“${esc(c.text)}”</p>
    <details><summary>📷 फ़ोटो, 📄 पत्र और 🤖 AI की जाँच</summary>
      ${evidenceHtml(c)}
      ${d.formal_letter_hi ? `<div class="letter" translate="no">${esc(d.formal_letter_hi)}</div>` : ""}
      ${traceHtml(c.trace)}
    </details>
    ${updates ? `<ul class="history">${updates}</ul>` : ""}
    ${actionsHtml(c)}
  </article>`;
}

const unheard = (c) => c.status === "open" && !(c.updates || []).length;
const TESTS = {
  all: () => true,
  open: (c) => c.status === "open",
  overdue: (c) => c.overdue,
  unheard,
  critical: (c) => c.urgency === "critical",
  high: (c) => c.urgency === "high",
  in_progress: (c) => c.status === "in_progress",
  needs_review: (c) => c.status === "needs_review",
  closed: () => true,
};
const SORTS = {
  idle: (a, b) => b.idle_days - a.idle_days,
  oldest: (a, b) => a.created_at.localeCompare(b.created_at),
  people: (a, b) => b.supporters - a.supporters,
};
let closedQueue = [];

/** The chosen time window: complaints filed inside it (1 hour, 24 hours, or N days). */
const windowStart = () => Date.now() - (hours ? hours * 36e5 : days * 864e5);
const inWindow = (c) => new Date(c.created_at).getTime() >= windowStart();
const windowName = () => (hours === 1 ? "पिछले 1 घंटे में आईं" : hours ? "आज (24 घंटे) में आईं" : `पिछले ${days} दिन में आईं`);

function markPreset() {
  document.querySelectorAll("#presets .chip[data-days], #presets .chip[data-hours]").forEach((c) =>
    c.setAttribute("aria-pressed", String(hours ? Number(c.dataset.hours) === hours : !c.dataset.hours && Number(c.dataset.days) === days)));
}

function matches(c) {
  if (!TESTS[filter](c) || (dept && deptOf(c) !== dept) || !inWindow(c)) return false;
  const q = $("search").value.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  const d = c.decision || {};
  // a report merged into this complaint is found by its own number too
  return String(c.id) === q || (c.merged_ids || []).map(String).includes(q)
    || `${c.text} ${c.area} ${d.title_hi || ""} ${d.title_en || ""}`.toLowerCase().includes(q);
}

function renderQueue() {
  const source = filter === "closed" ? closedQueue : queue;
  const shown = source.filter(matches);
  const sort = SORTS[$("sort").value];
  if (sort) shown.sort(sort);
  const inDept = (list) => list.filter((c) => (!dept || deptOf(c) === dept) && inWindow(c));
  document.querySelectorAll("#filters [data-count]").forEach((b) => {
    const k = b.dataset.count;
    b.textContent = k === "closed" ? inDept(closedQueue).length : inDept(queue).filter(TESTS[k]).length;
  });
  $("queueDept").textContent = `${dept ? `· ${ICON[dept] || "🔎"} ${deptName(dept)} ` : ""}· ${windowName()}`;
  $("queueCount").textContent = `(${shown.length} शिकायतें)`;
  // open work filed before the window is not lost: say how much there is and how to see it
  const older = filter === "closed" ? 0 : queue.filter((c) => (!dept || deptOf(c) === dept) && !inWindow(c) && TESTS[filter](c)).length;
  const html = (shown.length
    ? shown.map(itemHtml).join("")
    : `<p class="card empty">${filter === "overdue" ? "👏 कोई काम देर से नहीं रुका।" : source.length ? "इस समय और फ़िल्टर में कोई शिकायत नहीं।" : "🎉 सब काम पूरा। कोई खुली शिकायत नहीं है।"}</p>`)
    + (older ? `<p class="hint older-note">➕ इससे पहले की ${older} खुली शिकायतें भी हैं — <button type="button" class="link" data-widen="1">90 दिन की सब देखें</button></p>` : "");
  // the same list again (a refresh with nothing new) is left alone: no flicker, no lost scroll
  if ($("queue")._html !== html) { $("queue").innerHTML = html; $("queue")._html = html; }
}

function setFilter(name) {
  filter = name;
  document.querySelectorAll("#filters .chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.filter === name)));
  renderQueue();
}

async function refresh() {
  // Never re-render under an officer who is typing a note.
  if (document.activeElement && document.activeElement.closest(".actions")) return;
  if ([...document.querySelectorAll(".actions")].some((b) => b._proof)) return;
  const key = viewKey();
  const [view, items, pub, done] = await Promise.all([
    fetchView(), api("/api/officer/queue"), fetch("/api/public/stats").then((r) => r.json()), api("/api/officer/queue?closed=1"),
  ]);
  closedQueue = done;
  if (key === viewKey()) paintView(view, key);
  if (firstPaint) prefetchViews();
  firstPaint = false;
  renderPublic(pub);
  queue = items;
  renderDeptChips();
  renderQueue();
  $("refreshed").textContent = "अपडेट: " + new Date().toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
}

async function act(button) {
  const item = button.closest(".item");
  const box = button.closest(".actions");
  const note = box.querySelector('[data-role="note"]').value.trim();
  const category = box.querySelector('[data-role="category"]')?.value;
  const msg = box.querySelector('[data-role="msg"]');
  if (button.dataset.status === "reopened" && !note) {
    msg.textContent = "↩️ फिर से खोलने का कारण नोट में लिखिए — यह नागरिक को भी दिखेगा।";
    box.querySelector('[data-role="note"]').focus();
    return;
  }
  box.querySelectorAll("button").forEach((b) => (b.disabled = true));
  msg.textContent = "नागरिक के लिए संदेश लिखा जा रहा है…";
  try {
    const r = await api(`/api/officer/complaints/${item.dataset.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: button.dataset.status, note, category }),
    });
    msg.textContent = `✓ नागरिक को भेजा: "${r.message_hi}"`;
    const file = box._proof || box.querySelector('[data-role="proof"]')?.files[0];
    if (file && PROOF_STATES.includes(button.dataset.status)) {
      msg.textContent += " · फ़ोटो जोड़ी जा रही है…";
      await uploadProof(r.update_id, file);
      msg.textContent = msg.textContent.replace(" · फ़ोटो जोड़ी जा रही है…", " · 📷 फ़ोटो जुड़ गई");
    }
    toast(`✓ #${item.dataset.id}: नागरिक को संदेश भेजा गया`, "ok");
    if (button.dataset.status === "resolved") celebrate();
    setTimeout(() => { document.activeElement?.blur(); refresh(); }, 2500);
  } catch (err) {
    msg.textContent = "नहीं हुआ: " + err.message;
    toast("नहीं हुआ: " + err.message, "bad");
    box.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

// Shrunk and stripped of EXIF/GPS on the device, exactly like a citizen's photo.
async function uploadProof(updateId, file) {
  const form = new FormData();
  form.append("photo", await shrinkPhoto(file), "work.jpg");
  const r = await fetch(`/api/officer/updates/${updateId}/photo`, {
    method: "POST", body: form, headers: { Authorization: `Bearer ${token || ""}` },
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    toast("फ़ोटो नहीं जुड़ी: " + (body.detail || r.status), "bad");
  }
}

// --- the bell: new complaints arrive while the dashboard is open ---------------------------------------

function ring() {
  try {  // a short two-note chime; browsers allow it once the officer has clicked anything on the page
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      o.start(t); o.stop(t + 0.32);
    });
  } catch { /* no sound: the toast and the badge still show */ }
}

function setUnread(n) {
  unread = n;
  $("bellCount").textContent = n;
  $("bellCount").hidden = !n;
  $("bell").classList.toggle("ringing", n > 0);
  document.title = (n ? `(${n}) ` : "") + document.title.replace(/^\(\d+\) /, "");
}

async function pulse() {
  const p = await api(`/api/officer/pulse?after=${lastSeen}`);
  if (!lastSeen) { lastSeen = p.latest; return; }  // the first look only learns where "new" starts
  if (!p.new.length) return;
  lastSeen = Math.max(lastSeen, ...p.new.map((n) => n.id));
  for (const n of p.new.slice().reverse()) {
    fresh.add(n.id);
    const where = `${ICON[n.category] || "🔎"} ${deptName(n.category || "review")}${n.area ? ` · ${n.area}` : ""}`;
    const what = n.duplicate_of ? `#${n.id} नई रिपोर्ट, शिकायत #${n.duplicate_of} से जुड़ी` : `नई शिकायत #${n.id}: ${tt(n)}`;
    toast(`🔔 ${what} — ${where} · देखें →`, n.urgency === "critical" ? "bad" : "ok", () => { setUnread(Math.max(0, unread - 1)); openComplaint(n.id); });
    try {
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(`Awaaz: ${what}`, { body: where, tag: `awaaz-${n.id}` });
      }
    } catch { /* notifications are a bonus */ }
  }
  ring();
  setUnread(unread + p.new.length);
  await refresh();
}

async function start(officer) {
  me = officer;
  $("bell").hidden = false;
  $("loginCard").hidden = true;
  $("dash").hidden = false;
  const scope = SCOPES[officer.department] || officer.department;
  $("who").hidden = false;
  $("who").innerHTML = `<b>${esc(officer.name)}</b><button class="link" type="button" id="logout">लॉग आउट</button>`;
  $("logout").addEventListener("click", logout);
  $("deptName").textContent = scope;
  pulse().catch(() => {});
  $("greeting").textContent = `नमस्ते, ${officer.name}`;
  await refresh();
}

$("loginForm").addEventListener("submit", login);
$("queue").addEventListener("click", (e) => {
  const button = e.target.closest("button.act");
  if (button) act(button);
});
$("filters").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (chip) setFilter(chip.dataset.filter);
});
$("kpis").addEventListener("click", (e) => {
  const tile = e.target.closest("[data-jump]");
  if (!tile) return;
  setFilter(tile.dataset.jump);
  $("queueSection").scrollIntoView({ behavior: "smooth", block: "start" });
});
$("sort").addEventListener("change", renderQueue);
// A department can be picked from the sticky bar, the department chart or the ranking table.
document.addEventListener("click", (e) => {
  const pick = e.target.closest("#deptChips [data-dept], #deptChart [data-dept], #deptTable [data-dept]");
  if (!pick) return;
  const k = pick.dataset.dept;
  // a second click on the chosen bar or row shows every department again
  const next = pick.closest("#deptChips") ? k : dept === k ? "" : k;
  setDept(next).catch((err) => toast(err.message, "bad"));
  if (next) setTimeout(() => goToQueue(), 50);  // straight to that department's complaints
});
$("export").addEventListener("click", async () => {
  const r = await fetch("/api/officer/export.csv", { headers: { Authorization: `Bearer ${token || ""}` } });
  if (!r.ok) { toast("फ़ाइल नहीं बन पाई", "bad"); return; }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await r.blob());
  a.download = `awaaz-complaints-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  toast("⬇️ फ़ाइल डाउनलोड हो रही है — Excel में खोलें", "ok");
});
animateLists($("queue"), $("list"));
$("search").addEventListener("input", renderQueue);
$("presets").addEventListener("click", async (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  if (chip.id === "print") { window.print(); return; }
  hours = Number(chip.dataset.hours || 0);
  if (!hours) days = Number(chip.dataset.days);
  markPreset();
  await showView().catch((err) => toast(err.message, "bad"));
});
$("ltabs").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip || !insight) return;
  listKey = chip.dataset.list;
  document.querySelectorAll("#ltabs .chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
  $("list").innerHTML = listHtml(listKey);
});
// The work photo, from the gallery or the camera, is kept on its action box until the officer acts.
function setProof(box, blob, label) {
  box._proof = blob;
  box.querySelector('[data-role="proofName"]').textContent = blob ? `✓ ${label}` : "";
}
$("queue").addEventListener("change", (e) => {
  const role = e.target.dataset.role;
  if (role !== "proof" && role !== "proofcam") return;
  const f = e.target.files[0];
  setProof(e.target.closest(".actions"), f || null, f ? f.name || "कैमरा की फ़ोटो" : "");
});
$("queue").addEventListener("click", async (e) => {
  const cam = e.target.closest('[data-role="cam"]');
  if (!cam) return;
  const box = cam.closest(".actions");
  if (TOUCH) { box.querySelector('[data-role="proofcam"]').click(); return; }
  const blob = await takePhoto();
  if (blob) setProof(box, blob, "कैमरा की फ़ोटो");
});
setInterval(() => { if (token && !$("dash").hidden) refresh().catch(() => {}); }, REFRESH_MS);
setInterval(() => { if (token && !$("dash").hidden) pulse().catch(() => {}); }, PULSE_MS);
$("queue").addEventListener("click", (e) => {
  if (!e.target.closest("[data-widen]")) return;
  hours = 0; days = 90; markPreset(); showView().catch(() => {});
});
$("bell").addEventListener("click", () => {
  setUnread(0);
  const newest = Math.max(0, ...fresh);
  if (newest) openComplaint(newest); else { setFilter("all"); goToQueue(); }
  // the first click is also the moment to ask for desktop notifications, for when this tab is in the background
  try { if ("Notification" in window && Notification.permission === "default") Notification.requestPermission(); } catch { /* ignore */ }
});

// Only a rejected login (401, handled in api) logs the officer out. A slow or sleeping server, or a network
// blip, is retried instead, so the officer is never thrown out for something that is not their login.
async function boot(tries = 0) {
  try {
    await start(await api("/api/officer/me"));
  } catch (err) {
    if (!token) return;  // the login itself was refused: api() has already shown the login form
    console.error("dashboard did not load, retrying", err);
    if (tries === 0) toast("सर्वर धीमा है — फिर से कोशिश कर रहे हैं…", "bad");
    setTimeout(() => boot(tries + 1), Math.min(10000, 2000 * (tries + 1)));
  }
}

if (token) {
  boot();
} else {
  logout();
}
