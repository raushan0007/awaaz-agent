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
      <a class="brand" href="/">${LOGO}<span><b>आवाज़</b><small>नागरिक शिकायत पोर्टल · भारत</small></span></a>
      <div id="headerExtra"></div>
      <nav class="pills" aria-label="पन्ने">${links(page, false)}</nav>
    </div></header>`);
  document.body.insertAdjacentHTML("beforeend", `
    <footer>
      <div class="foot-line"></div>
      <div class="brand" style="justify-content:center;margin:0">${LOGO}</div>
      <p class="jai">जय हिन्द</p>
      <p>भारत के हर नागरिक के लिए · Meta Global AI Developer Hackathon 2026</p>
      <p>🔒 आपका मोबाइल, आधार नंबर और फ़ोटो की लोकेशन किसी को नहीं दिखती।</p>
      <p class="models">MUSE SPARK · VOICE TRANSCRIBE · SAM 3.1 · MUSE SPARK OPEN</p>
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

// --- motion ------------------------------------------------------------------------------------------

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Count a number up from 0 when it is first shown. */
export function countUp(el, to, ms = 1200) {
  const decimals = String(to).includes(".") ? 1 : 0;
  if (REDUCED || !to) { el.textContent = Number(to).toFixed(decimals); return; }
  const start = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - start) / ms);
    el.textContent = (to * (1 - (1 - t) ** 3)).toFixed(decimals);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Fade sections up as they scroll into view. */
export function revealOnScroll(root = document) {
  const els = root.querySelectorAll(".reveal:not(.in)");
  if (REDUCED || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { threshold: 0.12 });
  els.forEach((e) => io.observe(e));
  // Never leave content hidden if the observer does not fire (background tabs, odd embeds).
  setTimeout(() => els.forEach((e) => e.classList.add("in")), 2000);
}

/** The Ashoka chakra with sun rays behind it; the hero turns both slowly. */
export function chakraHtml() {
  const spokes = Array.from({ length: 24 }, (_, i) => {
    const a = (i * 15 * Math.PI) / 180;
    return `<line x1="100" y1="100" x2="${(100 + 62 * Math.cos(a)).toFixed(1)}" y2="${(100 + 62 * Math.sin(a)).toFixed(1)}"/>`;
  }).join("");
  const rays = Array.from({ length: 36 }, (_, i) => {
    const a = (i * 10 * Math.PI) / 180;
    return `<line x1="${(100 + 74 * Math.cos(a)).toFixed(1)}" y1="${(100 + 74 * Math.sin(a)).toFixed(1)}" x2="${(100 + 98 * Math.cos(a)).toFixed(1)}" y2="${(100 + 98 * Math.sin(a)).toFixed(1)}"/>`;
  }).join("");
  return `<svg class="chakra-bg" viewBox="0 0 200 200" aria-hidden="true">
    <defs><radialGradient id="sun"><stop offset="0" stop-color="#ffcf8a" stop-opacity=".9"/><stop offset="1" stop-color="#ff9933" stop-opacity="0"/></radialGradient></defs>
    <circle cx="100" cy="100" r="98" fill="url(#sun)" opacity=".5"/>
    <g class="rays" stroke="#ffb35c" stroke-width="2" stroke-linecap="round" opacity=".7">${rays}</g>
    <g class="wheel" stroke="#dfe6ff" fill="none"><circle cx="100" cy="100" r="64" stroke-width="5"/><circle cx="100" cy="100" r="10" fill="#dfe6ff"/>
      <g stroke-width="2.2">${spokes}</g></g></svg>`;
}

/** Saffron, white and green waves along the bottom of the hero. */
export const WAVES = `<svg class="waves" viewBox="0 0 1200 64" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 22 C200 2 400 42 600 22 S1000 2 1240 22 V64 H0Z" fill="#ff9933" opacity=".95"/>
  <path d="M0 34 C200 16 400 52 600 34 S1000 16 1240 34 V64 H0Z" fill="#ffffff"/>
  <path d="M0 46 C200 30 400 62 600 46 S1000 30 1240 46 V64 H0Z" fill="#138808"/></svg>`;

