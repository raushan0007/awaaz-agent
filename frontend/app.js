import { Recorder } from "./recorder.js";
import {
  $, areaHtml, CATEGORY, chakraHtml, countUp, DEPARTMENTS, esc, evidenceHtml, ICON, locateHere, locateTown, mapLink,
  mountChrome, revealOnScroll,
  animateLists, celebrate, springIn, donutSvg, hoursText, takePhoto, TOUCH, LEVEL, saveTicket, shrinkPhoto, starsHtml, trendSvg, STATUS, stepperHtml, timeAgo, toast, traceHtml, URGENCY, WAVES,
  LOCALE, tt,
} from "./shared.js";

mountChrome("citizen");
$("hero").insertAdjacentHTML("afterbegin", chakraHtml());
$("hero").insertAdjacentHTML("beforeend", WAVES);

const mic = $("mic");
const meter = $("meter");
const levels = [];
let recorder = null;
let photoBlob = null;
const HIDDEN = { mobile: "मोबाइल नंबर", aadhaar: "आधार नंबर", email: "ईमेल", pan: "PAN" };

const PROBLEMS = {
  too_short: "रिकॉर्डिंग बहुत छोटी है",
  noisy: "पीछे शोर ज़्यादा है",
  unclear: "आवाज़ शोर से साफ़ अलग नहीं है",
  clipping: "आवाज़ फट रही है — माइक थोड़ा दूर रखें",
};

// Mirrored bars running saffron to green; the newest level is on the right.
function drawMeter() {
  const ctx = meter.getContext("2d");
  const { width, height } = meter;
  ctx.clearRect(0, 0, width, height);
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, "#ff9933");
  grad.addColorStop(0.5, "#f5b041");
  grad.addColorStop(1, "#138808");
  ctx.fillStyle = grad;
  const bars = 64;
  const w = width / bars;
  const recent = levels.slice(-bars);
  for (let i = 0; i < bars; i++) {
    const level = recent[i - (bars - recent.length)] ?? 0;
    const h = Math.max(4, Math.min(1, level * 4) * height);
    ctx.beginPath();
    ctx.roundRect(i * w + 2, (height - h) / 2, w - 4, h, 3);
    ctx.fill();
  }
}

