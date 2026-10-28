"""Awaaz API: voice-to-text, photo evidence, and complaints filed through the triage agent."""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .agent import ComplaintAgent, Report
from .audio import save_sample, voice_quality
from .config import BudgetExceeded, settings
from .meta_client import transcribe_wav
from .photos import PhotoError, clean_photo
from .store import Store
from .vision import segment_image

MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024

MAX_TEXT_CHARS = 2000
PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(title="Awaaz", version="0.2.0")
_store: Store | None = None


def photos_dir() -> Path:
    return settings.data_dir / "photos"


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store(settings.data_dir / "awaaz.db")
    return _store


@app.exception_handler(BudgetExceeded)
async def budget_exceeded(_, exc: BudgetExceeded):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=429, content={"detail": str(exc)})


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "meta_key": bool(settings.meta_api_key),
        "baseten_key": bool(settings.baseten_api_key),
        "spent_today_usd": round(settings.budget.spent_today(), 4),
        "daily_limit_usd": settings.budget.daily_limit_usd,
    }


@app.post("/api/transcribe")
async def transcribe(audio: UploadFile = File(...)) -> dict:
    wav = await audio.read()
    if len(wav) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio must be under 32 MB.")
    _check_wav(wav)
    return transcribe_wav(wav)


def _check_wav(wav: bytes) -> None:
    if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise HTTPException(400, "Send a WAV file (mono, 16-bit, 16 or 24 kHz).")


@app.post("/api/voice-samples")
async def voice_sample(audio: UploadFile = File(...), transcript: str = Form("")) -> dict:
    """Keep a recording on this machine, sorted into good/ or noisy/ by background noise."""
    wav = await audio.read()
    if len(wav) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "Audio must be under 32 MB.")
    _check_wav(wav)
    try:
        quality = voice_quality(wav)
    except (ValueError, EOFError) as exc:
        raise HTTPException(400, str(exc) or "Unreadable WAV.") from exc
    path = save_sample(wav, quality, settings.samples_dir, transcript.strip()[:2000])
    return {**quality, "saved_as": f"{path.parent.name}/{path.name}"}


@app.post("/api/evidence")
async def evidence(photo: UploadFile = File(...), concept: str = Form(...)) -> dict:
    image = await photo.read()
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Photo must be under 10 MB.")
    mime = photo.content_type or "image/jpeg"
    if mime not in PHOTO_TYPES:
        raise HTTPException(400, "Photo must be JPEG, PNG or WebP.")
    concept = concept.strip()
    if not concept or len(concept) > 40:
        raise HTTPException(400, "Concept must be a short noun phrase, like 'pothole'.")
    settings.budget.ensure_room()
    result = await segment_image(image, mime, concept)
    return {**result, "found": len(result["boxes"]) > 0}


@app.post("/api/complaints")
async def file_complaint(
    text: str = Form(...), area: str = Form(""), photo: UploadFile | None = File(None)
) -> dict:
    text, area = text.strip(), area.strip()
    if len(text) < 5 or len(text) > MAX_TEXT_CHARS:
        raise HTTPException(400, f"Describe the problem in 5 to {MAX_TEXT_CHARS} characters.")
    if len(area) > 80:
        raise HTTPException(400, "Area must be under 80 characters.")
    report = Report(text=text, area=area)
    photo_info = None
    if photo is not None and photo.filename:
        raw = await photo.read()
        if len(raw) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Photo must be under 10 MB.")
        mime = photo.content_type or "image/jpeg"
        try:
            # Metadata (GPS, phone model, time) goes before the photo reaches the model or the disk.
            report.photo, width, height = clean_photo(raw, mime)
        except PhotoError as exc:
            raise HTTPException(400, str(exc)) from exc
        report.photo_mime = mime
        photo_info = {"file": None, "width": width, "height": height, "ext": "png" if mime == "image/png" else "jpg"}

    store = get_store()
    result = await ComplaintAgent(store).run(report)
    d = result.decision or {}
    complaint_id = store.add(
        text=text,
        area=d.get("area") or area,
        has_photo=report.photo is not None,
        status=result.status,
        category=d.get("category") if result.status in ("open", "merged") else None,
        urgency=d.get("urgency") if result.status in ("open", "merged") else None,
        duplicate_of=d.get("duplicate_of") or None,
        decision=result.decision,
        trace=result.trace,
        evidence=result.evidence,
    )
    if photo_info:
        photos_dir().mkdir(parents=True, exist_ok=True)
        photo_info["file"] = f"{complaint_id}.{photo_info.pop('ext')}"
        (photos_dir() / photo_info["file"]).write_bytes(report.photo)
        store.set_photo(complaint_id, photo_info)
    body = store.get(complaint_id)
    body["errors"] = result.errors
    if body["duplicate_of"]:
        body["supporters"] = store.supporters(body["duplicate_of"])
    return body


@app.get("/api/complaints")
def list_complaints(status: str | None = None, limit: int = 50) -> list[dict]:
    return get_store().recent(limit=max(1, min(limit, 200)), status=status)


@app.get("/api/complaints/{complaint_id}")
def get_complaint(complaint_id: int) -> dict:
    store = get_store()
    body = store.get(complaint_id)
    if body is None:
        raise HTTPException(404, "No such complaint.")
    body["supporters"] = store.supporters(complaint_id)
    return body


@app.get("/api/complaints/{complaint_id}/photo")
def complaint_photo(complaint_id: int) -> FileResponse:
    body = get_store().get(complaint_id)
    if body is None or not body["photo"]:
        raise HTTPException(404, "No photo for this complaint.")
    return FileResponse(photos_dir() / body["photo"]["file"])


# Last, so the /api routes above win over the static files.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
