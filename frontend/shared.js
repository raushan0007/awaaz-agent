// Pieces the citizen, tracking and officer pages all use.

import { enhance } from "./enhance.js";
import { EN } from "./i18n-en.js";

export { springIn } from "./enhance.js";

// --- language: Hindi as written, or English through the dictionary in i18n-en.js ----------------------
// The pages are written in Hindi. In English mode every text node and placeholder is translated as it
// appears (including what scripts render later); anything inside translate="no" is data and left alone.

export const LANG = (() => { try { return localStorage.getItem("awaaz-lang") === "en" ? "en" : "hi"; } catch { return "hi"; } })();
export const LOCALE = LANG === "en" ? "en-IN" : "hi-IN";
const DEVA = /[\u0900-\u097F]/;
// longer phrases may also be found inside a sentence; short words only as a whole text
const PHRASES = Object.keys(EN).filter((k) => [...k].length >= 6).sort((a, b) => b.length - a.length);
// short words are replaced only as whole words ("2 लोग" -> "2 people", never inside a longer word)
const WORDS = Object.keys(EN).filter((k) => [...k].length < 6).sort((a, b) => b.length - a.length)
  .map((k) => [new RegExp("(?<![\\u0900-\\u097F])" + k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\u0900-\\u097F])", "g"), EN[k]]);

export function tr(text) {
  if (LANG !== "en" || !text || !DEVA.test(text)) return text;
  const core = text.trim();
  const lead = text.slice(0, text.indexOf(core)), trail = text.slice(text.indexOf(core) + core.length);
  if (EN[core] !== undefined) return lead + EN[core] + trail;
  let out = core;
  for (const k of PHRASES) if (out.includes(k)) out = out.split(k).join(EN[k]);
  if (DEVA.test(out)) for (const [re, en] of WORDS) out = out.replace(re, en);
  return lead + out.replace(/  +/g, " ") + trail;
}

/** A complaint's title in the chosen language (the agent writes both). */
export const tt = (o) => (LANG === "en" ? (o?.title_en || o?.title_hi || "") : (o?.title_hi || o?.title_en || ""));

const ATTRS = ["placeholder", "title", "aria-label", "alt"];
function translateTree(root) {
  if (root.nodeType === Node.TEXT_NODE) {
    if (!root.parentElement?.closest('[translate="no"], script, style')) {
      const t = tr(root.nodeValue);
      if (t !== root.nodeValue) root.nodeValue = t;
    }
    return;
  }
  if (root.nodeType !== Node.ELEMENT_NODE || root.closest('[translate="no"], script, style')) return;
  for (const el of [root, ...root.querySelectorAll("*")]) {
    if (el.closest('[translate="no"]')) continue;
    for (const a of ATTRS) if (el.hasAttribute(a)) { const v = tr(el.getAttribute(a)); if (v !== el.getAttribute(a)) el.setAttribute(a, v); }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) translateTree(n);
}

function startTranslating() {
  if (LANG !== "en") return;
  document.documentElement.lang = "en";
  document.title = tr(document.title);
  translateTree(document.body);
  new MutationObserver((muts) => muts.forEach((m) => {
    if (m.type === "characterData") translateTree(m.target);
    m.addedNodes.forEach(translateTree);
  })).observe(document.body, { childList: true, subtree: true, characterData: true });
}

function setLang(lang) {
  try { localStorage.setItem("awaaz-lang", lang); } catch { /* private mode */ }
  location.reload();
}

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
  reopened: "फिर से खोली गई",
  inspected: "मौके की जाँच हुई",
  approved: "काम मंज़ूर, टीम तय",
};

/** The work, step by step: what the officer moves forward and what the citizen watches. */
export const WORK_STAGES = [
  ["inspected", "🔍", "जाँच", "मौके की जाँच हो गई"],
  ["approved", "📋", "मंज़ूरी", "काम मंज़ूर / टीम तय"],
  ["in_progress", "🔧", "काम चालू", "काम शुरू हो गया"],
  ["resolved", "✅", "हल", "हल हो गई"],
];
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
  return new Date(iso).toLocaleString(LOCALE, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
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
  ["citizen", "/#complain", "🎙️", "शिकायत करें"],
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
      <div class="lang" role="group" aria-label="भाषा / Language" translate="no">
        <button type="button" data-lang="hi" aria-pressed="${LANG === "hi"}">हिं</button><button type="button" data-lang="en" aria-pressed="${LANG === "en"}">EN</button>
      </div>
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
  document.querySelector(".lang").addEventListener("click", (e) => {
    const b = e.target.closest("[data-lang]");
    if (b && b.dataset.lang !== LANG) setLang(b.dataset.lang);
  });
  startTranslating();
  enhance();
}