async function postForm(url, form) {
  const r = await fetch(url, { method: "POST", body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
  return body;
}

// The recorder always says what to do next: idle -> recording -> busy (writing it down) -> done / error.
const MAX_SECONDS = 120;
let clock = null;

function setRec(state, title, sub) {
  $("rec").dataset.state = state;
  $("recTitle").textContent = title;
  $("recSub").textContent = sub;
  $("recTime").hidden = state !== "recording";
  $("recSub").hidden = state === "recording";
  mic.disabled = state === "busy";
  mic.setAttribute("aria-label", state === "recording" ? "रिकॉर्डिंग रोकें" : "बोलना शुरू करें");
}

function tick(started) {
  const s = Math.floor((Date.now() - started) / 1000);
  $("recClock").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

async function startRecording() {
  levels.length = 0;
  recorder = new Recorder({
    maxSeconds: MAX_SECONDS,
    onLevel: (l) => { levels.push(l); requestAnimationFrame(drawMeter); },
    onAutoStop: () => stopRecording(),
  });
  try {
    await recorder.start();
  } catch (err) {
    recorder = null;
    setRec("error", "🎙️ माइक की अनुमति दें",
      "ब्राउज़र में माइक की अनुमति देकर दोबारा दबाएँ — या नीचे लिख दीजिए।");
    $("micStatus").textContent = err.message;
    return;
  }
  const started = Date.now();
  tick(started);
  clock = setInterval(() => tick(started), 250);
  setRec("recording", "⏹ बोलना पूरा हो तो यही बटन दबाएँ", "");
  $("micStatus").textContent = "सुन रहे हैं… आराम से, साफ़ बोलिए।";
}

async function stopRecording() {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  clearInterval(clock);
  setRec("busy", "✍️ आपकी बात लिख रहे हैं…", "कुछ सेकंड लगेंगे");
  $("micStatus").textContent = "";
  try {
    const { blob, seconds } = await rec.stop();
    $("playback").src = URL.createObjectURL(blob);

    const form = new FormData();
    form.append("audio", blob, "report.wav");
    const { transcript } = await postForm("/api/transcribe", form);
    if (!transcript) {
      setRec("error", "🤔 कुछ समझ नहीं आया", "माइक दबाकर दोबारा, थोड़ा पास से और साफ़ बोलिए।");
      return;
    }
    const text = $("text");
    text.value = text.value.trim() ? `${text.value.trim()} ${transcript}` : transcript;
    text.dispatchEvent(new Event("input"));
    setRec("done", "✓ लिख लिया — नीचे जाँच लें", "कुछ और कहना हो तो 🎙️ दोबारा दबाएँ");
    $("recAfter").hidden = false;
    $("micStatus").textContent = `${seconds.toFixed(0)} सेकंड की आवाज़ लिखी गई।`;
    toast("✓ आपकी बात लिख ली गई", "ok");

    if ($("keepSample").checked) await keepSample(blob, transcript);
  } catch (err) {
    setRec("error", "⚠️ आवाज़ नहीं लिखी जा सकी", "दोबारा दबाकर कोशिश करें, या नीचे लिख दीजिए।");
    $("micStatus").textContent = err.message;
  }
}

async function keepSample(blob, transcript) {
  const form = new FormData();
  form.append("audio", blob, "sample.wav");
  form.append("transcript", transcript);
  const q = await postForm("/api/voice-samples", form);
  const box = $("sampleInfo");
  box.hidden = false;
  box.className = "sample " + (q.good ? "good" : "noisy");
  const numbers = q.snr_db == null ? "" : ` (आवाज़/शोर अंतर ${q.snr_db} dB, शोर ${q.noise_dbfs} dBFS)`;
  box.textContent = q.good
    ? `✓ साफ़ आवाज़ — वीडियो के लिए अच्छा सैंपल${numbers}। सेव: ${q.saved_as}`
    : `⚠ ${q.problems.map((p) => PROBLEMS[p] || p).join(", ")}${numbers}। सिर्फ़ टेस्ट के लिए सेव: ${q.saved_as}`;
}

async function pickPhoto(e) {
  const file = e.target.files[0];
  e.target.value = "";
  if (file) await usePhoto(file);
}

async function usePhoto(file) {
  try {
    photoBlob = await shrinkPhoto(file);
  } catch {
    photoBlob = null;
    toast("यह फ़ोटो खुल नहीं पाई। कोई दूसरी फ़ोटो चुनें।", "bad");
    return;
  }
  $("photoThumb").src = URL.createObjectURL(photoBlob);
  $("photoPreview").hidden = false;
  updateSteps();
}

function removePhoto() {
  photoBlob = null;
  $("photoPreview").hidden = true;
  updateSteps();
}

function showResult(c) {
  const d = c.decision || {};
  const dept = d.department ? d.department.name_hi : "";
  const el = $("result");
  el.hidden = false;
  el.className = `card ticket ${c.status}`;
  el.innerHTML = `
    <div class="ticket-head">
      <div><small>${esc(STATUS[c.status] || c.status)}</small><h2>${esc(tt(d) || "आपकी शिकायत")}</h2></div>
      <div class="ticket-no"><small>शिकायत संख्या</small><b>#${c.id}</b></div>
    </div>
    <div class="ticket-body">
      ${stepperHtml(c.status, c.stage)}
      <div class="badges">
        ${dept ? `<span class="badge dept">🏛️ ${esc(dept)}</span>` : ""}
        ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency] || c.urgency)}</span>` : ""}
        ${c.area ? `<span class="badge">📍 ${esc(c.area)}</span>` : ""}
        ${c.supporters > 1 ? `<span class="badge merged">👥 ${c.supporters} लोगों ने यही बताया</span>` : ""}
      </div>
      <p class="reply" translate="no">${esc(d.citizen_reply || (c.errors || []).join(" "))}</p>
      ${(c.masked || []).length ? `<p class="privacy-note">🔒 आपकी निजी जानकारी (${c.masked.map((k) => HIDDEN[k] || k).join(", ")}) छिपा दी गई है — यह किसी अधिकारी या AI को नहीं दिखेगी।</p>` : ""}
      ${evidenceHtml(c)}
      ${d.rejection_reason ? `<p class="status">कारण: ${esc(d.rejection_reason)}</p>` : ""}
      ${d.formal_letter_hi ? `<details><summary>📄 विभाग को भेजा गया पत्र</summary><div class="letter" translate="no">${esc(d.formal_letter_hi)}</div></details>` : ""}
      ${traceHtml(c.trace)}
      ${areaHtml(c.area_summary)}
      ${c.status !== "rejected" ? `<a class="track-link" href="/track.html?id=${c.id}"><span>शिकायत #${c.id} का आगे का हाल देखें</span><span>→</span></a>` : ""}
    </div>`;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function send() {
  const text = $("text").value.trim();
  if (text.length < 5) {
    toast("पहले अपनी समस्या लिखिए या बोलिए।", "bad");
    $("text").focus();
    return;
  }
  if (!$("town").value.trim()) {
    toast("अपना शहर या ज़िला लिखिए, या 📍 मेरी जगह दबाइए।", "bad");
    $("town").focus();
    return;
  }
  const btn = $("send");
  btn.disabled = true;
  $("thinking").hidden = false;
  $("thinkingText").textContent = photoBlob
    ? "AI शिकायत और फ़ोटो जाँच रहा है… (20–40 सेकंड)"
    : "AI शिकायत जाँच रहा है… (10–20 सेकंड)";
  try {
    const form = new FormData();
    form.append("text", text);
    form.append("area", $("area").value.trim());
    form.append("town", $("town").value.trim());
    if ($("mobile").value.trim()) form.append("mobile", $("mobile").value.trim());
    if (pin) {
      form.append("lat", pin.lat);
      form.append("lon", pin.lon);
      form.append("accuracy", pin.accuracy);
    }
    if (photoBlob) form.append("photo", photoBlob, "photo.jpg");
    const c = await postForm("/api/complaints", form);
    showResult(c);
    showTicket(c);
    loadPublic().catch(() => {});
    loadPlaces().catch(() => {});  // a new town shows up straight away
    toast(c.status === "rejected" ? "शिकायत स्वीकार नहीं हुई" : `✓ शिकायत #${c.id} दर्ज हुई`, c.status === "rejected" ? "bad" : "ok");
  } catch (err) {
    toast("गड़बड़ी: " + err.message, "bad");
  } finally {
    btn.disabled = false;
    $("thinking").hidden = true;
  }
}

// Department ribbon, doubled so the loop is seamless.
const chips = Object.entries(DEPARTMENTS).map(([k, d]) => `<span>${ICON[k]} ${esc(d)}</span>`).join("");
$("depts").innerHTML = chips + chips;

const EXAMPLES = [
  ["⚡ बिजली", "Hamare mohalle me 3 din se bijli nahi hai, transformer jal gaya hai"],
  ["💧 पानी", "Ward me 4 din se nal me paani nahi aa raha, log handpump se paani la rahe hain"],
  ["🛣️ सड़क", "Station road par bade gaddhe hain, kal ek auto palat gaya"],
  ["🧹 सफ़ाई", "Chowk par 10 din se kooda nahi utha, badbu aa rahi hai"],
];
$("examples").insertAdjacentHTML("beforeend", EXAMPLES.map(([label], i) =>
  `<button type="button" data-i="${i}">${label}</button>`).join(""));
$("examples").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("text").value = EXAMPLES[b.dataset.i][1];
  $("text").focus();
});

