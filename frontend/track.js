import {
  $, chakraHtml, esc, formatTime, hoursText, ICON, mountChrome, myTickets, starsHtml, STATUS, stepperHtml, URGENCY, WAVES,
} from "./shared.js";

mountChrome("track");
const hero = document.querySelector(".hero");
hero.insertAdjacentHTML("afterbegin", chakraHtml());
hero.insertAdjacentHTML("beforeend", WAVES);

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

  // Every step with the time it took since filing: nothing about the handling is hidden.
  const since = (iso) => hoursText((new Date(iso) - new Date(t.filed_at)) / 36e5);
  const filed = `<li><time>${esc(formatTime(t.filed_at))}</time><span class="badge open">दर्ज हुई</span>
    <p>AI ने शिकायत ${esc(t.department_hi || "विभाग")} को भेजी।</p></li>`;
  const waitedH = (Date.now() - new Date(t.filed_at)) / 36e5;
  const noReply = !t.updates.length && ["open", "in_progress"].includes(t.status) && waitedH > 48
    ? `<p class="no-reply">⚠️ ${hoursText(waitedH)} से विभाग की ओर से कोई जवाब नहीं — यह सबको दिखता है।</p>` : "";
  const updates = `<ul class="timeline">${t.updates.slice().reverse().map((u) =>
        `<li><time>${esc(formatTime(u.created_at))}<span class="gap">दर्ज होने के ${esc(since(u.created_at))} बाद</span></time><span class="badge ${esc(u.status)}">${esc(STATUS[u.status] || u.status)}</span><p>${esc(u.message_hi)}</p>
          ${u.photo ? `<figure class="proof"><img src="/api/updates/${u.id}/photo" alt="विभाग की भेजी काम की फ़ोटो" loading="lazy"><figcaption>📷 विभाग ने काम की फ़ोटो भेजी</figcaption></figure>` : ""}</li>`).join("")}${filed}</ul>`;
  const decision = `<div class="decision">
    <span>🤖 <b>AI का फ़ैसला:</b> ${ICON[t.category] || ""} ${esc(t.department_hi || "अधिकारी जाँच करेंगे")}${t.urgency ? ` · ${esc(URGENCY[t.urgency])}` : ""}</span>
    ${t.urgency_reason ? `<span class="why-en">कारण: “${esc(t.urgency_reason)}”</span>` : ""}
    <span>📍 ${esc(t.area || "")} · ${starsHtml(t.info_level)}
      ${t.pinned ? " · 📍 सटीक जगह अधिकारी के पास" : ""}${t.has_photo ? " · 📷 फ़ोटो" : ""}${t.gave_mobile ? " · 📱 मोबाइल दिया" : ""}</span></div>`;

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
      ${decision}
      <h3 class="section-title">शिकायत का पूरा सफ़र</h3>
      ${noReply}
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

// --- the citizen's own tickets: this phone's list, or every ticket filed with their mobile number -------

function mineHtml(list) {
  return list.length ? list.map((t) => `<a href="/track.html?id=${t.id}"><span><b>#${t.id}</b> ${esc(t.title || t.title_hi || "")}</span>
    <small>${t.status ? esc(STATUS[t.status] || t.status) : esc(formatTime(t.at))}</small></a>`).join("")
    : `<p class="hint" style="margin:0">इस फ़ोन से अभी कोई शिकायत नहीं।</p>`;
}
$("mine").innerHTML = mineHtml(myTickets());

$("byMobile").addEventListener("submit", async (e) => {
  e.preventDefault();
  const r = await fetch("/api/my-complaints", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mobile: $("mob").value.trim() }),
  });
  if (!r.ok) { $("mineByMobile").innerHTML = `<p class="status">10 अंकों का सही मोबाइल नंबर डालिए।</p>`; return; }
  const list = await r.json();
  $("mineByMobile").innerHTML = list.length ? mineHtml(list) : `<p class="status">इस नंबर से कोई शिकायत नहीं मिली।</p>`;
});
