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

Spend guard: every model call is priced and logged per IST day; calls stop with HTTP 429 once
`AWAAZ_DAILY_BUDGET_USD` (default 3) is reached.

`python scripts/smoke_test.py sample.wav photo.jpg` hits every model once.

## Tests

```bash
python -m pytest -q backend/tests
```
