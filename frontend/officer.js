import {
  $, CATEGORY, chakraHtml, countUp, DEPARTMENTS, esc, evidenceHtml, formatTime, ICON, mapLink, mountChrome, plusCode,
  animateLists, celebrate, shrinkPhoto, STATUS, takePhoto, TOUCH, WORK_STAGES,
  starsHtml, timeAgo, toast, traceHtml, URGENCY, WAVES,
  LOCALE, tt,
} from "./shared.js";

mountChrome("officer");
$("hero").insertAdjacentHTML("afterbegin", chakraHtml());
$("hero").insertAdjacentHTML("beforeend", WAVES);
$("headerExtra").innerHTML = `<div class="who" id="who" hidden></div>`;

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
  ["open", "खुली", "#7aa7ff"],
  ["in_progress", "काम चल रहा", "#ffb347"],
  ["resolved", "हल हुईं", "#46dc5f"],
  ["needs_review", "जाँच बाकी", "#a9b6ff"],
  ["rejected", "बंद", "#7c8098"],
];
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
let insight = null;
let listKey = "most_reported";
let firstPaint = true;

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

function age(iso) {
  const hours = (Date.now() - new Date(iso)) / 36e5;
  if (hours < 1) return "अभी";
  if (hours < 24) return `${Math.floor(hours)} घंटे पहले`;
  return `${Math.floor(hours / 24)} दिन पहले`;
}

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
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="स्थिति के हिसाब से ${total} शिकायतें">
      ${rings}<text x="70" y="70" text-anchor="middle" font-size="30" font-weight="800">${total}</text>
      <text x="70" y="92" text-anchor="middle" font-size="12" fill="currentColor" opacity=".6">शिकायतें</text></svg>
    <ul class="legend">${parts.map(([label, colour, v]) =>
      `<li><i style="background:${colour}"></i>${label} <b>${v}</b></li>`).join("")}</ul>`;
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

// Filed (saffron) and fixed (green) per day as two drawn lines over a light grid.
function trendHtml(series) {
  const W = 640, H = 220, L = 30, B = 24, T = 10;
  const max = Math.max(2, ...series.map((d) => Math.max(d.filed, d.fixed)));
  const x = (i) => L + (i * (W - L - 8)) / Math.max(1, series.length - 1);
  const y = (v) => H - B - (v * (H - B - T)) / max;
  const line = (key) => series.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(d[key]).toFixed(1)}`).join(" ");
  const area = (key) => `${line(key)} L${x(series.length - 1).toFixed(1)} ${H - B} L${L} ${H - B}Z`;
  const ticks = [0, Math.ceil(max / 2), max];
  const every = Math.ceil(series.length / 6);
  const labels = series.map((d, i) => (i % every === 0 || i === series.length - 1)
    ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${new Date(d.day).toLocaleDateString(LOCALE, { day: "numeric", month: "short" })}</text>` : "").join("");
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="रोज़ आई और हल हुई शिकायतें">
    <defs><linearGradient id="gr" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff9a2e" stop-opacity=".35"/><stop offset="1" stop-color="#ff9a2e" stop-opacity="0"/></linearGradient>
    <linearGradient id="gg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#46dc5f" stop-opacity=".3"/><stop offset="1" stop-color="#46dc5f" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join("")}</g>
    <path d="${area("filed")}" fill="url(#gr)"/><path d="${area("fixed")}" fill="url(#gg)"/>
    <path class="rcv draw" d="${line("filed")}" fill="none" stroke-width="2.5" stroke-linejoin="round"/>
    <path class="rsv draw" d="${line("fixed")}" fill="none" stroke-width="2.5" stroke-linejoin="round"/>
    ${labels}</svg>`;
}

