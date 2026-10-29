import { $, esc, evidenceHtml, formatTime, STATUS, traceHtml, URGENCY } from "./shared.js";

const DEPARTMENTS = {
  roads: "सड़क एवं निर्माण विभाग",
  water: "पेयजल एवं स्वच्छता विभाग (PHED)",
  electricity: "बिजली वितरण विभाग",
  streetlight: "नगर परिषद – स्ट्रीट लाइट",
  sanitation: "नगर परिषद – सफ़ाई विभाग",
  drainage: "नाला एवं जल-निकासी विभाग",
  other: "लोक शिकायत प्रकोष्ठ",
  all: "सभी विभाग (ज़िला)",
};
// What an officer can do next from each state; mirrors TRANSITIONS on the server.
const ACTIONS = {
  open: [["in_progress", "काम शुरू"], ["resolved", "हल हो गई"], ["rejected", "बंद करें"]],
  in_progress: [["resolved", "हल हो गई"]],
  needs_review: [["open", "विभाग को भेजें"], ["rejected", "बंद करें"]],
};
const REFRESH_MS = 30000;

let token = null;
try { token = localStorage.getItem("awaaz-officer-token"); } catch { /* private mode: log in each time */ }

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
  $("logout").hidden = true;
  $("who").textContent = "";
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

function renderStats(s) {
  const n = (k) => s.by_status[k] || 0;
  const tiles = [
    ["खुली", n("open"), ""],
    ["काम चल रहा", n("in_progress"), ""],
    ["हल हुईं", n("resolved"), "ok"],
    ["जाँच बाकी", n("needs_review"), n("needs_review") ? "warn" : ""],
    [`कुल रिपोर्ट (${s.days} दिन)`, s.reports, ""],
  ];
  $("stats").innerHTML = tiles.map(([label, value, tone]) =>
    `<div class="tile ${tone}"><b>${value}</b><span>${label}</span></div>`).join("");
  const max = Math.max(1, ...s.top_areas.map((a) => a.open));
  $("areas").innerHTML = s.top_areas.length
    ? s.top_areas.map((a) => `<div class="area-row"><span>${esc(a.area || "—")}</span>
        <div class="bar"><i style="width:${(a.open / max) * 100}%"></i></div>
        <b>${a.open}</b>${a.urgent ? `<em>${a.urgent} ज़रूरी</em>` : ""}</div>`).join("")
    : `<p class="status">अभी कोई खुली शिकायत नहीं है।</p>`;
}

function actionsHtml(c) {
  const actions = ACTIONS[c.status] || [];
  if (!actions.length) return "";
  const routing = c.status === "needs_review"
    ? `<label>किस विभाग को भेजें</label><select data-role="category">${Object.entries(DEPARTMENTS)
        .filter(([k]) => k !== "all").map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}</select>`
    : "";
  return `<div class="actions">
    ${routing}
    <label>नोट (नागरिक को सरल हिंदी में बताया जाएगा)</label>
    <textarea data-role="note" rows="2" maxlength="500" placeholder="जैसे: JE ne site dekh li, kal se kaam shuru"></textarea>
    <div class="action-buttons">${actions.map(([status, label]) =>
      `<button type="button" class="act ${status}" data-status="${status}">${label}</button>`).join("")}</div>
    <p class="status" data-role="msg"></p>
  </div>`;
}

function itemHtml(c) {
  const d = c.decision || {};
  const updates = (c.updates || []).map((u) =>
    `<li><time>${esc(formatTime(u.created_at))}</time> <b>${esc(STATUS[u.status] || u.status)}</b> — ${esc(u.message_hi)}</li>`).join("");
  return `<article class="card item ${esc(c.urgency || "")}" data-id="${c.id}">
    <div class="item-head">
      <h3>#${c.id} ${esc(d.title_hi || c.text.slice(0, 80))}</h3>
      <span class="status">${esc(age(c.created_at))}</span>
    </div>
    <div class="badges">
      ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency])}</span>` : ""}
      <span class="badge ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span>
      ${c.supporters > 1 ? `<span class="badge">${c.supporters} लोगों ने बताया</span>` : ""}
      <span class="badge">${esc(c.area || "जगह नहीं बताई")}</span>
      ${c.photo ? `<span class="badge">📷 फ़ोटो</span>` : ""}
    </div>
    ${d.urgency_reason ? `<p class="why">क्यों ${esc(URGENCY[c.urgency] || "")}: ${esc(d.urgency_reason)}</p>` : ""}
    <p class="citizen-text">“${esc(c.text)}”</p>
    <details><summary>फ़ोटो, पत्र और AI की जाँच</summary>
      ${evidenceHtml(c)}
      ${d.formal_letter_hi ? `<div class="letter">${esc(d.formal_letter_hi)}</div>` : ""}
      ${traceHtml(c.trace)}
    </details>
    ${updates ? `<ul class="history">${updates}</ul>` : ""}
    ${actionsHtml(c)}
  </article>`;
}

async function refresh() {
  // Never re-render under an officer who is typing a note.
  if (document.activeElement && document.activeElement.closest(".actions")) return;
  const [stats, queue] = await Promise.all([api("/api/officer/stats"), api("/api/officer/queue")]);
  renderStats(stats);
  $("queueCount").textContent = `(${queue.length})`;
  $("queue").innerHTML = queue.length ? queue.map(itemHtml).join("") : `<p class="card status">सब काम पूरा। कोई खुली शिकायत नहीं है।</p>`;
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
    setTimeout(() => { document.activeElement?.blur(); refresh(); }, 2500);
  } catch (err) {
    msg.textContent = "नहीं हुआ: " + err.message;
    box.querySelectorAll("button").forEach((b) => (b.disabled = false));
  }
}

async function start(officer) {
  $("loginCard").hidden = true;
  $("dash").hidden = false;
  $("logout").hidden = false;
  $("who").textContent = `${officer.name} · ${DEPARTMENTS[officer.department] || officer.department}`;
  await refresh();
}

$("loginForm").addEventListener("submit", login);
$("logout").addEventListener("click", logout);
$("queue").addEventListener("click", (e) => {
  const button = e.target.closest("button.act");
  if (button) act(button);
});
setInterval(() => { if (token && !$("dash").hidden) refresh().catch(() => {}); }, REFRESH_MS);

if (token) {
  api("/api/officer/me").then(start).catch(logout);
} else {
  logout();
}
