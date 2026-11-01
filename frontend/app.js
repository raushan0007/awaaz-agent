import { Recorder } from "./recorder.js";
import {
  $, areaHtml, DEPARTMENTS, esc, evidenceHtml, mountChrome, shrinkPhoto, STATUS, stepperHtml, toast, traceHtml,
  URGENCY,
} from "./shared.js";

mountChrome("citizen");

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

// Mirrored bars in the brand gradient; the newest level is on the right.
function drawMeter() {
  const ctx = meter.getContext("2d");
  const { width, height } = meter;
  ctx.clearRect(0, 0, width, height);
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0, "#ff8a3d");
  grad.addColorStop(1, "#e23d4b");
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
    form.append("town", document.querySelector('input[name="town"]:checked').value);
    if (photoBlob) form.append("photo", photoBlob, "photo.jpg");
    const c = await postForm("/api/complaints", form);
    showResult(c);
    toast(c.status === "rejected" ? "शिकायत स्वीकार नहीं हुई" : `✓ शिकायत #${c.id} दर्ज हुई`, c.status === "rejected" ? "bad" : "ok");
  } catch (err) {
    toast("गड़बड़ी: " + err.message, "bad");
  } finally {
    btn.disabled = false;
    $("thinking").hidden = true;
  }
}

// Department ribbon, doubled so the loop is seamless.
const chips = Object.values(DEPARTMENTS).map((d) => `<span>${esc(d)}</span>`).join("");
$("depts").innerHTML = chips + chips;

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