export function toast(message, tone = "") {
  const el = document.createElement("div");
  el.className = `toast ${tone}`;
  el.textContent = message;
  $("toasts").append(el);
  setTimeout(() => el.remove(), 4200);
}

// --- motion ------------------------------------------------------------------------------------------

// Two small open-source libraries, loaded on demand and never required: if the CDN is unreachable the page
// works exactly the same, just without these touches.
//   AutoAnimate (FormKit, MIT) - lists rearrange smoothly when filtered or sorted.
//   canvas-confetti (ISC) - a short burst when a problem is fixed.
const AUTO_ANIMATE = "https://cdn.jsdelivr.net/npm/@formkit/auto-animate@0.8.2/index.mjs";
const CONFETTI = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.module.mjs";

export async function animateLists(...els) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const { default: autoAnimate } = await import(AUTO_ANIMATE);
    els.filter(Boolean).forEach((el) => autoAnimate(el, { duration: 280 }));
  } catch { /* fine without it */ }
}

export async function celebrate() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  try {
    const { default: confetti } = await import(CONFETTI);
    const colors = ["#ff9933", "#ffffff", "#138808", "#0a2a8a"];
    confetti({ particleCount: 90, spread: 70, origin: { y: 0.7 }, colors });
    setTimeout(() => confetti({ particleCount: 60, spread: 100, origin: { y: 0.6 }, colors }), 250);
  } catch { /* fine without it */ }
}

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

// --- camera: the phone's own camera app on touch screens, a live in-page camera everywhere else ----------

export const TOUCH = matchMedia("(pointer: coarse)").matches;

/** Opens a live camera sheet; resolves to a JPEG Blob, or null if the citizen closes it. */
export function takePhoto() {
  return new Promise(async (resolve) => {
    let stream = null;
    let facing = "environment";
    const back = document.createElement("div");
    back.className = "cam-back";
    back.innerHTML = `<div class="cam" role="dialog" aria-modal="true" aria-label="कैमरा">
      <video autoplay playsinline muted></video>
      <p class="cam-msg">कैमरा खुल रहा है…</p>
      <div class="cam-bar">
        <button type="button" class="ghost" data-cam="close">✕ बंद करें</button>
        <button type="button" class="cam-shoot" data-cam="shoot" aria-label="फ़ोटो खींचें">📸</button>
        <button type="button" class="ghost" data-cam="flip">🔄 कैमरा बदलें</button>
      </div></div>`;
    document.body.append(back);
    const video = back.querySelector("video");
    const msg = back.querySelector(".cam-msg");
    const stop = () => stream?.getTracks().forEach((t) => t.stop());
    const finish = (blob) => { stop(); back.remove(); resolve(blob); };
    async function open() {
      stop();
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1600 } }, audio: false });
        video.srcObject = stream;
        msg.hidden = true;
      } catch {
        msg.hidden = false;
        msg.textContent = "कैमरा नहीं खुला — अनुमति दें, या गैलरी से फ़ोटो चुनें।";
      }
    }
    back.addEventListener("click", (e) => {
      const act = e.target.closest("[data-cam]")?.dataset.cam;
      if (act === "close" || e.target === back) finish(null);
      if (act === "flip") { facing = facing === "environment" ? "user" : "environment"; open(); }
      if (act === "shoot" && video.videoWidth) {
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        back.classList.add("flash");
        canvas.toBlob((blob) => setTimeout(() => finish(blob), 180), "image/jpeg", 0.9);
      }
    });
    open();
  });
}

export const mapLink = (loc) => `https://www.google.com/maps?q=${loc.lat},${loc.lon}`;

