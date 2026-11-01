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

export function formatTime(iso) {
  return new Date(iso).toLocaleString("hi-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
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
    if (s.tool === "search_similar_complaints") what = `${(r.matches || []).length} मिलती-जुलती शिकायतें मिलीं`;
    else if (s.tool === "check_photo") what = r.error ? "फ़ोटो जाँच नहीं हो सकी" : `"${esc(r.concept)}" × ${r.instances}`;
    else if (s.tool === "submit_decision") what = r.accepted ? "जाँच में पास" : "जाँच में लौटाया: " + esc((r.errors || []).join(" "));
    return `<li><code>${esc(s.tool)}</code> — ${what}</li>`;
  });
  return steps.length ? `<details><summary>AI ने क्या-क्या जाँचा</summary><ol class="trace">${steps.join("")}</ol></details>` : "";
}

export const CATEGORY = {
  roads: "सड़क", water: "पानी", electricity: "बिजली", streetlight: "स्ट्रीट लाइट",
  sanitation: "सफ़ाई", drainage: "नाला", other: "अन्य",
};

// The whole picture of one place: every problem reported there and where each one stands.
export function areaHtml(s) {
  if (!s || !s.problems) return "";
  const n = (k) => s.by_status[k] || 0;
  const cats = Object.entries(s.by_category)
    .map(([k, v]) => `<span class="badge">${esc(CATEGORY[k] || k)}: ${v}</span>`).join("");
  const items = s.items.map((i) => `<li>
      <a href="/track.html?id=${i.id}">#${i.id}</a> ${esc(i.title_hi || CATEGORY[i.category] || "")}
      <span class="badge ${esc(i.status)}">${esc(STATUS[i.status] || i.status)}</span>
      ${i.supporters > 1 ? `<small>${i.supporters} लोगों ने बताया</small>` : ""}
      <small>${formatTime(i.created_at)}</small></li>`).join("");
  return `<section class="area-summary">
    <h3>📍 ${esc(s.area)} — इस जगह का पूरा हाल</h3>
    <p>${s.problems} समस्याएँ, ${s.reports} रिपोर्ट · ${n("open") + n("in_progress")} बाकी
      (${n("in_progress")} पर काम चल रहा) · ${n("resolved")} हल हुईं</p>
    <div class="badges">${cats}</div>
    <ul>${items}</ul>
  </section>`;
}
