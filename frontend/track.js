import {
  $, animateLists, celebrate, chakraHtml, esc, formatTime, hoursText, ICON, mountChrome, myTickets, starsHtml, STATUS, trackHref,
  timeAgo, WORK_STAGES,
  stepperHtml, toast, URGENCY, WAVES,
  LOCALE, tt,
} from "./shared.js";

mountChrome("track");
const hero = document.querySelector(".hero");
hero.insertAdjacentHTML("afterbegin", chakraHtml());
hero.insertAdjacentHTML("beforeend", WAVES);

const hoursBetween = (a, b) => (new Date(b) - new Date(a)) / 36e5;

/** Where it stands, in four numbers: the step it is on, the time it has taken, the first reply, the last one. */
function summaryHtml(t) {
  const now = new Date().toISOString();
  const last = t.updates[t.updates.length - 1];
  const fixed = t.status === "resolved" && last ? last.created_at : null;
  const stage = WORK_STAGES.find(([k]) => k === (t.stage || (t.status === "resolved" ? "resolved" : "")));
  const where = t.status === "resolved" ? "✅ हल हो गई"
    : stage && t.status === "in_progress" ? `${stage[1]} ${stage[3]}`
    : t.status === "open" ? (t.updates.length ? "🕒 विभाग को मिल गई, काम बाकी" : "📨 विभाग को भेजी गई, जवाब का इंतज़ार")
    : STATUS[t.status] || t.status;
  const first = t.updates[0];
  const firstH = first ? hoursBetween(t.filed_at, first.created_at) : hoursBetween(t.filed_at, now);
  const tile = (icon, label, value, tone = "") => `<div class="sum ${tone}"><span>${icon} ${label}</span><b>${value}</b></div>`;
  return `<div class="summary4">
    ${tile("📍", "अभी कहाँ", esc(where))}
    ${tile("⏱️", fixed ? "हल होने में कुल समय" : "दर्ज हुए बीता समय", esc(hoursText(hoursBetween(t.filed_at, fixed || now))), fixed ? "good" : "")}
    ${tile("💬", "पहला जवाब कितनी देर में", first ? esc(hoursText(firstH)) : `अभी नहीं · ${esc(hoursText(firstH))}`, first ? "" : firstH > 48 ? "bad" : "warn")}
    ${tile("🕐", "आखिरी अपडेट", last ? esc(timeAgo(last.created_at)) : "—")}
  </div>`;
}

/** Every step of the department's work, in order: when it happened, how long it took after the step
 *  before, and what the department wrote. Steps still ahead are shown too, so the citizen sees what is next. */
function processHtml(t) {
  if (!["open", "in_progress", "resolved"].includes(t.status)) return "";
  // after a reopening the work starts over, so only the steps since then count
  const from = t.updates.map((u) => u.status).lastIndexOf("reopened");
  const recent = t.updates.slice(from + 1);
  const done = WORK_STAGES.map(([k]) => recent.filter((u) => u.status === k).pop());
  const lastDone = done.map(Boolean).lastIndexOf(true);
  let prev = from >= 0 ? t.updates[from].created_at : t.filed_at;
  const rows = WORK_STAGES.map(([k, icon, short, long], i) => {
    const u = done[i];
    if (u) {
      const row = `<li class="done"><span class="pi">${icon}</span><div><b>${short}</b> — ${long}
        <small>${esc(formatTime(u.created_at))} · दर्ज होने के ${esc(hoursText(hoursBetween(t.filed_at, u.created_at)))} बाद
          · पिछले कदम से ${esc(hoursText(hoursBetween(prev, u.created_at)))}</small>
        <p class="pnote" translate="no">🏛️ विभाग ने लिखा: “${esc(u.message_hi)}”</p>
        ${u.photo ? `<a class="pphoto" href="/api/updates/${u.id}/photo" target="_blank" rel="noopener">📷 काम की फ़ोटो देखें</a>` : ""}</div></li>`;
      prev = u.created_at;
      return row;
    }
    if (i < lastDone) return `<li class="skip"><span class="pi">${icon}</span><div><b>${short}</b><small>यह कदम अलग से दर्ज नहीं हुआ — विभाग सीधे अगले कदम पर गया</small></div></li>`;
    const next = i === lastDone + 1 && t.status !== "resolved";
    return `<li class="${next ? "next" : "todo"}"><span class="pi">${icon}</span><div><b>${short}</b>
      <small>${next ? `⏳ अगला कदम · पिछला कदम ${esc(hoursText(hoursBetween(prev, new Date().toISOString())))} पहले हुआ` : "बाकी"}</small></div></li>`;
  }).join("");
  return `<h3 class="section-title">🧭 विभाग का काम, कदम-दर-कदम</h3>
    <ol class="process"><li class="done"><span class="pi">📝</span><div><b>दर्ज</b> — AI ने भेजी: ${esc(t.department_hi || "विभाग")}
      <small>${esc(formatTime(t.filed_at))}</small></div></li>${rows}</ol>`;
}