function deptTableHtml(rows) {
  if (!rows.length) return `<p class="status">इस अवधि में कोई शिकायत नहीं।</p>`;
  return `<table class="tbl"><thead><tr><th>विभाग</th><th>समस्याएँ</th><th>रिपोर्ट</th><th>खुली</th><th>हल</th><th>हल दर</th>
    <th>औसत समाधान</th><th>पहला जवाब</th><th>अनसुनी</th></tr></thead><tbody>${rows.map((d) => `<tr>
    <td>${ICON[d.category] || "🔎"} ${esc(DEPARTMENTS[d.category] || "AI जाँच बाकी")}${d.badge ? `<span class="rbadge ${d.badge}">${d.badge === "best" ? "सबसे अच्छा" : "पीछे"}</span>` : ""}</td>
    <td class="num">${d.issues}</td><td class="num">${d.reports}</td><td class="num">${d.open}</td><td class="num">${d.resolved}</td>
    <td>${rateHtml(d.rate)}</td><td class="num">${daysTxt(d.avg_days)}</td><td class="num">${hoursTxt(d.avg_response_hours)}</td>
    <td class="num">${d.unheard ? `<b style="color:var(--bad)">${d.unheard}</b>` : 0}</td></tr>`).join("")}</tbody></table>
    ${rows.some((d) => d.badge) ? "" : `<p class="hint">रैंकिंग के लिए हर विभाग में कम से कम 3 शिकायतें चाहिए।</p>`}`;
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
  $("period").textContent = `(पिछले ${ins.days} दिन)`;
  renderKpis(ins.kpis);
  $("trend").innerHTML = trendHtml(ins.trend);
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
    $("tickerTrack").innerHTML = items + items;
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
    `<li><time>${esc(formatTime(u.created_at))}</time> <b>${esc(STATUS[u.status] || u.status)}</b> — <span translate="no">${esc(u.message_hi)}</span>
      ${u.photo ? `<a href="/api/updates/${u.id}/photo" target="_blank" rel="noopener">📷 फ़ोटो</a>` : ""}</li>`).join("");
  const late = c.overdue
    ? `<p class="late">⏰ ${Math.floor(c.idle_days)} दिन से ${OVERDUE_TEXT[c.status] || "कोई कार्रवाई नहीं"} — जल्दी देखें</p>` : "";
  const reopened = (c.updates || []).some((u) => u.status === "reopened");
  return `<article class="card item ${esc(c.urgency || "")} ${c.overdue ? "is-late" : ""}" data-id="${c.id}">
    <div class="item-head">
      <h3>#${c.id} ${esc(tt(d) || c.text.slice(0, 80))}</h3>
      <span class="status">${esc(age(c.created_at))}</span>
    </div>
    ${late}${reopened ? `<p class="late reopen">↩️ यह शिकायत पहले "हल" की गई थी, फिर से खोली गई है</p>` : ""}
    <div class="badges">
      ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency])}</span>` : ""}
      <span class="badge ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span>
      ${c.supporters > 1 ? `<span class="badge merged">👥 ${c.supporters} लोगों ने बताया</span>` : ""}
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

function matches(c) {
  if (!TESTS[filter](c)) return false;
  const q = $("search").value.trim().toLowerCase().replace(/^#/, "");
  if (!q) return true;
  const d = c.decision || {};
  return String(c.id) === q || `${c.text} ${c.area} ${d.title_hi || ""} ${d.title_en || ""}`.toLowerCase().includes(q);
}

function renderQueue() {
  const source = filter === "closed" ? closedQueue : queue;
  const shown = source.filter(matches);
  const sort = SORTS[$("sort").value];
  if (sort) shown.sort(sort);
  document.querySelectorAll("#filters [data-count]").forEach((b) => {
    const k = b.dataset.count;
    const n = k === "closed" ? closedQueue.length : queue.filter(TESTS[k]).length;
    b.textContent = n;
  });
  $("queueCount").textContent = `(${shown.length})`;
  $("queue").innerHTML = shown.length
    ? shown.map(itemHtml).join("")
    : `<p class="card empty">${filter === "overdue" ? "👏 कोई काम देर से नहीं रुका।" : source.length ? "इस फ़िल्टर में कुछ नहीं।" : "🎉 सब काम पूरा। कोई खुली शिकायत नहीं है।"}</p>`;
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
  const [stats, items, ins, pub, done] = await Promise.all([
    api("/api/officer/stats"), api("/api/officer/queue"), api(`/api/officer/insights?days=${days}`),
    fetch("/api/public/stats").then((r) => r.json()), api("/api/officer/queue?closed=1"),
  ]);
  closedQueue = done;
  $("donut").innerHTML = donutHtml(stats.by_status);
  // Re-draw the analysis only when it changed, so the animations do not replay every 30 seconds.
  if (firstPaint || JSON.stringify(ins) !== JSON.stringify(insight)) renderInsights(ins);
  firstPaint = false;
  renderPublic(pub);
  queue = items;
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

async function start(officer) {
  $("loginCard").hidden = true;
  $("dash").hidden = false;
  const scope = SCOPES[officer.department] || officer.department;
  $("who").hidden = false;
  $("who").innerHTML = `<b>${esc(officer.name)}</b><button class="link" type="button" id="logout">लॉग आउट</button>`;
  $("logout").addEventListener("click", logout);
  $("deptName").textContent = scope;
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
  days = Number(chip.dataset.days);
  document.querySelectorAll("#presets .chip[data-days]").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
  renderInsights(await api(`/api/officer/insights?days=${days}`));
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

if (token) {
  api("/api/officer/me").then(start).catch(logout);
} else {
  logout();
}
