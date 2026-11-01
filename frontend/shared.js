// Pieces the citizen, tracking and officer pages all use.

export const $ = (id) => document.getElementById(id);

export const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export const STATUS = {
  open: "दर्ज हुई",
  in_progress: "काम चल रहा है",
  resolved: "हल हो गई",
  merged: "पहले से दर्ज शिकायत से जोड़ी गई",
  rejected: "स्वीकार नहीं हुई",
  needs_review: "अधिकारी जाँच करेंगे",
};
export const URGENCY = { low: "कम ज़रूरी", medium: "सामान्य", high: "ज़रूरी", critical: "बहुत ज़रूरी" };

export const CATEGORY = {
  roads: "सड़क", water: "पानी", electricity: "बिजली", streetlight: "स्ट्रीट लाइट",
  sanitation: "सफ़ाई", drainage: "नाला", other: "अन्य",
};

export const DEPARTMENTS = {
  roads: "सड़क एवं निर्माण विभाग",
  water: "पेयजल एवं स्वच्छता विभाग (PHED)",
  electricity: "बिजली वितरण विभाग",
  streetlight: "नगर परिषद – स्ट्रीट लाइट",
  sanitation: "नगर परिषद – सफ़ाई विभाग",
  drainage: "नाला एवं जल-निकासी विभाग",
  other: "लोक शिकायत प्रकोष्ठ",
};

