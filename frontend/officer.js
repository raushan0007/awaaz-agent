import {
  $, CATEGORY, chakraHtml, countUp, DEPARTMENTS, esc, evidenceHtml, formatTime, ICON, mapLink, mountChrome, plusCode,
  shrinkPhoto, STATUS,
  starsHtml, timeAgo, toast, traceHtml, URGENCY, WAVES,
} from "./shared.js";

mountChrome("officer");
$("hero").insertAdjacentHTML("afterbegin", chakraHtml());
$("hero").insertAdjacentHTML("beforeend", WAVES);
$("headerExtra").innerHTML = `<div class="who" id="who" hidden></div>`;

const SCOPES = { ...DEPARTMENTS, all: "सभी विभाग (ज़िला)" };
// What an officer can do next from each state; mirrors TRANSITIONS on the server.
const ACTIONS = {
  open: [["in_progress", "काम शुरू"], ["resolved", "हल हो गई"], ["rejected", "बंद करें"]],
  in_progress: [["resolved", "हल हो गई"]],
  needs_review: [["open", "विभाग को भेजें"], ["rejected", "बंद करें"]],
};
// Donut slices: label and colour per status (kept in step with the tile tones in style.css).
const SLICES = [
  ["open", "खुली", "#7aa7ff"],
  ["in_progress", "काम चल रहा", "#ffb347"],
  ["resolved", "हल हुईं", "#46dc5f"],
  ["needs_review", "जाँच बाकी", "#a9b6ff"],
  ["rejected", "बंद", "#7c8098"],
];
// Only work started or finished can carry a photo of the work (the server checks the same).
const PROOF_STATES = ["in_progress", "resolved"];
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
  $("kpis").innerHTML = tiles.map(([tone, label]) => `<div class="kpi ${tone}"><b>0</b><span>${label}</span></div>`).join("");
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
    ? `<text x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${new Date(d.day).toLocaleDateString("hi-IN", { day: "numeric", month: "short" })}</text>` : "").join("");
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
    <td>#${p.id} ${ICON[p.category] || ""} ${esc(p.title_hi || CATEGORY[p.category] || "")}<br><small class="hint">📍 ${esc(p.area || "")}</small></td>
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
      `<span>✅ #${f.id} ${esc(f.title_hi)} · ${esc(f.area || "")} · ${esc(timeAgo(f.fixed_at))}</span>`).join("");
    $("tickerTrack").innerHTML = items + items;
    $("ticker").hidden = false;
  }
}

function actionsHtml(c) {
  const actions = ACTIONS[c.status] || [];
  if (!actions.length) return "";
  const routing = c.status === "needs_review"
    ? `<label>किस विभाग को भेजें</label><select data-role="category">${Object.entries(DEPARTMENTS)
        .map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>`
    : "";
  return `<div class="actions">
    ${routing}
    <label>नोट (नागरिक को सरल हिंदी में बताया जाएगा)</label>
    <textarea data-role="note" rows="2" maxlength="500" placeholder="जैसे: JE ne site dekh li, kal se kaam shuru"></textarea>
    ${actions.some(([s]) => PROOF_STATES.includes(s)) ? `<div class="proof-pick">
      <label class="pick-btn">📷 काम की फ़ोटो जोड़ें<input type="file" accept="image/*" data-role="proof" hidden></label>
      <span class="hint" data-role="proofName">ज़रूरी नहीं — नागरिक को काम होता दिखेगा</span></div>` : ""}
    <div class="action-buttons">${actions.map(([status, label]) =>
      `<button type="button" class="act ${status}" data-status="${status}">${label}</button>`).join("")}</div>
    <p class="status" data-role="msg"></p>
  </div>`;
}

function itemHtml(c) {
  const d = c.decision || {};
  const updates = (c.updates || []).map((u) =>
    `<li><time>${esc(formatTime(u.created_at))}</time> <b>${esc(STATUS[u.status] || u.status)}</b> — ${esc(u.message_hi)}
      ${u.photo ? `<a href="/api/updates/${u.id}/photo" target="_blank" rel="noopener">📷 फ़ोटो</a>` : ""}</li>`).join("");
  return `<article class="card item ${esc(c.urgency || "")}" data-id="${c.id}">
    <div class="item-head">
      <h3>#${c.id} ${esc(d.title_hi || c.text.slice(0, 80))}</h3>
      <span class="status">${esc(age(c.created_at))}</span>
    </div>
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
    <p class="citizen-text">“${esc(c.text)}”</p>
    <details><summary>📷 फ़ोटो, 📄 पत्र और 🤖 AI की जाँच</summary>
      ${evidenceHtml(c)}
      ${d.formal_letter_hi ? `<div class="letter">${esc(d.formal_letter_hi)}</div>` : ""}
      ${traceHtml(c.trace)}
    </details>
    ${updates ? `<ul class="history">${updates}</ul>` : ""}
    ${actionsHtml(c)}
  </article>`;
}