export const ICON = { roads: "🛣️", water: "💧", electricity: "⚡", streetlight: "💡", sanitation: "🧹", drainage: "🌊", other: "📋" };

/** Open Location Code ("Plus Code") of a point, 11 digits: a cell of about 3 x 3.5 m. */
export function plusCode(lat, lon) {
  const A = "23456789CFGHJMPQRVWX";
  // whole-number arithmetic, as in the reference implementation, so cells never drift at their edges
  let la = Math.floor((Math.min(Math.max(lat, -90), 89.9999999) + 90) * 2.5e7);
  let lo = Math.floor((((lon + 180) % 360 + 360) % 360) * 8.192e6);
  // five grid digits at full precision; an 11-digit code keeps only the most significant one
  let grid = "";
  for (let i = 0; i < 5; i++) {
    grid = A[(la % 5) * 4 + (lo % 4)] + grid;
    la = Math.floor(la / 5);
    lo = Math.floor(lo / 4);
  }
  let pairs = "";
  for (let i = 0; i < 5; i++) {
    pairs = A[Math.floor(la % 20)] + A[Math.floor(lo % 20)] + pairs;
    la = Math.floor(la / 20);
    lo = Math.floor(lo / 20);
  }
  return `${pairs.slice(0, 8)}+${pairs.slice(8)}${grid[0]}`;
}

export const mapLink = (loc) => `https://www.google.com/maps?q=${loc.lat},${loc.lon}`;

/** The best GPS fix within a few seconds: stops early once it is within 20 m. */
function bestFix(ms = 9000) {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("इस फ़ोन/ब्राउज़र में लोकेशन नहीं मिलती")); return; }
    let best = null;
    const done = () => {
      navigator.geolocation.clearWatch(id);
      clearTimeout(timer);
      best ? resolve(best) : reject(new Error("लोकेशन नहीं मिल पाई — खुली जगह में दोबारा कोशिश करें"));
    };
    const id = navigator.geolocation.watchPosition((p) => {
      if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
      if (p.coords.accuracy <= 20) done();
    }, (err) => { if (!best) { navigator.geolocation.clearWatch(id); clearTimeout(timer); reject(new Error(
      err.code === 1 ? "लोकेशन की अनुमति नहीं मिली" : "लोकेशन नहीं मिल पाई")); } },
    { enableHighAccuracy: true, maximumAge: 0, timeout: ms });
    const timer = setTimeout(done, ms);
  });
}

/**
 * Where the phone is, as precisely as it can tell: the pin (kept for officers only), its Plus Code, the
 * town, and the road or neighbourhood when OpenStreetMap knows one. The coordinates go once to
 * OpenStreetMap's public reverse geocoder for the names.
 */
export async function locateHere() {
  const { coords } = await bestFix();
  const here = { lat: coords.latitude, lon: coords.longitude, accuracy: Math.round(coords.accuracy) };
  here.plus = plusCode(here.lat, here.lon);
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&accept-language=en`
      + `&lat=${here.lat.toFixed(6)}&lon=${here.lon.toFixed(6)}`;
    const a = (await (await fetch(url)).json()).address || {};
    here.town = (a.city || a.town || a.county || a.state_district || a.village || "").replace(/ (district|tahsil|subdivision)$/i, "");
    here.locality = a.neighbourhood || a.suburb || a.quarter || a.hamlet || a.road || (a.village !== here.town ? a.village : "") || "";
  } catch {
    here.town = here.town || "";
    here.locality = "";
  }
  return here;
}

export async function locateTown() {
  const here = await locateHere();
  if (!here.town) throw new Error("शहर का नाम नहीं मिला");
  return here.town;
}

export function timeAgo(iso) {
  const hours = (Date.now() - new Date(iso)) / 36e5;
  if (hours < 1) return "अभी";
  if (hours < 24) return `${Math.floor(hours)} घंटे पहले`;
  return `${Math.floor(hours / 24)} दिन पहले`;
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