// --- live numbers, the AI replay, the ticker, department progress and the latest voices --------------

let shownOnce = false;
let place = "";  // "" = all of India

function deptCard(key, c) {
  const pct = c.total ? Math.round((100 * c.resolved) / c.total) : 0;
  const reply = c.avg_reply_hours != null ? `पहला जवाब औसतन ${hoursText(c.avg_reply_hours)} में` : "अभी कोई जवाब नहीं";
  const doing = c.in_progress ? `⏳ ${c.in_progress} पर काम जारी` : c.open ? `🕒 ${c.open} कतार में` : "✅ सब हल";
  return `<div class="dept-card ${pct >= 50 ? "good" : ""}"><div class="ic">${ICON[key] || "📋"}</div>
    <h3>${esc(CATEGORY[key] || key)}</h3><div class="num">${c.resolved}<small> / ${c.total} हल</small></div>
    <div class="bar"><i style="width:${shownOnce ? pct : 0}%" data-w="${pct}"></i></div><span class="chip">${doing}</span>
    <span class="reply">⏱️ ${reply}</span></div>`;
}

const photoOf = (r) => (r.has_photo ? `/api/complaints/${r.id}/photo` : "");
const thumb = (r, cls = "") => (r.has_photo
  ? `<img class="${cls}" src="${photoOf(r)}" alt="शिकायत की फ़ोटो" loading="lazy">`
  : `<span class="noimg ${cls}">${ICON[r.category] || "📋"}</span>`);
