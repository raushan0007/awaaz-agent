import { Recorder } from "./recorder.js";
import {
  $, areaHtml, CATEGORY, chakraHtml, countUp, DEPARTMENTS, esc, evidenceHtml, ICON, locateHere, locateTown, mapLink,
  mountChrome, revealOnScroll,
  shrinkPhoto, STATUS, stepperHtml, timeAgo, toast, traceHtml, URGENCY, WAVES,
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

function setRecording(on) {
  mic.classList.toggle("recording", on);
  $("micWrap").classList.toggle("recording", on);
  mic.setAttribute("aria-label", on ? "रिकॉर्डिंग रोकें" : "रिकॉर्डिंग शुरू करें");
}

async function startRecording() {
  levels.length = 0;
  recorder = new Recorder({
    onLevel: (l) => { levels.push(l); requestAnimationFrame(drawMeter); },
    onAutoStop: () => stopRecording(),
  });
  try {
    await recorder.start();
  } catch (err) {
    recorder = null;
    $("micStatus").textContent = "माइक नहीं मिला या अनुमति नहीं दी गई: " + err.message;
    return;
  }
  setRecording(true);
  $("micStatus").textContent = "सुन रहे हैं… बोलकर माइक दोबारा दबाएँ।";
}

async function stopRecording() {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  setRecording(false);
  mic.disabled = true;
  $("micStatus").textContent = "आवाज़ को टेक्स्ट में बदल रहे हैं…";
  try {
    const { blob, seconds } = await rec.stop();
    $("playback").src = URL.createObjectURL(blob);
    $("playback").hidden = false;

    const form = new FormData();
    form.append("audio", blob, "report.wav");
    const { transcript } = await postForm("/api/transcribe", form);
    const text = $("text");
    text.value = text.value.trim() ? `${text.value.trim()} ${transcript}` : transcript;
    $("micStatus").textContent = transcript
      ? `${seconds.toFixed(1)} सेकंड की आवाज़ टेक्स्ट में बदली। ज़रूरत हो तो सुधार लें।`
      : "कोई शब्द समझ नहीं आए। दोबारा साफ़ बोलिए।";
    if (transcript) toast("✓ आपकी बात लिख ली गई", "ok");

    if ($("keepSample").checked) await keepSample(blob, transcript);
  } catch (err) {
    $("micStatus").textContent = "गड़बड़ी: " + err.message;
  } finally {
    mic.disabled = false;
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
  if (!file) return;
  try {
    photoBlob = await shrinkPhoto(file);
  } catch {
    photoBlob = null;
    toast("यह फ़ोटो खुल नहीं पाई। कोई दूसरी फ़ोटो चुनें।", "bad");
    return;
  }
  $("photoThumb").src = URL.createObjectURL(photoBlob);
  $("photoPreview").hidden = false;
}

function removePhoto() {
  photoBlob = null;
  $("photoPreview").hidden = true;
}

function showResult(c) {
  const d = c.decision || {};
  const dept = d.department ? d.department.name_hi : "";
  const el = $("result");
  el.hidden = false;
  el.className = `card ticket ${c.status}`;
  el.innerHTML = `
    <div class="ticket-head">
      <div><small>${esc(STATUS[c.status] || c.status)}</small><h2>${esc(d.title_hi || "आपकी शिकायत")}</h2></div>
      <div class="ticket-no"><small>शिकायत संख्या</small><b>#${c.id}</b></div>
    </div>
    <div class="ticket-body">
      ${stepperHtml(c.status)}
      <div class="badges">
        ${dept ? `<span class="badge dept">🏛️ ${esc(dept)}</span>` : ""}
        ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency] || c.urgency)}</span>` : ""}
        ${c.area ? `<span class="badge">📍 ${esc(c.area)}</span>` : ""}
        ${c.supporters > 1 ? `<span class="badge merged">👥 ${c.supporters} लोगों ने यही बताया</span>` : ""}
      </div>
      <p class="reply">${esc(d.citizen_reply || (c.errors || []).join(" "))}</p>
      ${(c.masked || []).length ? `<p class="privacy-note">🔒 आपकी निजी जानकारी (${c.masked.map((k) => HIDDEN[k] || k).join(", ")}) छिपा दी गई है — यह किसी अधिकारी या AI को नहीं दिखेगी।</p>` : ""}
      ${evidenceHtml(c)}
      ${d.rejection_reason ? `<p class="status">कारण: ${esc(d.rejection_reason)}</p>` : ""}
      ${d.formal_letter_hi ? `<details><summary>📄 विभाग को भेजा गया पत्र</summary><div class="letter">${esc(d.formal_letter_hi)}</div></details>` : ""}
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
    if (pin) {
      form.append("lat", pin.lat);
      form.append("lon", pin.lon);
      form.append("accuracy", pin.accuracy);
    }
    if (photoBlob) form.append("photo", photoBlob, "photo.jpg");
    const c = await postForm("/api/complaints", form);
    showResult(c);
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
  const doing = c.in_progress ? `⏳ ${c.in_progress} पर काम जारी` : c.open ? `🕒 ${c.open} कतार में` : "✅ सब हल";
  return `<div class="dept-card ${pct >= 50 ? "good" : ""}"><div class="ic">${ICON[key] || "📋"}</div>
    <h3>${esc(CATEGORY[key] || key)}</h3><div class="num">${c.resolved}<small> / ${c.total} हल</small></div>
    <div class="bar"><i style="width:${shownOnce ? pct : 0}%" data-w="${pct}"></i></div><span class="chip">${doing}</span></div>`;
}

function feedCard(r) {
  return `<a class="feed-card ${esc(r.status === "resolved" ? "resolved" : r.urgency || "")}" href="/track.html?id=${r.id}">
    <div class="meta"><span class="badges" style="margin:0">
      <span class="badge">${ICON[r.category] || "📋"} ${esc(CATEGORY[r.category] || "")}</span>
      ${r.urgency ? `<span class="badge ${esc(r.urgency)}">${esc(URGENCY[r.urgency])}</span>` : ""}
      <span class="badge ${esc(r.status)}">${esc(STATUS[r.status] || r.status)}</span></span>
      <small>${esc(timeAgo(r.created_at))}</small></div>
    <h3>${esc(r.title_hi || "शिकायत #" + r.id)}</h3>
    <small>📍 ${esc(r.area || "")} · #${r.id}${r.supporters > 1 ? ` · 👥 ${r.supporters} लोगों ने बताया` : ""}</small></a>`;
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
  const text = r.title_hi || "";
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

async function loadPublic() {
  const s = await fetch(`/api/public/stats?place=${encodeURIComponent(place)}`).then((r) => r.json());
  const n = (k) => s.by_status[k] || 0;
  if (!shownOnce) {
    countUp($("sHeard"), s.reports);
    countUp($("sOpen"), n("open") + n("in_progress"));
    countUp($("sFixed"), n("resolved"));
    if (s.avg_days_to_fix != null) countUp($("sDays"), s.avg_days_to_fix);
  } else {
    $("sHeard").textContent = s.reports;
    $("sOpen").textContent = n("open") + n("in_progress");
    $("sFixed").textContent = n("resolved");
    if (s.avg_days_to_fix != null) $("sDays").textContent = s.avg_days_to_fix;
  }
  $("tFiled").textContent = s.today.filed;
  $("tFixed").textContent = s.today.fixed;

  $("ticker").hidden = !s.just_fixed.length;
  if (s.just_fixed.length) {
    const items = s.just_fixed.map((f) =>
      `<span>✅ #${f.id} ${esc(f.title_hi)} · ${esc(f.area || "")} · ${esc(timeAgo(f.fixed_at))}</span>`).join("");
    $("tickerTrack").innerHTML = items + items;
  }

  const order = Object.keys(DEPARTMENTS).filter((k) => s.by_category[k]);
  $("deptGrid").innerHTML = order.map((k) => deptCard(k, s.by_category[k])).join("");
  const pct = s.problems ? Math.round((100 * n("resolved")) / s.problems) : 0;
  $("overall").innerHTML = `कुल प्रगति: <b>${n("resolved")} / ${s.problems}</b> हल (${pct}%)` +
    (s.avg_days_to_fix != null ? ` · औसत समाधान: <b>${s.avg_days_to_fix} दिन</b>` : "") +
    `<div class="bar"><i style="width:${pct}%"></i></div>`;
  $("feed").innerHTML = s.recent.map(feedCard).join("");
  if (!shownOnce) {
    // grow the progress bars once the cards are on screen
    requestAnimationFrame(() => setTimeout(() =>
      document.querySelectorAll("#deptGrid .bar i").forEach((b) => { b.style.width = b.dataset.w + "%"; }), 300));
    demoItems = s.recent.filter((r) => r.title_hi && r.category).slice(0, 5);
    if (!demoTimer) playDemo();
  }
  shownOnce = true;
}

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
  if (b) $("town").value = b.dataset.town;
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
  $("pinRemove").addEventListener("click", () => { pin = null; showPin(); });
}

$("locate").addEventListener("click", async () => {
  const b = $("locate");
  b.disabled = true;
  b.textContent = "📍 ढूँढ रहे हैं…";
  try {
    const here = await locateHere();
    pin = here;
    if (here.town) $("town").value = here.town;
    if (here.locality && !$("area").value.trim()) $("area").value = here.locality;
    showPin();
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
    b.textContent = "📍 मेरी जगह";
  }
});

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

mic.addEventListener("click", () => (recorder ? stopRecording() : startRecording()));
$("send").addEventListener("click", send);
$("photo").addEventListener("change", pickPhoto);
$("photoRemove").addEventListener("click", removePhoto);
drawMeter();