export function formatTime(iso) {
  return new Date(iso).toLocaleString("hi-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
}

const MAX_PHOTO_SIDE = 1600;

// Re-encoding through a canvas shrinks phone photos (5 MB -> ~300 KB) and drops EXIF/GPS on the device.
export async function shrinkPhoto(file) {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

// --- page chrome --------------------------------------------------------------------------------

const LOGO = `<svg viewBox="0 0 48 48" aria-hidden="true">
  <rect width="48" height="48" rx="13" fill="#fff" stroke="#e6e1d6"/>
  <g stroke="#0a2a8a" fill="none"><circle cx="24" cy="24" r="9.5" stroke-width="2.2"/><g stroke-width="0.8"><line x1="24" y1="24" x2="33.50" y2="24.00"/><line x1="24" y1="24" x2="33.18" y2="26.46"/><line x1="24" y1="24" x2="32.23" y2="28.75"/><line x1="24" y1="24" x2="30.72" y2="30.72"/><line x1="24" y1="24" x2="28.75" y2="32.23"/><line x1="24" y1="24" x2="26.46" y2="33.18"/><line x1="24" y1="24" x2="24.00" y2="33.50"/><line x1="24" y1="24" x2="21.54" y2="33.18"/><line x1="24" y1="24" x2="19.25" y2="32.23"/><line x1="24" y1="24" x2="17.28" y2="30.72"/><line x1="24" y1="24" x2="15.77" y2="28.75"/><line x1="24" y1="24" x2="14.82" y2="26.46"/><line x1="24" y1="24" x2="14.50" y2="24.00"/><line x1="24" y1="24" x2="14.82" y2="21.54"/><line x1="24" y1="24" x2="15.77" y2="19.25"/><line x1="24" y1="24" x2="17.28" y2="17.28"/><line x1="24" y1="24" x2="19.25" y2="15.77"/><line x1="24" y1="24" x2="21.54" y2="14.82"/><line x1="24" y1="24" x2="24.00" y2="14.50"/><line x1="24" y1="24" x2="26.46" y2="14.82"/><line x1="24" y1="24" x2="28.75" y2="15.77"/><line x1="24" y1="24" x2="30.72" y2="17.28"/><line x1="24" y1="24" x2="32.23" y2="19.25"/><line x1="24" y1="24" x2="33.18" y2="21.54"/></g></g><circle cx="24" cy="24" r="2.2" fill="#0a2a8a"/>
  <g fill="none" stroke-linecap="round" stroke-width="2.6">
    <path d="M10 18a10 10 0 0 0 0 12" stroke="#ff9933"/><path d="M5.5 14.5a15 15 0 0 0 0 19" stroke="#ff9933"/>
    <path d="M38 18a10 10 0 0 1 0 12" stroke="#138808"/><path d="M42.5 14.5a15 15 0 0 1 0 19" stroke="#138808"/></g></svg>`;

const PAGES = [
  ["citizen", "/", "🎙️", "शिकायत करें"],
  ["track", "/track.html", "🔎", "हाल देखें"],
  ["officer", "/officer.html", "🏛️", "अधिकारी"],
];

const links = (page, withIcons) => PAGES.map(([key, href, icon, label]) =>
  `<a href="${href}"${key === page ? ' aria-current="page"' : ""}>${withIcons ? `<span>${icon}</span>` : ""}${label}</a>`).join("");

/** Saffron-to-green top line, sticky header with page pills, footer, phone bottom nav and the toast shelf. */
export function mountChrome(page) {
  document.body.insertAdjacentHTML("afterbegin", `
    <div class="topline" aria-hidden="true"></div>
    <header class="top"><div class="top-in">
      <a class="brand" href="/">${LOGO}<span><b>आवाज़</b><small>Awaaz · सुपौल · फारबिसगंज</small></span></a>
      <div id="headerExtra"></div>
      <nav class="pills" aria-label="पन्ने">${links(page, false)}</nav>
    </div></header>`);
  document.body.insertAdjacentHTML("beforeend", `
    <footer>
      <p>🔒 आपका मोबाइल, आधार नंबर और फ़ोटो की लोकेशन किसी को नहीं दिखती।</p>
      <p class="models">Muse Spark · Muse Voice Transcribe · SAM 3.1 · Muse Spark Open</p>
      <p>Meta Global AI Hackathon 2026 · जय हिंद</p>
    </footer>
    <nav class="bottom-nav" aria-label="पन्ने">${links(page, true)}</nav>
    <div class="toasts" id="toasts" role="status" aria-live="polite"></div>`);
}

export function toast(message, tone = "") {
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

// --- shared renderers -----------------------------------------------------------------------------

const FLOW = [["open", "दर्ज"], ["routed", "विभाग को"], ["in_progress", "काम चालू"], ["resolved", "हल"]];

/** Four-step progress: filed -> with the department -> work started -> fixed. */
export function stepperHtml(status) {
  const reached = { open: 1, merged: 1, in_progress: 2, resolved: 3 }[status];
  if (reached === undefined) return "";
  return `<ol class="stepper">${FLOW.map(([, label], i) =>
    `<li class="${i < reached || status === "resolved" ? "done" : i === reached ? "now" : ""}">${label}</li>`).join("")}</ol>`;
}

// SAM 3.1 boxes are in image pixels; each mask is box-sized with a box-local path, so translate it into place.
export function evidenceHtml(c) {
  if (!c.photo) return "";
  const { width, height } = c.photo;
  const ev = c.evidence;
  const shapes = ev
    ? ev.masks.map((m) => {
        const box = ev.boxes.find((b) => b.id === m.id);
        return box ? `<path class="mask" transform="translate(${box.left} ${box.top})" d="${esc(m.path)}"/>` : "";
      }).join("") +
      ev.boxes.map((b) => `<rect class="box" x="${b.left}" y="${b.top}" width="${b.right - b.left}" height="${b.bottom - b.top}" rx="6"/>`).join("")
    : "";
  const matches = (c.decision || {}).photo_matches;
  const note = ev
    ? `<p class="evidence-note ok">✓ SAM 3.1 ने फ़ोटो में "${esc(ev.concept)}" ${ev.boxes.length} जगह पहचाना</p>`
    : `<p class="evidence-note warn">⚠ ${matches === "unverified" ? "फ़ोटो की जाँच अभी नहीं हो सकी" : "फ़ोटो में बताई गई समस्या साफ़ नहीं दिखी"}</p>`;
  return `<div class="evidence"><img src="/api/complaints/${c.id}/photo" alt="शिकायत की फ़ोटो" loading="lazy">
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">${shapes}</svg></div>${note}`;
}

// The agent's tool calls, in words: the "why" behind each decision.
export function traceHtml(trace) {
  const steps = (trace || []).filter((s) => s.tool).map((s) => {
    const r = s.result || {};
    let what = "";
    let bounced = false;
    if (s.tool === "search_similar_complaints") what = `${(r.matches || []).length} मिलती-जुलती शिकायतें मिलीं`;
    else if (s.tool === "check_photo") what = r.error ? "फ़ोटो जाँच नहीं हो सकी" : `"${esc(r.concept)}" × ${r.instances}`;
    else if (s.tool === "submit_decision") {
      bounced = !r.accepted;
      what = r.accepted ? "कोड की जाँच में पास" : "कोड ने लौटाया: " + esc((r.errors || []).join(" "));
    }
    return `<li${bounced ? ' class="bounced"' : ""}><span><code>${esc(s.tool)}</code> — ${what}</span></li>`;
  });
  return steps.length ? `<details><summary>🤖 AI ने क्या-क्या जाँचा</summary><ol class="trace">${steps.join("")}</ol></details>` : "";
}

// The whole picture of one place: every problem reported there and where each one stands.
export function areaHtml(s) {
  if (!s || !s.problems) return "";
  const n = (k) => s.by_status[k] || 0;
  const cats = Object.entries(s.by_category)
    .map(([k, v]) => `<span class="badge">${esc(CATEGORY[k] || k)}: ${v}</span>`).join("");
  const items = s.items.map((i) => `<li>
      <a href="/track.html?id=${i.id}">#${i.id}</a> <span>${esc(i.title_hi || CATEGORY[i.category] || "")}</span>
      <span class="badge ${esc(i.status)}">${esc(STATUS[i.status] || i.status)}</span>
      ${i.supporters > 1 ? `<small>👥 ${i.supporters} लोगों ने बताया</small>` : ""}
      <small>${formatTime(i.created_at)}</small></li>`).join("");
  return `<section class="area-summary">
    <h3>📍 ${esc(s.area)}</h3>
    <p>इस जगह का पूरा हाल — ${s.problems} समस्याएँ, ${s.reports} रिपोर्ट</p>
    <div class="area-nums">
      <div><b>${n("open")}</b><span>बाकी</span></div>
      <div><b>${n("in_progress")}</b><span>काम चालू</span></div>
      <div><b>${n("resolved")}</b><span>हल हुईं</span></div>
    </div>
    <div class="badges">${cats}</div>
    <ul class="area-list">${items}</ul>
  </section>`;
}