const stagger = (i) => `style="animation-delay:${Math.min(i, 8) * 70}ms"`;

function feedCard(r, i = 0) {
  return `<a class="feed-card pop-in ${r.has_photo ? "has-pic" : ""} ${esc(r.status === "resolved" ? "resolved" : r.urgency || "")}" ${stagger(i)} href="/track.html?id=${r.id}">
    <div><div class="meta"><span class="badges" style="margin:0">
      <span class="badge">${ICON[r.category] || "📋"} ${esc(CATEGORY[r.category] || "")}</span>
      ${r.urgency ? `<span class="badge ${esc(r.urgency)}">${esc(URGENCY[r.urgency])}</span>` : ""}
      <span class="badge ${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span></span>
      <small>${esc(timeAgo(r.created_at))}</small></div>
    <h3>${esc(tt(r) || "शिकायत #" + r.id)}</h3>
    <small>📍 ${esc(r.area || "")} · #${r.id}${r.supporters > 1 ? ` · 👥 ${r.supporters} लोगों ने बताया` : ""} · ${starsHtml(r.info_level, false)}</small></div>
    ${r.has_photo ? `<img class="thumb" src="${photoOf(r)}" alt="" loading="lazy">` : ""}</a>`;
}

function emergencyHtml(list) {
  return list.map((r, i) => `<a class="em-card pop-in" ${stagger(i)} href="/track.html?id=${r.id}">${thumb(r)}
    <span><b>${esc(tt(r) || "शिकायत #" + r.id)}</b>
    <small>📍 ${esc(r.area || "")} · ${esc(STATUS[r.status])} · ${esc(timeAgo(r.created_at))}${r.supporters > 1 ? ` · 👥 ${r.supporters} लोग` : ""}</small></span></a>`).join("");
}

// Each kind of problem: how many complaints, how many people reported them, how many are fixed.
function catBarsHtml(byCat) {
  const rows = Object.entries(byCat).sort((a, b) => b[1].reports - a[1].reports);
  const max = Math.max(1, ...rows.map(([, c]) => c.reports));
  return rows.map(([k, c]) => `<div class="cat-row"><span class="ic">${ICON[k] || "📋"}</span><div>
      <div class="top"><b>${esc(CATEGORY[k] || k)}</b><small>${c.total} शिकायतें · 👥 ${c.reports} लोग · ✅ ${c.resolved} हल</small></div>
      <div class="bars"><i class="rep" data-w="${(100 * c.reports) / max}"></i><i class="fix" data-w="${(100 * c.resolved) / max}"></i></div>
    </div></div>`).join("") +
    `<div class="cat-legend"><span><i style="background:rgba(255,154,46,.5)"></i>कितने लोगों ने बताया</span><span><i style="background:#46dc5f"></i>हल हुईं</span></div>`;
}

function mostHtml(list) {
  return list.map((r, i) => `<a class="pop-in" ${stagger(i)} href="/track.html?id=${r.id}">${thumb(r)}
    <span><b>${esc(tt(r) || "शिकायत #" + r.id)}</b><br><small class="hint">📍 ${esc(r.area || "")} · ${esc(STATUS[r.status])}</small></span>
    <span class="count">${r.supporters}<small>लोग</small></span></a>`).join("");
}

function solvedHtml(list) {
  return list.map((r, i) => `<a class="ba pop-in" ${stagger(i)} href="/track.html?id=${r.id}">
    <div class="ba-pics">
      <figure>${r.has_photo ? `<img src="${photoOf(r)}" alt="समस्या की फ़ोटो" loading="lazy">` : ICON[r.category] || "📋"}<figcaption>पहले</figcaption></figure>
      <figure class="after">${r.proof_update ? `<img src="/api/updates/${r.proof_update}/photo" alt="काम के बाद की फ़ोटो" loading="lazy">` : "✅"}<figcaption>बाद में</figcaption></figure>
    </div>
    <div class="ba-body"><b>${esc(tt(r) || "")}</b><small>✅ ${r.fix_days != null ? `${r.fix_days} दिन में हल` : "हल हुई"} · 📍 ${esc(r.area || "")}</small></div></a>`).join("");
}

