"""Awaaz API: voice-to-text, photo evidence, and complaints filed through the triage agent."""

from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pydantic import BaseModel, Field

from . import auth, status_writer
from .agent import ComplaintAgent, Report
from .audio import save_sample, voice_quality
from .config import BudgetExceeded, settings
from .departments import CATEGORIES, DEPARTMENTS
from .meta_client import transcribe_wav
from .photos import PhotoError, clean_photo
from .privacy import mask_pii
from .store import Store
from .vision import segment_image

MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024

MAX_TEXT_CHARS = 2000
PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(title="Awaaz", version="0.3.0")
_store: Store | None = None


def photos_dir() -> Path:
    return settings.data_dir / "photos"


def get_store() -> Store:
    global _store
    if _store is None:
        _store = Store(settings.data_dir / "awaaz.db")
    return _store


@app.middleware("http")
async def revalidate_pages(request, call_next):
    """Pages and scripts are not fingerprinted, so make browsers re-check them (cheap 304s via ETag)."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


@app.exception_handler(BudgetExceeded)
async def budget_exceeded(_, exc: BudgetExceeded):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=429, content={"detail": str(exc)})


STARTED_AT = datetime.now(timezone.utc).isoformat(timespec="seconds")
SECRET_NAMES = ("MODEL_API_KEY", "BASETEN_API_KEY", "AWAAZ_DEMO_OFFICER_PASSWORD")


def misnamed_secrets() -> list[str]:
    """Env names that only differ from a secret's name by case or spaces: a common hosting-dashboard slip.

    Names only, never values."""
    return sorted(name for name in os.environ
                  if name not in SECRET_NAMES and name.strip().upper() in SECRET_NAMES)


@app.get("/api/health")
def health() -> dict:
    return {
        "ok": True,
        "started_at": STARTED_AT,
        "meta_key": bool(settings.meta_api_key),
        "baseten_key": bool(settings.baseten_api_key),
        "misnamed_secrets": misnamed_secrets(),
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
    # Personal numbers never reach the model, the officers or the database.
    text, hidden_text = mask_pii(text)
    area, hidden_area = mask_pii(area)
    hidden = sorted(set(hidden_text + hidden_area))
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
        masked=hidden,
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


@app.get("/api/complaints/{complaint_id}/track")
def track_complaint(complaint_id: int) -> dict:
    """What a citizen sees: title, department and the plain-Hindi updates. No report text, no photo."""
    store = get_store()
    c = store.get(complaint_id)
    if c is None:
        raise HTTPException(404, "No such complaint.")
    # A merged report follows the complaint it was merged into.
    main_c = store.get(c["duplicate_of"]) if c["duplicate_of"] else c
    decision = main_c["decision"] or {}
    dept = DEPARTMENTS.get(main_c["category"] or "")
    return {
        "id": c["id"],
        "merged_into": c["duplicate_of"],
        "created_at": c["created_at"],
        "status": main_c["status"],
        "title_hi": decision.get("title_hi", ""),
        "department_hi": dept["name_hi"] if dept else "",
        "urgency": main_c["urgency"],
        "supporters": store.supporters(main_c["id"]),
        "updates": store.updates(main_c["id"]),
    }


# --- officers ---------------------------------------------------------------------------------------


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class StatusBody(BaseModel):
    status: Literal["in_progress", "resolved", "rejected", "open"]
    note: str = Field("", max_length=500)
    category: str | None = None  # only when routing a needs_review complaint


def current_officer(authorization: str = Header("")) -> dict:
    token = authorization.removeprefix("Bearer ").strip()
    officer = get_store().session_officer(token) if token else None
    if officer is None:
        raise HTTPException(401, "Please log in again.")
    return officer


@app.post("/api/officer/login")
def officer_login(body: LoginBody) -> dict:
    result = auth.login(get_store(), body.username.strip(), body.password)
    if result is None:
        raise HTTPException(401, "Wrong username or password.")
    token, officer = result
    return {"token": token, "officer": officer}


@app.get("/api/officer/me")
def officer_me(officer: dict = Depends(current_officer)) -> dict:
    return officer


@app.get("/api/officer/queue")
def officer_queue(officer: dict = Depends(current_officer)) -> list[dict]:
    store = get_store()
    items = store.queue(officer["department"])
    for c in items:
        c["updates"] = store.updates(c["id"])
    return items


@app.get("/api/officer/stats")
def officer_stats(officer: dict = Depends(current_officer)) -> dict:
    return get_store().stats(officer["department"])


# Which moves an officer may make from each state.
TRANSITIONS = {
    "open": {"in_progress", "resolved", "rejected"},
    "in_progress": {"resolved"},
    "needs_review": {"open", "rejected"},
}


@app.post("/api/officer/complaints/{complaint_id}/status")
def officer_set_status(complaint_id: int, body: StatusBody, officer: dict = Depends(current_officer)) -> dict:
    """Sync on purpose: FastAPI runs it in a worker thread while the open model writes the update."""
    store = get_store()
    c = store.get(complaint_id)
    if c is None:
        raise HTTPException(404, "No such complaint.")
    if not auth.can_act_on(officer, c):
        raise HTTPException(403, "This complaint belongs to another department.")
    if body.status not in TRANSITIONS.get(c["status"], set()):
        raise HTTPException(409, f"Cannot move a complaint from '{c['status']}' to '{body.status}'.")
    if body.status == "rejected" and not body.note.strip():
        raise HTTPException(400, "Give a reason when closing a complaint.")
    if c["status"] == "needs_review" and body.status == "open":
        if body.category not in CATEGORIES:
            raise HTTPException(400, "Pick the department to route this complaint to.")
        store.set_category(complaint_id, body.category)
        c = store.get(complaint_id)

    note = body.note.strip()
    message, source = status_writer.write_message(c, body.status, note)
    store.add_update(complaint_id, body.status, note, message, officer["username"])
    return {"id": complaint_id, "status": body.status, "message_hi": message, "written_by": source}


# Last, so the /api routes above win over the static files.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
