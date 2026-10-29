import { $, esc, formatTime, STATUS, URGENCY } from "./shared.js";

const STEPS = ["open", "in_progress", "resolved"];

async function show(id) {
  $("status").textContent = "ढूँढ रहे हैं…";
  const r = await fetch(`/api/complaints/${encodeURIComponent(id)}/track`);
  if (!r.ok) {
    $("result").hidden = true;
    $("status").textContent = r.status === 404 ? "इस संख्या की कोई शिकायत नहीं मिली।" : "अभी जानकारी नहीं मिल पाई।";
    return;
  }
  const t = await r.json();
  $("status").textContent = "";
  history.replaceState(null, "", `?id=${t.id}`);

  const reached = STEPS.indexOf(t.status);
  const progress = reached >= 0
    ? `<ol class="steps">${STEPS.map((s, i) => `<li class="${i <= reached ? "done" : ""}">${STATUS[s]}</li>`).join("")}</ol>`
    : `<p class="badge ${esc(t.status)}">${esc(STATUS[t.status] || t.status)}</p>`;
  const updates = t.updates.length
    ? `<ul class="timeline">${t.updates.slice().reverse().map((u) =>
        `<li><time>${esc(formatTime(u.created_at))}</time><span class="badge ${esc(u.status)}">${esc(STATUS[u.status] || u.status)}</span><p>${esc(u.message_hi)}</p></li>`).join("")}</ul>`
    : `<p class="status">अभी विभाग की ओर से कोई नई जानकारी नहीं है।</p>`;

  const el = $("result");
  el.hidden = false;
  el.innerHTML = `
    <h2>${esc(t.title_hi || "शिकायत #" + t.id)}</h2>
    <div class="badges">
      <span class="badge">#${t.id}</span>
      ${t.department_hi ? `<span class="badge">${esc(t.department_hi)}</span>` : ""}
      ${t.urgency ? `<span class="badge ${esc(t.urgency)}">${esc(URGENCY[t.urgency] || t.urgency)}</span>` : ""}
      ${t.supporters > 1 ? `<span class="badge">${t.supporters} लोगों ने यही बताया</span>` : ""}
    </div>
    ${t.merged_into ? `<p class="status">आपकी शिकायत पहले से दर्ज शिकायत #${t.merged_into} से जोड़ी गई है, इसलिए उसी का हाल दिखाया जा रहा है।</p>` : ""}
    <p class="status">दर्ज हुई: ${esc(formatTime(t.created_at))}</p>
    ${progress}
    <h3>विभाग से अपडेट</h3>
    ${updates}`;
}

$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("cid").value.trim();
  if (/^\d+$/.test(id)) show(id);
  else $("status").textContent = "सिर्फ़ शिकायत संख्या (अंक) लिखें।";
});

const initial = new URLSearchParams(location.search).get("id");
if (initial && /^\d+$/.test(initial)) {
  $("cid").value = initial;
  show(initial);
}