let demoItems = [];
let demoIndex = 0;
let demoTimer = null;

// Replays a real routed complaint: its title types in, then the agent's routing pops out.
async function playDemo() {
  if (!demoItems.length) return;
  const r = demoItems[demoIndex % demoItems.length];
  const box = $("demo");
  box.hidden = false;
  box.classList.remove("done");
  $("demoOut").innerHTML = "";
  $("demoState").innerHTML = `✨ AI समझ रहा है <span class="dots"><i></i><i></i><i></i></span>`;
  $("demoDots").innerHTML = demoItems.map((_, i) => `<i class="${i === demoIndex % demoItems.length ? "on" : ""}"></i>`).join("");
  const text = tt(r) || "";
  for (let i = 1; i <= text.length; i++) {
    $("demoSaid").textContent = text.slice(0, i);
    await new Promise((res) => setTimeout(res, 28));
  }
  await new Promise((res) => setTimeout(res, 900));
  box.classList.add("done");
  $("demoState").textContent = "✓ AI ने वर्गीकृत किया";
  $("demoOut").innerHTML = [
    `${ICON[r.category] || "📋"} ${esc(DEPARTMENTS[r.category] || "")}`,
    r.urgency ? `${esc(URGENCY[r.urgency])}` : "",
    `📍 ${esc(r.area || "")}`,
  ].filter(Boolean).map((t, i) => `<span style="animation-delay:${i * 0.15}s">${t}</span>`).join("");
  demoIndex += 1;
  demoTimer = setTimeout(playDemo, 3800);
}

let lastPlace = null;

async function loadPublic() {
  const s = await fetch(`/api/public/stats?place=${encodeURIComponent(place)}`).then((r) => r.json());
  const n = (k) => s.by_status[k] || 0;
  const fresh = lastPlace !== place;  // a new place animates again; the 30 s refresh does not
  lastPlace = place;
  const nums = [["sHeard", s.reports], ["sProblems", s.problems], ["sOpen", n("open") + n("in_progress")],
    ["sFixed", n("resolved")], ["sDays", s.avg_days_to_fix]];
  nums.forEach(([id, v]) => {
    if (v == null) { $(id).textContent = "–"; return; }
    fresh ? countUp($(id), v) : ($(id).textContent = v);
  });
  $("tFiled").textContent = s.today.filed;
  $("tFixed").textContent = s.today.fixed;
  $("dashTitle").textContent = `📊 ${place ? place : "पूरे भारत"} का हाल`;
  $("feedTitle").textContent = `${place ? place + " की" : "देश भर की"} ताज़ा आवाज़ें`;

  $("emergency").hidden = !s.emergency.length;
  $("emList").innerHTML = emergencyHtml(s.emergency);

  if (fresh) {
    $("homeDonut").innerHTML = donutSvg(s.by_status);
    $("homeTrend").innerHTML = trendSvg(s.trend);
    $("catBars").innerHTML = catBarsHtml(s.by_category);
    requestAnimationFrame(() => setTimeout(() =>
      document.querySelectorAll("#catBars .bars i").forEach((b) => { b.style.width = b.dataset.w + "%"; }), 150));
  }
  $("mostCard").hidden = !s.most_reported.length;
  $("mostList").innerHTML = mostHtml(s.most_reported);

  $("ticker").hidden = !s.just_fixed.length;
  if (s.just_fixed.length) {
    const items = s.just_fixed.map((f) =>
      `<span>✅ #${f.id} ${esc(tt(f))} · ${esc(f.area || "")} · ${esc(timeAgo(f.fixed_at))}</span>`).join("");
    $("tickerTrack").innerHTML = items + items;
  }
  $("solvedSec").hidden = !s.solved.length;
  $("solved").innerHTML = solvedHtml(s.solved);

  const order = Object.keys(DEPARTMENTS).filter((k) => s.by_category[k]);
  $("deptGrid").innerHTML = order.map((k) => deptCard(k, s.by_category[k])).join("");
  const pct = s.problems ? Math.round((100 * n("resolved")) / s.problems) : 0;
  $("overall").innerHTML = `कुल प्रगति: <b>${n("resolved")} / ${s.problems}</b> हल (${pct}%)` +
    (s.avg_days_to_fix != null ? ` · औसत समाधान: <b>${s.avg_days_to_fix} दिन</b>` : "") +
    `<div class="bar"><i style="width:${pct}%"></i></div>`;
  $("feed").innerHTML = s.recent.map(feedCard).join("");
  requestAnimationFrame(() => setTimeout(() =>
    document.querySelectorAll("#deptGrid .bar i").forEach((b) => { b.style.width = b.dataset.w + "%"; }), 300));
  if (!shownOnce) {
    demoItems = s.recent.filter((r) => tt(r) && r.category).slice(0, 5);
    if (!demoTimer) playDemo();
  }
  shownOnce = true;
}

