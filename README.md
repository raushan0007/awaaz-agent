# Awaaz — civic complaints in your own voice

Built for the **Meta Global AI Developer Hackathon** (Oct 27 – Nov 4, 2026), Indie track.

> **All code in this repository was written during the hackathon week.** Nothing was carried over from earlier projects.

Citizens in small-town India report local problems (broken roads, water supply, streetlights, garbage) in Hindi, English or Hinglish, by voice, text or photo. An agent turns each report into a verified, routed, de-duplicated complaint and keeps the citizen updated in plain language.

## Meta models used

| Model | Where | What it does in Awaaz |
|---|---|---|
| Muse Spark 1.3 | Meta Model API | Reasoning, triage and routing with schema-guaranteed JSON |
| Muse Voice Transcribe | Meta Model API | Hindi/Hinglish voice reports to text |
| SAM 3.1 | Meta Model API | Checks that the photo really shows the reported problem |
| Muse Spark Open | Baseten | Open-weight model for agent steps (duplicates, citizen updates) |

## Run

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows; use .venv/bin on Linux/macOS
export MODEL_API_KEY=...      # Meta Model API
export BASETEN_API_KEY=...    # Baseten (Muse Spark Open)
uvicorn backend.app.main:app --reload
```

- `GET /api/health` — keys present, spend today vs daily limit
- `POST /api/transcribe` — `audio`: WAV (mono, 16-bit, 16/24 kHz) → transcript
- `POST /api/evidence` — `photo` + `concept` (e.g. `pothole`) → SAM boxes/masks, `found`
- `POST /api/complaints` — `text`, optional `area` and `photo` → the agent's decision and tool trace
- `GET /api/complaints`, `GET /api/complaints/{id}` — stored complaints with supporter counts
- `GET /api/complaints/{id}/photo` — the stored photo; EXIF/GPS and text metadata are stripped on upload
  (the page also re-encodes photos to a 1600 px JPEG on the phone, so GPS never leaves the device)
- `POST /api/voice-samples` — keeps a recording on this machine, scored for background noise and filed under `good/` or `noisy/` (`AWAAZ_SAMPLES_DIR`)

Open http://localhost:8000/ for the citizen page: tap the mic, speak in Hindi/English, and the
browser itself encodes 16 kHz mono WAV (`frontend/recorder.js`, no ffmpeg) for Voice Transcribe;
the transcript lands in the complaint box, ready to send to the agent.

## The complaint agent

`backend/app/agent.py` runs Muse Spark 1.3 in a tool-calling loop (Chat Completions):

1. `search_similar_complaints(area, category, keywords)`: open complaints from the last 30 days at the same place
2. `check_photo(concept)`: SAM 3.1 counts the reported problem in the citizen's photo
3. `submit_decision(...)`: valid or rejected, category, urgency, duplicate link, Hindi formal letter, reply to the citizen

The final decision is **verified in code**, not trusted. A duplicate must be an id the search
actually returned. "Photo matches" must agree with SAM's counts. The letter must be real
Devanagari Hindi. High urgency needs a stated reason. A failed check goes back to the model as the
tool result, so it can correct itself (up to 8 turns), and every step is stored as a trace
officers can read. The department comes from a fixed catalog keyed by category, so the model
cannot route to a department that does not exist.

When a photo is attached, the result page draws SAM 3.1's masks and boxes over it, so the citizen and
the officer see exactly what the model found (masks come back box-local and are translated into place).

`python scripts/agent_demo.py [photo.jpg]` runs it live on a new report, a duplicate and spam.

Spend guard: every model call is priced and logged per IST day; calls stop with HTTP 429 once
`AWAAZ_DAILY_BUDGET_USD` (default 3) is reached.

`python scripts/smoke_test.py sample.wav photo.jpg` hits every model once.

## Tests

```bash
python -m pytest -q backend/tests
```