// A private code (AWZ-XXXX-XXXX) opens the citizen's own report; a plain number opens the public view.
const isNumber = (key) => /^\d+$/.test(key);

let shown = null;  // {key, json} of what is on screen, so a quiet refresh redraws only on a real change

async function show(key, quiet = false) {
  if (!quiet) $("status").textContent = "ढूँढ रहे हैं…";
  const r = await fetch(isNumber(key) ? `/api/complaints/${key}/track` : `/api/track/${encodeURIComponent(key)}`);
  if (quiet) {
    if (!r.ok) return;
    const text = await r.clone().text();
    if (shown && shown.key === key && shown.json === text) return;
    if (document.activeElement?.closest("#dispute")) return;  // never redraw under someone typing
    toast("🔔 आपकी शिकायत पर नया अपडेट आया", "ok");
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    $("result").hidden = true;
    $("status").textContent = r.status !== 404 ? "अभी जानकारी नहीं मिल पाई।"
      : isNumber(key) ? "इस संख्या की कोई शिकायत नहीं मिली।" : body.detail || "यह ट्रैकिंग कोड नहीं मिला।";
    return;
  }
  const raw = await r.text();
  const t = JSON.parse(raw);
  shown = { key, json: raw };
  $("status").textContent = "";
  history.replaceState(null, "", t.mine ? `?code=${encodeURIComponent(t.code)}` : `?id=${t.id}`);

  // Every step with the time it took since filing: nothing about the handling is hidden.
  const since = (iso) => hoursText((new Date(iso) - new Date(t.filed_at)) / 36e5);
  const filed = `<li><time>${esc(formatTime(t.filed_at))}</time><span class="badge open">दर्ज हुई</span>
    <p>AI ने शिकायत ${esc(t.department_hi || "विभाग")} को भेजी।</p></li>`;
  const waitedH = (Date.now() - new Date(t.filed_at)) / 36e5;
  const noReply = !t.updates.length && ["open", "in_progress"].includes(t.status) && waitedH > 48
    ? `<p class="no-reply">⚠️ ${hoursText(waitedH)} से विभाग की ओर से कोई जवाब नहीं — यह सबको दिखता है।</p>` : "";
  const updates = `<ul class="timeline">${t.updates.slice().reverse().map((u) =>
        `<li><time>${esc(formatTime(u.created_at))}<span class="gap">दर्ज होने के ${esc(since(u.created_at))} बाद</span></time><span class="badge ${esc(u.status)}">${esc(STATUS[u.status] || u.status)}</span><p translate="no">${esc(u.message_hi)}</p>
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
      <div><small>${esc(STATUS[t.status] || t.status)}</small><h2>${esc(tt(t) || "शिकायत")}</h2></div>
      <div class="ticket-no"><small>शिकायत संख्या</small><b>#${t.id}</b></div>
    </div>
    <div class="ticket-body">
      ${stepperHtml(t.status, t.stage)}
      ${summaryHtml(t)}
      <div class="badges">
        ${t.department_hi ? `<span class="badge dept">🏛️ ${esc(t.department_hi)}</span>` : ""}
        ${t.urgency ? `<span class="badge ${esc(t.urgency)}">${esc(URGENCY[t.urgency] || t.urgency)}</span>` : ""}
        ${t.supporters > 1 ? `<span class="badge merged">👥 ${t.supporters} लोगों ने यही बताया</span>` : ""}
        <span class="badge">🗓️ ${esc(formatTime(t.created_at))}</span>
      </div>
      ${t.mine ? `<p class="mine-note">🔐 यह आपकी अपनी शिकायत है · कोड <b translate="no">${esc(t.code)}</b></p>`
        : `<p class="hint public-note">👁️ यह सबके लिए खुला हाल है। अपनी शिकायत के लिए अपना ट्रैकिंग कोड डालें।</p>`}
      ${t.merged_into ? `<p class="privacy-note">आपकी शिकायत पहले से दर्ज शिकायत #${t.merged_into} से जोड़ी गई है, इसलिए उसी का हाल दिखाया जा रहा है।</p>` : ""}
      ${t.has_photo ? `<figure class="proof" style="margin-bottom:12px"><img src="/api/complaints/${t.id}/photo" alt="शिकायत की फ़ोटो" loading="lazy"><figcaption style="color:var(--text-2)">📷 नागरिक की भेजी फ़ोटो</figcaption></figure>` : ""}
      ${decision}
      ${processHtml(t)}
      <h3 class="section-title">📜 शिकायत का पूरा सफ़र (हर अपडेट)</h3>
      ${noReply}
      ${updates}
      ${t.status === "resolved" ? `<form class="dispute" id="dispute">
        <h3>❌ अभी हल नहीं हुआ?</h3>
        <p class="hint" style="margin:0 0 8px">${t.mine
          ? "अगर समस्या अब भी है, तो नीचे बटन दबाइए — शिकायत फिर से खुल जाएगी और विभाग को दोबारा जाएगी।"
          : "अगर समस्या अब भी है, तो अपना ट्रैकिंग कोड खोलें, या वही मोबाइल नंबर डालिए जो शिकायत में दिया था — शिकायत फिर से खुल जाएगी।"}</p>
        ${t.mine ? "" : `<input id="dMobile" type="tel" inputmode="numeric" maxlength="14" placeholder="शिकायत वाला मोबाइल नंबर" required>`}
        <textarea id="dNote" rows="2" maxlength="500" placeholder="क्या अब भी गड़बड़ है? (ज़रूरी नहीं)" style="margin-top:8px"></textarea>
        <button class="send" type="submit" style="margin-top:10px">↩️ शिकायत फिर से खोलें</button>
        <p class="status" id="dMsg"></p>
      </form>` : ""}
    </div>`;
  animateLists(el.querySelector(".timeline"));
  // a fixed problem is worth a moment of celebration, once per ticket on this phone
  try {
    if (t.status === "resolved" && !sessionStorage.getItem(`awaaz-cheer-${t.id}`)) {
      sessionStorage.setItem(`awaaz-cheer-${t.id}`, "1");
      celebrate();
    }
  } catch { /* private mode */ }
  $("dispute")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    $("dMsg").textContent = "जाँच रहे हैं…";
    const r = await fetch(`/api/complaints/${t.id}/dispute`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t.mine ? { code: t.code, note: $("dNote").value.trim() }
        : { mobile: $("dMobile").value.trim(), note: $("dNote").value.trim() }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok) { show(t.mine ? t.code : String(t.id)); return; }
    $("dMsg").textContent = r.status === 403
      ? "यह नंबर इस शिकायत से नहीं जुड़ा। बिना नंबर वाली शिकायत के लिए नई शिकायत दर्ज करें — वह इसी से जुड़ जाएगी।"
      : body.detail || "अभी नहीं हो पाया।";
  });
}

$("lookup").addEventListener("submit", (e) => {
  e.preventDefault();
  const key = $("cid").value.trim().replace(/^#/, "");
  if (isNumber(key) || key.replace(/[^0-9a-z]/gi, "").length >= 8) show(key);
  else $("status").textContent = "ट्रैकिंग कोड (जैसे AWZ-7K3M-Q2XP) या शिकायत संख्या लिखें।";
});

// While the work is open, look again every 20 seconds: a new step appears without reloading the page.
setInterval(() => {
  if (!shown || document.hidden || !$("result") || $("result").hidden) return;
  if (/^card ticket (resolved|rejected)/.test($("result").className)) return;
  show(shown.key, true).catch(() => {});
}, 20000);

const params = new URLSearchParams(location.search);
const initial = params.get("code") || (isNumber(params.get("id") || "") ? params.get("id") : "");
if (initial) {
  $("cid").value = initial;
  show(initial);
}

// --- the citizen's own tickets: this phone's list, or every ticket filed with their mobile number -------

function mineHtml(list) {
  return list.length ? list.map((t) => `<a href="${trackHref(t)}"><span><b>#${t.id}</b> <span translate="no">${esc(t.title || tt(t) || "")}</span>${t.code ? ` <small translate="no">🔐 ${esc(t.code)}</small>` : ""}</span>
    <small>${t.status ? esc(STATUS[t.status] || t.status) : esc(formatTime(t.at))}</small></a>`).join("")
    : `<p class="hint" style="margin:0">इस फ़ोन से अभी कोई शिकायत नहीं।</p>`;
}
animateLists($("mine"), $("mineByMobile"));
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