// --- the complaint form lives in a sheet, so the home page stays a dashboard ----------------------------

function openForm() {
  $("formSheet").hidden = false;
  document.body.classList.add("sheet-open");
  if (location.hash !== "#complain") history.pushState(null, "", "#complain");
  setTimeout(() => $("text").focus({ preventScroll: true }), 350);
}

function closeForm() {
  $("formSheet").hidden = true;
  document.body.classList.remove("sheet-open");
  if (location.hash === "#complain") history.pushState(null, "", location.pathname + location.search);
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-open-form]")) { e.preventDefault(); openForm(); }
  const nav = e.target.closest('a[href="/#complain"]');
  if (nav && location.pathname === "/") { e.preventDefault(); openForm(); }
});
$("closeForm").addEventListener("click", closeForm);
$("formSheet").addEventListener("click", (e) => { if (e.target === $("formSheet")) closeForm(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("formSheet").hidden) closeForm(); });
window.addEventListener("popstate", () => (location.hash === "#complain" ? openForm() : closeForm()));
if (location.hash === "#complain") openForm();

// --- places: all of India by default, one town on a tap, or wherever the phone is ---------------------

let knownPlaces = [];
const sameTown = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function loadPlaces() {
  knownPlaces = await fetch("/api/places").then((r) => r.json());
  $("placeList").innerHTML = knownPlaces.map((p) => `<option value="${esc(p.place)}">`).join("");
  $("townChips").innerHTML = knownPlaces.length ? `<small>पहले से जुड़ी जगहें:</small>` +
    knownPlaces.slice(0, 6).map((p) => `<button type="button" data-town="${esc(p.place)}">📍 ${esc(p.place)}</button>`).join("") : "";
  const near = $("nearMe");
  $("placeBar").innerHTML = `<button class="place${place ? "" : " on"}" type="button" data-place="">🗺️ पूरा भारत</button>` +
    knownPlaces.slice(0, 6).map((p) => `<button class="place${sameTown(p.place, place) ? " on" : ""}" type="button" data-place="${esc(p.place)}">${esc(p.place)} · ${p.reports}</button>`).join("");
  $("placeBar").append(near);
}

function showPlace(name) {
  place = name;
  document.querySelectorAll("#placeBar .place[data-place]").forEach((b) => b.classList.toggle("on", sameTown(b.dataset.place, name)));
  shownOnce = true;  // numbers just update, no count-up again
  loadPublic().catch(() => {});
}

$("placeBar").addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.id !== "nearMe") { $("placeNote").hidden = true; showPlace(b.dataset.place); return; }
  b.disabled = true;
  b.textContent = "📍 ढूँढ रहे हैं…";
  try {
    const town = await locateTown();
    if (!$("town").value.trim()) $("town").value = town;
    const known = knownPlaces.find((p) => sameTown(p.place, town));
    $("placeNote").hidden = false;
    if (known) {
      $("placeNote").textContent = `📍 आप ${town} में हैं — यहाँ की आवाज़ें दिखा रहे हैं।`;
      showPlace(known.place);
    } else {
      $("placeNote").textContent = `📍 आप ${town} में हैं। यहाँ से अभी कोई शिकायत नहीं आई — पहली आवाज़ आप उठाइए! तब तक पूरे भारत का हाल।`;
      showPlace("");
    }
  } catch (err) {
    toast(err.message, "bad");
  } finally {
    b.disabled = false;
    b.textContent = "📍 मेरे आस-पास";
  }
});

$("townChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-town]");
  if (b) { $("town").value = b.dataset.town; updateSteps(); }
});

