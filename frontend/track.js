import { $, esc, formatTime, mountChrome, STATUS, stepperHtml, URGENCY } from "./shared.js";

mountChrome("track");

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

  const updates = t.updates.length
    ? `<ul class="timeline">${t.updates.slice().reverse().map((u) =>
        `<li><time>${esc(formatTime(u.created_at))}</time><span class="badge ${esc(u.status)}">${esc(STATUS[u.status] || u.status)}</span><p>${esc(u.message_hi)}</p></li>`).join("")}</ul>`
    : `<p class="status">अभी विभाग की ओर से कोई नई जानकारी नहीं है।</p>`;

  const el = $("result");
  el.hidden = false;
  el.className = `card ticket ${t.status}`;
  el.innerHTML = `
    <div class="ticket-head">
      <div><small>${esc(STATUS[t.status] || t.status)}</small><h2>${esc(t.title_hi || "शिकायत")}</h2></div>
      <div class="ticket-no"><small>शिकायत संख्या</small><b>#${t.id}</b></div>
    </div>
    <div class="ticket-body">
      ${stepperHtml(t.status)}
      <div class="badges">
        ${t.department_hi ? `<span class="badge dept">🏛️ ${esc(t.department_hi)}</span>` : ""}
        ${t.urgency ? `<span class="badge ${esc(t.urgency)}">${esc(URGENCY[t.urgency] || t.urgency)}</span>` : ""}
        ${t.supporters > 1 ? `<span class="badge merged">👥 ${t.supporters} लोगों ने यही बताया</span>` : ""}
        <span class="badge">🗓️ ${esc(formatTime(t.created_at))}</span>
      </div>
      ${t.merged_into ? `<p class="privacy-note">आपकी शिकायत पहले से दर्ज शिकायत #${t.merged_into} से जोड़ी गई है, इसलिए उसी का हाल दिखाया जा रहा है।</p>` : ""}
      <h3 class="section-title">विभाग से अपडेट</h3>
      ${updates}
    </div>`;
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
