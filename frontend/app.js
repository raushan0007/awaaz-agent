import { Recorder } from "./recorder.js";

const $ = (id) => document.getElementById(id);
const mic = $("mic");
const meter = $("meter");
const levels = [];
let recorder = null;

const PROBLEMS = {
  too_short: "रिकॉर्डिंग बहुत छोटी है",
  noisy: "पीछे शोर ज़्यादा है",
  unclear: "आवाज़ शोर से साफ़ अलग नहीं है",
  clipping: "आवाज़ फट रही है — माइक थोड़ा दूर रखें",
};
const STATUS = { open: "दर्ज हुई", merged: "पहले से दर्ज शिकायत से जोड़ी गई", rejected: "स्वीकार नहीं हुई", needs_review: "अधिकारी जाँच करेंगे" };
const URGENCY = { low: "कम ज़रूरी", medium: "सामान्य", high: "ज़रूरी", critical: "बहुत ज़रूरी" };

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function drawMeter() {
  const ctx = meter.getContext("2d");
  const { width, height } = meter;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent");
  const bars = 100;
  const w = width / bars;
  levels.slice(-bars).forEach((level, i) => {
    const h = Math.max(2, Math.min(1, level * 4) * height);
    ctx.fillRect(i * w + 1, (height - h) / 2, w - 2, h);
  });
}

async function postForm(url, form) {
  const r = await fetch(url, { method: "POST", body: form });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.detail || `HTTP ${r.status}`);
  return body;
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
  mic.classList.add("recording");
  mic.setAttribute("aria-label", "रिकॉर्डिंग रोकें");
  $("micStatus").textContent = "सुन रहे हैं… बोलकर माइक दोबारा दबाएँ।";
}

async function stopRecording() {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  mic.classList.remove("recording");
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

    if ($("keepSample").checked) await keepSample(blob, transcript);
  } catch (err) {
    $("micStatus").textContent = "गड़बड़ी: " + err.message;
  } finally {
    mic.disabled = false;
    mic.setAttribute("aria-label", "रिकॉर्डिंग शुरू करें");
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

function showResult(c) {
  const d = c.decision || {};
  const dept = d.department ? d.department.name_hi : "";
  const steps = (c.trace || []).filter((s) => s.tool).map((s) => {
    const r = s.result || {};
    let what = "";
    if (s.tool === "search_similar_complaints") what = `${(r.matches || []).length} मिलती-जुलती शिकायतें मिलीं`;
    else if (s.tool === "check_photo") what = r.error ? "फ़ोटो जाँच नहीं हो सकी" : `"${esc(r.concept)}" × ${r.instances}`;
    else if (s.tool === "submit_decision") what = r.accepted ? "जाँच में पास" : "जाँच में लौटाया: " + esc((r.errors || []).join(" "));
    return `<li><code>${esc(s.tool)}</code> — ${what}</li>`;
  });
  const el = $("result");
  el.hidden = false;
  el.innerHTML = `
    <h2>${esc(d.title_hi || "शिकायत #" + c.id)}</h2>
    <div class="badges">
      <span class="badge ${esc(c.status)}">${esc(STATUS[c.status] || c.status)}</span>
      ${dept ? `<span class="badge">${esc(dept)}</span>` : ""}
      ${c.urgency ? `<span class="badge ${esc(c.urgency)}">${esc(URGENCY[c.urgency] || c.urgency)}</span>` : ""}
      ${c.supporters > 1 ? `<span class="badge">${c.supporters} लोगों ने यही बताया</span>` : ""}
    </div>
    <p class="reply">${esc(d.citizen_reply || (c.errors || []).join(" "))}</p>
    ${d.rejection_reason ? `<p class="status">कारण: ${esc(d.rejection_reason)}</p>` : ""}
    ${d.formal_letter_hi ? `<details><summary>विभाग को भेजा गया पत्र</summary><div class="letter">${esc(d.formal_letter_hi)}</div></details>` : ""}
    ${steps.length ? `<details><summary>AI ने क्या-क्या जाँचा</summary><ol class="trace">${steps.join("")}</ol></details>` : ""}`;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function send() {
  const text = $("text").value.trim();
  if (text.length < 5) {
    $("sendStatus").textContent = "पहले अपनी समस्या लिखिए या बोलिए।";
    return;
  }
  const btn = $("send");
  btn.disabled = true;
  $("sendStatus").textContent = "AI शिकायत जाँच रहा है… (10–20 सेकंड)";
  try {
    const form = new FormData();
    form.append("text", text);
    form.append("area", $("area").value.trim());
    showResult(await postForm("/api/complaints", form));
    $("sendStatus").textContent = "";
  } catch (err) {
    $("sendStatus").textContent = "गड़बड़ी: " + err.message;
  } finally {
    btn.disabled = false;
  }
}

mic.addEventListener("click", () => (recorder ? stopRecording() : startRecording()));
$("send").addEventListener("click", send);
drawMeter();
