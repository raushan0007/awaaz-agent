import {
  $, DEPARTMENTS, esc, evidenceHtml, formatTime, mountChrome, shrinkPhoto, STATUS, toast, traceHtml, URGENCY,
} from "./shared.js";

mountChrome("officer");
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
  ["open", "खुली", "#2563eb"],
  ["in_progress", "काम चल रहा", "#f59e0b"],
  ["resolved", "हल हुईं", "#16a34a"],
  ["needs_review", "जाँच बाकी", "#6366f1"],
  ["rejected", "बंद", "#9ca3af"],
];
// Only work started or finished can carry a photo of the work (the server checks the same).
const PROOF_STATES = ["in_progress", "resolved"];
const REFRESH_MS = 30000;

let token = null;
try { token = localStorage.getItem("awaaz-officer-token"); } catch { /* private mode: log in each time */ }
let queue = [];
let filter = "all";

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

function renderStats(s) {
  const n = (k) => s.by_status[k] || 0;
  const tiles = [
    ["open", "खुली", n("open")],
    ["in_progress", "काम चल रहा", n("in_progress")],
    ["resolved", "हल हुईं", n("resolved")],
    ["needs_review", "जाँच बाकी", n("needs_review")],
    ["total", `कुल रिपोर्ट (${s.days} दिन)`, s.reports],
  ];
  $("stats").innerHTML = tiles.map(([tone, label, value]) =>
    `<div class="tile ${tone}"><b>${value}</b><span>${label}</span></div>`).join("");
  $("days").textContent = `(${s.days} दिन)`;
  $("donut").innerHTML = donutHtml(s.by_status);
  const max = Math.max(1, ...s.top_areas.map((a) => a.reports));
  $("areas").innerHTML = s.top_areas.length
    ? s.top_areas.map((a) => `<div class="area-row"><span class="name" title="${esc(a.area)}">${esc(a.area || "—")}</span>
        <div class="bar"><i style="width:${(a.reports / max) * 100}%"></i></div>
        <span class="nums"><b>${a.reports}</b> रिपोर्ट<em>${a.open ? `${a.open} खुली${a.urgent ? `, ${a.urgent} ज़रूरी` : ""}` : "सब हल"}</em></span></div>`).join("")
    : `<p class="status">अभी किसी जगह से बार-बार शिकायत नहीं आई है।</p>`;
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
      ${c.photo ? `<span class="badge">📷 फ़ोटो</span>` : ""}
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
  const [stats, items] = await Promise.all([api("/api/officer/stats"), api("/api/officer/queue")]);
  renderStats(stats);
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
