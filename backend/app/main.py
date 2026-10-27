"""Awaaz API. Day 1: health, voice-to-text and photo evidence endpoints on the real Meta models."""

from __future__ import annotations

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from .config import BudgetExceeded, settings
from .meta_client import transcribe_wav
from .vision import segment_image

MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024

app = FastAPI(title="Awaaz", version="0.1.0")


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
    if wav[:4] != b"RIFF" or wav[8:12] != b"WAVE":
        raise HTTPException(400, "Send a WAV file (mono, 16-bit, 16 or 24 kHz).")
    return transcribe_wav(wav)


@app.post("/api/evidence")
async def evidence(photo: UploadFile = File(...), concept: str = Form(...)) -> dict:
    image = await photo.read()
    if len(image) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Photo must be under 10 MB.")
    mime = photo.content_type or "image/jpeg"
    if mime not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(400, "Photo must be JPEG, PNG or WebP.")
    concept = concept.strip()
    if not concept or len(concept) > 40:
        raise HTTPException(400, "Concept must be a short noun phrase, like 'pothole'.")
    settings.budget.ensure_room()
    result = await segment_image(image, mime, concept)
    return {**result, "found": len(result["boxes"]) > 0}