// The exact spot: sent with the complaint for officers, never shown publicly.
let pin = null;

function showPin() {
  const box = $("pin");
  box.hidden = !pin;
  if (!pin) return;
  const weak = pin.accuracy > 100;
  box.className = `pin${weak ? " weak" : ""}`;
  // the short form people know from GPS-camera apps: drop the region digits, add the town
  const code = pin.town ? `${pin.plus.slice(4)}, ${pin.town}` : pin.plus;
  box.innerHTML = `<span>📍 सटीक जगह जुड़ी: <code>${esc(code)}</code> · ±${pin.accuracy} मी.</span>
    <a href="${mapLink(pin)}" target="_blank" rel="noopener">नक्शे पर देखें</a>
    <button type="button" class="link" id="pinRemove">हटाएँ</button>
    ${weak ? `<small style="flex-basis:100%">लोकेशन कमज़ोर है — खुली जगह में जाकर 📍 दोबारा दबाएँ, या पास का लैंडमार्क लिखें।</small>` : ""}`;
  $("pinRemove").addEventListener("click", () => { pin = null; showPin(); updateSteps(); });
}

$("locate").addEventListener("click", async () => {
  const b = $("locate");
  b.disabled = true;
  b.classList.add("locating");
  b.querySelector("b").textContent = "📡 सैटेलाइट से जगह ढूँढ रहे हैं…";
  b.querySelector("small").innerHTML = `कुछ सेकंड लगेंगे — खुली जगह में जल्दी मिलती है<span class="acc" id="accLive"></span>`;
  try {
    const here = await locateHere((acc) => {
      const el = $("accLive");
      if (el) el.textContent = `अभी की सटीकता: ±${Math.round(acc)} मी.${acc <= 20 ? " ✓" : " … और सुधार रहे हैं"}`;
    }, (acc) => {
      b.querySelector("b").textContent = `✓ जगह मिल गई (±${Math.round(acc)} मी.)`;
      const el = $("accLive");
      if (el) el.textContent = "मोहल्ले और शहर का नाम ढूँढ रहे हैं…";
    });
    pin = here;
    if (here.town) $("town").value = here.town;
    if (here.locality && !$("area").value.trim()) $("area").value = here.locality;
    showPin();
    updateSteps();
    if (!here.locality && !$("area").value.trim()) {
      $("area").focus();
      toast("📍 सटीक जगह जुड़ गई। मोहल्ले का नाम नक्शे में नहीं मिला — पास का लैंडमार्क लिख दें।", "ok");
    } else {
      toast(`📍 ${here.locality ? here.locality + ", " : ""}${here.town} · ±${here.accuracy} मी.`, "ok");
    }
  } catch (err) {
    toast(err.message + " — शहर और जगह हाथ से लिखिए।", "bad");
  } finally {
    b.disabled = false;
    b.classList.remove("locating");
    b.querySelector("b").textContent = pin ? "जगह दोबारा लें" : "मेरी सटीक जगह जोड़ें";
    b.querySelector("small").textContent = "फ़ोन की GPS से — अधिकारी ठीक उसी जगह पहुँचेंगे";
  }
});

animateLists($("feed"), $("emList"), $("mostList"));
loadPlaces().catch(() => {});
loadPublic().catch(() => {});
setInterval(() => loadPublic().catch(() => {}), 30000);
revealOnScroll();

// Samples are a local-only aid for recording the demo voice; a hosted copy keeps none.
fetch("/api/health").then((r) => r.json()).then((h) => {
  if (!h.keeps_voice_samples) {
    $("keepSample").checked = false;
    $("keepSample").closest("label").hidden = true;
  }
}).catch(() => {});

mic.addEventListener("click", () => {
  if ($("rec").dataset.state === "busy") return;
  recorder ? stopRecording() : startRecording();
});
$("redo").addEventListener("click", () => {
  $("text").value = "";
  updateSteps();
  startRecording();
});