/** The best GPS fix within a few seconds: stops early once it is within 20 m. */
function bestFix(ms = 9000, onProgress) {
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
      onProgress?.(best.coords.accuracy);
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
export async function locateHere(onProgress, onNaming) {
  const { coords } = await bestFix(9000, onProgress);
  onNaming?.(coords.accuracy);
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

// --- charts drawn as SVG, with the motion in CSS ------------------------------------------------------

const SLICE_COLOURS = [
  ["open", "दर्ज, बाकी", "#7aa7ff"],
  ["in_progress", "काम चल रहा", "#ffb347"],
  ["resolved", "हल हुईं", "#46dc5f"],
];

/** Status ring: each arc grows in from zero. */
export function donutSvg(byStatus) {
  const parts = SLICE_COLOURS.map(([k, label, colour]) => [label, colour, byStatus[k] || 0]).filter(([, , v]) => v);
  const total = parts.reduce((s, [, , v]) => s + v, 0);
  if (!total) return `<p class="status">अभी कोई शिकायत नहीं।</p>`;
  const r = 52, c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = parts.map(([, colour, v], i) => {
    const len = (v / total) * c;
    const arc = `<circle class="arc" r="${r}" cx="70" cy="70" fill="none" stroke="${colour}" stroke-width="18"
      style="--len:${len.toFixed(1)};animation-delay:${i * 0.25}s" stroke-dashoffset="${(-offset).toFixed(1)}" transform="rotate(-90 70 70)"/>`;
    offset += len;
    return arc;
  }).join("");
  return `<svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${total} समस्याएँ">
      <circle r="${r}" cx="70" cy="70" fill="none" stroke="rgba(255,255,255,.07)" stroke-width="18"/>${arcs}
      <text x="70" y="72" text-anchor="middle" font-size="30" font-weight="800">${total}</text>
      <text x="70" y="92" text-anchor="middle" font-size="12" opacity=".6">समस्याएँ</text></svg>
    <ul class="legend">${parts.map(([label, colour, v]) => `<li><i style="background:${colour}"></i>${label} <b>${v}</b></li>`).join("")}</ul>`;
}

const TREND = { filed: "#ff9a2e", fixed: "#46dc5f", open: "#ffcf5c", in_progress: "#6aa8ff", resolved: "#2fae4f" };

/** One day's numbers as the tooltip lists them. */
function trendTip(d) {
  const date = new Date(d.day + "T12:00:00").toLocaleDateString(LOCALE, { weekday: "short", day: "numeric", month: "long" });
  const row = (colour, label, v) => `<li><i style="background:${colour}"></i><span>${tr(label)}</span><b>${v}</b></li>`;
  return `<b class="tip-day">${esc(date)}</b>
    <small>${tr("उस दिन")}</small><ul>${row(TREND.filed, "नई रिपोर्ट", d.filed)}${row(TREND.fixed, "हल हुईं", d.fixed)}</ul>
    <small>${tr("दिन ख़त्म होने पर")}</small><ul>${row(TREND.open, "खुली", d.open)}${row(TREND.in_progress, "काम चालू", d.in_progress)}${row(TREND.resolved, "हल", d.resolved)}</ul>`;
}

/** Two panels over the same days. Top: reports that came in and problems fixed that day, side by side so
 *  neither hides the other. Bottom: where every problem stood when the day ended (open, work on, fixed),
 *  stacked. Hover, tap or arrow-key any day for its exact numbers. Redraws itself when the card resizes. */
export function mountTrend(el, series) {
  if (!series?.length) { el.innerHTML = `<p class="status">${tr("अभी कोई आँकड़ा नहीं।")}</p>`; return; }
  const n = series.length;
  const W = Math.round(Math.min(900, Math.max(300, el.clientWidth || 640)));
  const narrow = W < 520;
  const L = 28, R = 6, gap = 38, ph = narrow ? 92 : 104, T = 30, H = T + ph + gap + ph + 22;
  const slot = (W - L - R) / n;
  const cx = (i) => L + slot * (i + 0.5);
  const scale = (top) => { const step = Math.max(1, Math.ceil(top / 3)); return { step, max: step * Math.max(1, Math.ceil(top / step)) }; };
  const a = scale(Math.max(1, ...series.map((d) => Math.max(d.filed, d.fixed))));
  const b = scale(Math.max(1, ...series.map((d) => d.open + d.in_progress + d.resolved)));
  const top1 = T, base1 = T + ph, top2 = base1 + gap, base2 = top2 + ph;
  const y1 = (v) => base1 - (v * ph) / a.max, y2 = (v) => base2 - (v * ph) / b.max;
  const bw = Math.max(2, Math.min(16, slot * 0.36)), sw = Math.max(3, Math.min(26, slot * 0.62));
  const grid = (s, y) => Array.from({ length: s.max / s.step + 1 }, (_, k) => k * s.step).map((t) =>
    `<line x1="${L}" x2="${W - R}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}"/><text x="${L - 6}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${t}</text>`).join("");
  const delay = (i) => `style="animation-delay:${(i * 0.025).toFixed(3)}s"`;
  const rect = (fill, x, y, w, h, i, round = "") =>
    `<rect class="tbar" fill="${fill}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}"${round} ${delay(i)}/>`;
  const bars = series.map((d, i) =>
    (d.filed ? rect(TREND.filed, cx(i) - bw - 1, y1(d.filed), bw, base1 - y1(d.filed), i, ' rx="2"') : "") +
    (d.fixed ? rect(TREND.fixed, cx(i) + 1, y1(d.fixed), bw, base1 - y1(d.fixed), i, ' rx="2"') : "")).join("");
  const stacks = series.map((d, i) => {
    let acc = 0;
    return ["resolved", "in_progress", "open"].map((k) => {
      if (!d[k]) return "";
      const y = y2(acc + d[k]), h = y2(acc) - y - 1;
      acc += d[k];
      return rect(TREND[k], cx(i) - sw / 2, y, sw, h, i);
    }).join("");
  }).join("");
  const every = Math.ceil(n / (narrow ? 4 : 7));
  const fmt = (d) => new Date(d.day + "T12:00:00").toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
  const labels = series.map((d, i) => (i === n - 1 || (i % every === 0 && n - 1 - i >= every * 0.6))
    ? `<text x="${cx(i).toFixed(1)}" y="${H - 5}" text-anchor="middle">${fmt(d)}</text>` : "").join("");
  const total = series.reduce((s, d) => [s[0] + d.filed, s[1] + d.fixed], [0, 0]);
  const key = (k, label, extra = "") => `<span><i style="background:${TREND[k]}"></i>${label}${extra}</span>`;
  el.classList.add("trend-chart");
  el.innerHTML = `<div class="lg">${key("filed", "नई रिपोर्ट", ` <b>${total[0]}</b>`)}${key("fixed", "हल हुईं", ` <b>${total[1]}</b>`)}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="रोज़ आई और हल हुई शिकायतें">
    <g class="grid">${grid(a, y1)}${grid(b, y2)}</g>
    <text class="panel" x="${L}" y="${top1 - 14}">हर दिन आईं और हल हुईं</text>
    <text class="panel" x="${L}" y="${top2 - 14}">दिन ख़त्म होने पर कुल स्थिति</text>
    <line class="guide" x1="0" x2="0" y1="${top1}" y2="${base2}" hidden/>
    ${bars}${stacks}${labels}
    ${series.map((d, i) => `<rect class="hit" data-i="${i}" x="${(L + slot * i).toFixed(1)}" y="${top1 - 4}" width="${slot.toFixed(1)}" height="${base2 - top1 + 8}"/>`).join("")}
    </svg>
    <div class="lg lg2">${key("open", "खुली")}${key("in_progress", "काम चालू")}${key("resolved", "हल")}</div>
    <div class="chart-tip${narrow ? " below" : ""}" role="status" hidden></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".chart-tip"), guide = el.querySelector(".guide");
  let shown = -1;
  const show = (i) => {
    if (i === shown) return;
    shown = i;
    guide.hidden = false;
    guide.setAttribute("x1", cx(i)); guide.setAttribute("x2", cx(i));
    svg.querySelectorAll(".hit.on").forEach((c) => c.classList.remove("on"));
    svg.querySelector(`.hit[data-i="${i}"]`).classList.add("on");
    tip.innerHTML = trendTip(series[i]);
    tip.hidden = false;
    if (narrow) return;  // on phones the numbers sit under the chart instead of over it
    const box = el.getBoundingClientRect(), s = svg.getBoundingClientRect();
    const px = s.left - box.left + (cx(i) / W) * s.width;
    tip.style.left = `${Math.min(Math.max(4, px + (px > box.width / 2 ? -tip.offsetWidth - 14 : 14)), box.width - tip.offsetWidth - 4)}px`;
    tip.style.top = `${s.top - box.top + 4}px`;
  };
  const hide = () => {
    if (narrow) { show(n - 1); return; }
    shown = -1; guide.hidden = true; tip.hidden = true;
    svg.querySelectorAll(".hit.on").forEach((c) => c.classList.remove("on"));
  };
  svg.addEventListener("pointermove", (e) => { const h = e.target.closest(".hit"); if (h) show(+h.dataset.i); });
  svg.addEventListener("pointerdown", (e) => { const h = e.target.closest(".hit"); if (h) show(+h.dataset.i); });
  svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); });
  svg.tabIndex = 0;
  svg.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    show(Math.min(n - 1, Math.max(0, (shown < 0 ? n : shown) + (e.key === "ArrowRight" ? 1 : -1))));
  });
  svg.addEventListener("blur", hide);
  if (narrow) show(n - 1);  // phones start with today's numbers showing
  // redraw for the new width when the card is resized (rotating a phone, a wider window)
  el._trendResize?.disconnect();
  el._trendResize = new ResizeObserver(() => {
    if (el.isConnected && Math.abs((el.clientWidth || W) - W) > 40) { el._trendResize.disconnect(); mountTrend(el, series); }
  });
  el._trendResize.observe(el);
}

// --- how complete a report is, and the citizen's own tickets on this phone ---------------------------

export const LEVEL = { 1: "कम जानकारी", 2: "थोड़ी जानकारी", 3: "अच्छी जानकारी", 4: "पूरी जानकारी" };

/** ★★★☆ — how much a report carries (mobile, exact spot, photo). Every level is accepted. */
export function starsHtml(level, withLabel = true) {
  const n = Math.max(1, Math.min(4, level || 1));
  return `<span class="stars l${n}" title="जानकारी: ${LEVEL[n]}">${"★".repeat(n)}<i>${"★".repeat(4 - n)}</i>${withLabel ? ` ${LEVEL[n]}` : ""}</span>`;
}

const MINE = "awaaz-my-tickets";

export function myTickets() {
  try { return JSON.parse(localStorage.getItem(MINE) || "[]"); } catch { return []; }
}

export function saveTicket(t) {
  try {
    const list = myTickets().filter((x) => x.id !== t.id);
    list.unshift({ id: t.id, title: t.title, at: t.at });
    localStorage.setItem(MINE, JSON.stringify(list.slice(0, 30)));
  } catch { /* private mode: the popup still shows the number */ }
}

export function hoursText(h) {
  if (h == null) return "–";
  if (h < 1) return "1 घंटे से कम";
  if (h < 48) return `${Math.round(h)} घंटे`;
  return `${Math.round(h / 24)} दिन`;
}

export function timeAgo(iso) {
  const hours = (Date.now() - new Date(iso)) / 36e5;
  if (hours < 1) return "अभी";
  if (hours < 24) return `${Math.floor(hours)} घंटे पहले`;
  return `${Math.floor(hours / 24)} दिन पहले`;
}

// --- shared renderers -----------------------------------------------------------------------------

const FLOW = ["दर्ज", "विभाग को", ...WORK_STAGES.map(([, , short]) => short)];

/** Six-step progress: filed -> with the department -> inspected -> approved -> work started -> fixed. */
export function stepperHtml(status, stage) {
  let reached;
  // steps up to the current one are done; the one after it is "now"
  if (status === "resolved") reached = FLOW.length;
  else if (status === "in_progress") reached = 3 + WORK_STAGES.findIndex(([k]) => k === (stage || "in_progress"));
  else if (status === "open" || status === "merged") reached = 2;
  if (reached === undefined) return "";
  return `<ol class="stepper six">${FLOW.map((label, i) =>
    `<li class="${i < reached ? "done" : i === reached ? "now" : ""}">${label}</li>`).join("")}</ol>`;
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
      <a href="/track.html?id=${i.id}">#${i.id}</a> <span>${esc(tt(i) || CATEGORY[i.category] || "")}</span>
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