function matches(c) {
  if (filter === "critical" || filter === "high") { if (c.urgency !== filter) return false; }
  else if (filter !== "all" && c.status !== filter) return false;
  const q = $("search").value.trim().toLowerCase();
  if (!q) return true;
  const d = c.decision || {};
  return `${c.text} ${c.area} ${d.title_hi || ""} ${d.title_en || ""}`.toLowerCase().includes(q);
}

function renderQueue() {
  const shown = queue.filter(matches);
  $("queueCount").textContent = shown.length === queue.length ? `(${queue.length})` : `(${shown.length} / ${queue.length})`;
  $("queue").innerHTML = shown.length
    ? shown.map(itemHtml).join("")
    : `<p class="card empty">${queue.length ? "इस फ़िल्टर में कुछ नहीं।" : "🎉 सब काम पूरा। कोई खुली शिकायत नहीं है।"}</p>`;
}

async function refresh() {
  // Never re-render under an officer who is typing a note.
  if (document.activeElement && document.activeElement.closest(".actions")) return;
  if ([...document.querySelectorAll('[data-role="proof"]')].some((f) => f.files.length)) return;
  const [stats, items, ins, pub] = await Promise.all([
    api("/api/officer/stats"), api("/api/officer/queue"), api(`/api/officer/insights?days=${days}`),
    fetch("/api/public/stats").then((r) => r.json()),
  ]);
  $("donut").innerHTML = donutHtml(stats.by_status);
  // Re-draw the analysis only when it changed, so the animations do not replay every 30 seconds.
  if (firstPaint || JSON.stringify(ins) !== JSON.stringify(insight)) renderInsights(ins);
  firstPaint = false;
  renderPublic(pub);
  queue = items;
  renderQueue();
  $("refreshed").textContent = "अपडेट: " + new Date().toLocaleTimeString("hi-IN", { hour: "numeric", minute: "2-digit" });
}

async function act(button) {
  const item = button.closest(".item");
  const box = button.closest(".actions");
  const note = box.querySelector('[data-role="note"]').value.trim();
  const category = box.querySelector('[data-role="category"]')?.value;
  const msg = box.querySelector('[data-role="msg"]');
  box.querySelectorAll("button").forEach((b) => (b.disabled = true));
  msg.textContent = "नागरिक के लिए संदेश लिखा जा रहा है…";
  try {
    const r = await api(`/api/officer/complaints/${item.dataset.id}/status`, {
      method: "POST",
      body: JSON.stringify({ status: button.dataset.status, note, category }),
    });
    msg.textContent = `✓ नागरिक को भेजा: "${r.message_hi}"`;
    const file = box.querySelector('[data-role="proof"]')?.files[0];
    if (file && PROOF_STATES.includes(button.dataset.status)) {
      msg.textContent += " · फ़ोटो जोड़ी जा रही है…";
      await uploadProof(r.update_id, file);
      msg.textContent = msg.textContent.replace(" · फ़ोटो जोड़ी जा रही है…", " · 📷 फ़ोटो जुड़ गई");
    }
    toast(`✓ #${item.dataset.id}: नागरिक को संदेश भेजा गया`, "ok");
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
  if (!chip) return;
  filter = chip.dataset.filter;
  document.querySelectorAll("#filters .chip").forEach((c) => c.setAttribute("aria-pressed", String(c === chip)));
  renderQueue();
});
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
$("queue").addEventListener("change", (e) => {
  if (e.target.dataset.role !== "proof") return;
  const name = e.target.closest(".proof-pick").querySelector('[data-role="proofName"]');
  name.textContent = e.target.files[0] ? `✓ ${e.target.files[0].name}` : "";
});
setInterval(() => { if (token && !$("dash").hidden) refresh().catch(() => {}); }, REFRESH_MS);

if (token) {
  api("/api/officer/me").then(start).catch(logout);
} else {
  logout();
}