// The four step chips tick themselves off as the form fills in.
function updateSteps() {
  // what the citizen has given so far, as the stars their report will carry
  const given = [!!$("mobile").value.trim(), !!pin, !!photoBlob];
  const level = 1 + given.filter(Boolean).length;
  const missing = [["📱 मोबाइल", given[0]], ["📍 सटीक जगह", given[1]], ["📷 फ़ोटो", given[2]]].filter(([, g]) => !g).map(([n]) => n);
  $("infoMeter").innerHTML = `<span>जानकारी: ${starsHtml(level)}</span>` +
    (missing.length ? `<small>${missing.join(", ")} जोड़ें तो और पक्की होगी — पर इसके बिना भी शिकायत दर्ज होगी।</small>` : `<small>बहुत बढ़िया — अधिकारी को पूरी जानकारी मिलेगी।</small>`);
  const done = {
    say: $("text").value.trim().length >= 5,
    where: !!$("town").value.trim(),
    photo: !!photoBlob,
    send: false,
  };
  document.querySelectorAll("#stepsMini li").forEach((li) => li.classList.toggle("done", done[li.dataset.step]));
}
["text", "town", "area", "mobile"].forEach((id) => $(id).addEventListener("input", updateSteps));

// The ticket, front and centre: big number, copy, share, track. Also kept on this phone.
function showTicket(c) {
  const d = c.decision || {};
  const id = c.duplicate_of || c.id;
  saveTicket({ id: c.id, title: tt(d) || "", at: c.created_at });
  const url = `${location.origin}/track.html?id=${c.id}`;
  const head = c.status === "rejected"
    ? ["⚠️", "शिकायत स्वीकार नहीं हुई"]
    : c.status === "merged" ? ["🤝", `पहले से दर्ज शिकायत #${id} से जोड़ी गई`] : ["✅", "आपकी शिकायत दर्ज हो गई"];
  const share = `मेरी शिकायत Awaaz पर दर्ज हुई: #${c.id} — ${tt(d) || ""}. हाल देखें: ${url}`;
  const back = document.createElement("div");
  back.className = "sheet-back";
  back.innerHTML = `<div class="sheet ${esc(c.status)}" role="dialog" aria-modal="true" aria-label="शिकायत संख्या">
    <div class="sheet-top"><div class="big-tick">${head[0]}</div><small>${esc(head[1])}</small>
      <div>शिकायत संख्या</div><div class="ticket-big">#${c.id}</div><small>यह नंबर संभालकर रखें</small></div>
    <div class="sheet-body">
      ${tt(d) ? `<b>${esc(tt(d))}</b>` : ""}
      <div class="badges" style="margin:0">
        ${d.department ? `<span class="badge dept">🏛️ ${esc(d.department.name_hi)}</span>` : ""}
        ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency])}</span>` : ""}
        <span class="badge">${starsHtml(c.info_level)}</span>
      </div>
      <div class="row3">
        <button type="button" data-act="copy"><span>📋</span>नंबर कॉपी</button>
        <a href="https://wa.me/?text=${encodeURIComponent(share)}" target="_blank" rel="noopener"><span>💬</span>WhatsApp</a>
        <a href="/track.html?id=${c.id}"><span>🔎</span>हाल देखें</a>
      </div>
      <p class="sheet-note">${c.gave_mobile ? "📱 आपके मोबाइल नंबर से आप अपनी सारी शिकायतें “हाल देखें” पेज पर कभी भी देख सकते हैं।" : "यह शिकायत इस फ़ोन में “मेरी शिकायतें” में भी सेव है।"}</p>
      <button type="button" class="send" data-act="close" style="margin-top:4px">ठीक है</button>
    </div></div>`;
  document.body.append(back);
  if (c.status !== "rejected") celebrate();
  springIn(back.querySelector(".ticket-big"));
  springIn(back.querySelector(".big-tick"), 0.2);
  const close = () => back.remove();
  back.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (e.target === back || act === "close") close();
    if (act === "copy") {
      try { await navigator.clipboard.writeText(String(c.id)); toast(`📋 #${c.id} कॉपी हो गया`, "ok"); }
      catch { toast(`शिकायत संख्या: #${c.id}`); }
    }
  });
  back.querySelector('[data-act="close"]').focus();
}
$("send").addEventListener("click", send);
$("photo").addEventListener("change", pickPhoto);
$("camera").addEventListener("change", pickPhoto);
// Phones open their own camera app; computers get a live camera in the page.
$("camBtn").addEventListener("click", async () => {
  if (TOUCH) { $("camera").click(); return; }
  const blob = await takePhoto();
  if (blob) await usePhoto(blob);
});
$("photoRemove").addEventListener("click", removePhoto);
drawMeter();
updateSteps();
