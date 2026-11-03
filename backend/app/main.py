"""Awaaz API: voice-to-text, photo evidence, and complaints filed through the triage agent."""

from __future__ import annotations

import csv
import io
import os
from datetime import datetime, timezone
from pathlib import Path

from typing import Literal

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles

from pydantic import BaseModel, Field

from . import auth, moderation, status_writer
from .agent import ComplaintAgent, Report
from .audio import save_sample, voice_quality
from .config import BudgetExceeded, settings
from .departments import CATEGORIES, DEPARTMENTS, MAX_TOWN_CHARS
from .meta_client import transcribe_wav
from .photos import PhotoError, clean_photo
from .privacy import contact_hash, mask_pii, normalize_mobile
from .store import ALL_DEPARTMENTS, REVIEW, Store, normalize_code
from .vision import segment_image

MAX_AUDIO_BYTES = 32 * 1024 * 1024
MAX_IMAGE_BYTES = 10 * 1024 * 1024

MAX_TEXT_CHARS = 2000
PHOTO_TYPES = {"image/jpeg", "image/png", "image/webp"}
FRONTEND_DIR = Path(__file__).resolve().parents[2] / "frontend"

app = FastAPI(title="Awaaz", version="0.3.0")
app.add_middleware(GZipMiddleware, minimum_size=800)  # JSON and scripts shrink to a third on slow phone data
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
        "keeps_voice_samples": settings.samples_dir is not None,
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
    if settings.samples_dir is None:
        raise HTTPException(404, "Voice samples are not kept on this server.")
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
    text: str = Form(...), area: str = Form(""), town: str = Form(""),
    photo: UploadFile | None = File(None),
    lat: float | None = Form(None), lon: float | None = Form(None), accuracy: float | None = Form(None),
    mobile: str = Form(""),
) -> dict:
    text, area = text.strip(), area.strip()
    town = " ".join(town.split())
    if not town or len(town) > MAX_TOWN_CHARS or not any(ch.isalpha() for ch in town):
        raise HTTPException(400, f"Name the town or district (up to {MAX_TOWN_CHARS} characters).")
    if len(text) < 5 or len(text) > MAX_TEXT_CHARS:
        raise HTTPException(400, f"Describe the problem in 5 to {MAX_TEXT_CHARS} characters.")
    if len(area) > 80:
        raise HTTPException(400, "Area must be under 80 characters.")
    # Personal numbers never reach the model, the officers or the database.
    text, hidden_text = mask_pii(text)
    area, hidden_area = mask_pii(area)
    hidden = sorted(set(hidden_text + hidden_area))
    location = None
    if lat is not None or lon is not None:
        # Roughly India's bounding box; a pin outside it is a typo or a spoof, not a civic problem here.
        if lat is None or lon is None or not (6 <= lat <= 37.6 and 68 <= lon <= 97.5):
            raise HTTPException(400, "The location must be a point in India.")
        if accuracy is not None and not 0 <= accuracy <= 5000:
            raise HTTPException(400, "Location accuracy must be 0 to 5000 metres.")
        location = {"lat": round(lat, 6), "lon": round(lon, 6),
                    "accuracy": round(accuracy) if accuracy is not None else None}
    contact = None
    if mobile.strip():
        number = normalize_mobile(mobile)
        if number is None:
            raise HTTPException(400, "Give a 10-digit Indian mobile number, or leave it empty.")
        contact = contact_hash(number, settings.contact_salt)  # only the fingerprint is kept
    report = Report(text=text, area=area, town=town, location=location)
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

    # Photos are public, so nothing sexual, gory or hateful may be stored; the check fails closed for photos.
    photo_note = None
    try:
        verdict = await moderation.screen(text, area, town, report.photo, report.photo_mime)
    except BudgetExceeded:
        raise
    except Exception:
        verdict = None  # the text still goes through the agent, which rejects abuse; the photo is dropped
    if verdict is not None and not verdict["text_safe"]:
        raise HTTPException(422, moderation.TEXT_BLOCKED_HI)  # nothing is stored
    if report.photo is not None and (verdict is None or not verdict["photo_safe"]):
        photo_note = moderation.PHOTO_UNCHECKED_HI if verdict is None else moderation.PHOTO_BLOCKED_HI
        report.photo, photo_info = None, None

    store = get_store()
    result = await ComplaintAgent(store).run(report)
    d = result.decision or {}
    complaint_id = store.add(
        text=text,
        area=d.get("area") or area,
        has_photo=report.photo is not None and result.status != "rejected",
        status=result.status,
        category=d.get("category") if result.status in ("open", "merged") else None,
        urgency=d.get("urgency") if result.status in ("open", "merged") else None,
        duplicate_of=d.get("duplicate_of") or None,
        decision=result.decision,
        trace=result.trace,
        evidence=result.evidence,
        masked=hidden,
        location=location,
        contact=contact,
    )
    if photo_info and result.status != "rejected":  # a rejected report's photo is never kept
        photos_dir().mkdir(parents=True, exist_ok=True)
        photo_info["file"] = f"{complaint_id}.{photo_info.pop('ext')}"
        (photos_dir() / photo_info["file"]).write_bytes(report.photo)
        store.set_photo(complaint_id, photo_info)
    body = store.get(complaint_id)
    body["code"] = store.code_of(complaint_id)  # the citizen's private tracking code: shown once, here
    body["errors"] = result.errors
    body["photo_note"] = photo_note
    if body["duplicate_of"]:
        body["supporters"] = store.supporters(body["duplicate_of"])
    # The citizen sees the whole picture of their place, not just their own ticket.
    body["area_summary"] = store.area_summary(body["area"]) if body["area"] else None
    return body


@app.get("/api/areas/summary")
def area_summary(area: str) -> dict:
    if not area.strip() or len(area) > 80:
        raise HTTPException(400, "Give an area under 80 characters.")
    return get_store().area_summary(area.strip())


@app.get("/api/complaints")
def list_complaints(status: str | None = None, limit: int = 50) -> list[dict]:
    return [_public(c) for c in get_store().recent(limit=max(1, min(limit, 200)), status=status)]


def _public(c: dict) -> dict:
    """A complaint as anyone may see it: never the citizen's exact position."""
    return {k: v for k, v in c.items() if k != "location"}


@app.get("/api/complaints/{complaint_id}")
def get_complaint(complaint_id: int) -> dict:
    store = get_store()
    body = store.get(complaint_id)
    if body is None:
        raise HTTPException(404, "No such complaint.")
    body["supporters"] = store.supporters(complaint_id)
    return _public(body)


@app.get("/api/complaints/{complaint_id}/photo")
def complaint_photo(complaint_id: int) -> FileResponse:
    body = get_store().get(complaint_id)
    if body is None or not body["photo"] or body["status"] == "rejected":
        raise HTTPException(404, "No photo for this complaint.")
    return FileResponse(photos_dir() / body["photo"]["file"])


@app.get("/api/complaints/{complaint_id}/track")
def track_complaint(complaint_id: int) -> dict:
    """The public view of one problem by its number: title, department and the plain-Hindi updates.
    No report text, no photo, and no citizen-only actions (those need the private code)."""
    c = get_store().get(complaint_id)
    if c is None:
        raise HTTPException(404, "No such complaint.")
    return {**_track(c), "mine": False}


@app.get("/api/track/{code}")
def track_by_code(code: str) -> dict:
    """A citizen's own report, by the private code they were given when filing it."""
    c = get_store().by_code(code)
    if c is None:
        raise HTTPException(404, "यह ट्रैकिंग कोड नहीं मिला। कोड दोबारा जाँचें (जैसे AWZ-7K3M-Q2XP)।")
    return {**_track(c), "mine": True, "code": get_store().code_of(c["id"])}


def _track(c: dict) -> dict:
    store = get_store()
    # A merged report follows the complaint it was merged into.
    main_c = store.get(c["duplicate_of"]) if c["duplicate_of"] else c
    decision = main_c["decision"] or {}
    dept = DEPARTMENTS.get(main_c["category"] or "")
    return {
        "id": c["id"],
        "merged_into": c["duplicate_of"],
        "created_at": c["created_at"],
        "filed_at": main_c["created_at"],
        "status": main_c["status"],
        "stage": main_c.get("stage"),
        "title_hi": decision.get("title_hi", ""),
        "title_en": decision.get("title_en", ""),
        "department_hi": dept["name_hi"] if dept else "",
        "category": main_c["category"],
        "area": main_c["area"],
        "urgency": main_c["urgency"],
        "urgency_reason": decision.get("urgency_reason", ""),
        "info_level": c["info_level"],
        "gave_mobile": c["gave_mobile"],
        "has_photo": c["has_photo"],
        "pinned": c["location"] is not None,
        "supporters": store.supporters(main_c["id"]),
        "updates": store.updates(main_c["id"]),
    }


class MobileBody(BaseModel):
    mobile: str = Field(min_length=10, max_length=20)


class DisputeBody(BaseModel):
    mobile: str = Field("", max_length=20)
    code: str = Field("", max_length=20)
    note: str = Field("", max_length=500)


@app.post("/api/complaints/{complaint_id}/dispute")
def dispute(complaint_id: int, body: DisputeBody) -> dict:
    """'It is not fixed': reopens a complaint marked fixed, but only for someone who reported it, proven by
    their private tracking code or the same mobile number (matched by fingerprint), so nobody can reopen
    other people's complaints."""
    store = get_store()
    c = store.get(complaint_id)
    if c is None:
        raise HTTPException(404, "No such complaint.")
    main_id = c["duplicate_of"] or c["id"]
    main_c = store.get(main_id)
    if main_c["status"] != "resolved":
        raise HTTPException(409, "Only a complaint marked fixed can be reopened.")
    by_code = bool(body.code) and normalize_code(body.code) in store.codes_for(main_id)
    number = normalize_mobile(body.mobile) if body.mobile else None
    by_mobile = number is not None and contact_hash(number, settings.contact_salt) in store.contact_hashes(main_id)
    if not (by_code or by_mobile):
        raise HTTPException(403, "Use your tracking code, or the mobile number given when this problem was reported.")
    note, _ = mask_pii(body.note.strip())
    message = ("आपने बताया कि समस्या अभी हल नहीं हुई है। शिकायत फिर से खोल दी गई है और विभाग को दोबारा भेजी गई है।"
               + (f" आपकी बात: “{note}”" if note else ""))
    store.add_update(main_id, "reopened", note or "citizen: not fixed", message, "citizen")
    store.set_status(main_id, "open")
    return {"id": main_id, "status": "open", "message_hi": message}


@app.post("/api/my-complaints")
def my_complaints(body: MobileBody) -> list[dict]:
    """A citizen's own tickets, found by the mobile number they gave (POST, so it never sits in a URL)."""
    number = normalize_mobile(body.mobile)
    if number is None:
        raise HTTPException(400, "Give a 10-digit Indian mobile number.")
    return get_store().by_contact(contact_hash(number, settings.contact_salt))


# --- officers ---------------------------------------------------------------------------------------


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=40)
    password: str = Field(min_length=1, max_length=200)


class StatusBody(BaseModel):
    status: Literal["inspected", "approved", "in_progress", "resolved", "rejected", "open", "reopened"]
    note: str = Field("", max_length=500)
    category: str | None = None  # only when routing a needs_review complaint


def current_officer(authorization: str = Header("")) -> dict:
    token = authorization.removeprefix("Bearer ").strip()
    officer = auth.officer_for(get_store(), token) if token else None
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
def officer_queue(closed: bool = False, officer: dict = Depends(current_officer)) -> list[dict]:
    """Open work (or, with closed=1, what was fixed or closed in the last 30 days), each with how long it
    has waited since anyone last acted on it."""
    store = get_store()
    items = store.closed(officer["department"]) if closed else store.queue(officer["department"])
    now = datetime.now(timezone.utc)
    for c in items:
        c["updates"] = store.updates(c["id"])
        last = c["updates"][-1]["created_at"] if c["updates"] else c["created_at"]
        c["idle_days"] = round((now - datetime.fromisoformat(last)).total_seconds() / 86400, 1)
        limit = OVERDUE_DAYS.get(c["status"])
        c["overdue"] = limit is not None and c["idle_days"] > limit
    return items


# Days a complaint may sit without any action before it is flagged as running late.
OVERDUE_DAYS = {"open": 3, "in_progress": 7, "needs_review": 2}


@app.get("/api/officer/export.csv")
def officer_export(officer: dict = Depends(current_officer)) -> Response:
    """The open queue and the last 30 days' closed work as a spreadsheet (UTF-8 with BOM, so Excel shows Hindi)."""
    rows = officer_queue(False, officer) + officer_queue(True, officer)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["id", "filed_at", "area", "department", "urgency", "status", "people", "updates",
                "idle_days", "overdue", "title_hi"])
    for c in rows:
        w.writerow([c["id"], c["created_at"], c["area"], c["category"] or "", c["urgency"] or "", c["status"],
                    c["supporters"], len(c["updates"]), c["idle_days"], "yes" if c["overdue"] else "",
                    (c["decision"] or {}).get("title_hi", "")])
    return Response("\ufeff" + out.getvalue(), media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="awaaz-complaints.csv"'})


def _focus(officer: dict, dept: str) -> str:
    """A department to narrow the dashboard to: any one for a district officer, else their own scope."""
    if not dept:
        return ""
    if dept != REVIEW and dept not in DEPARTMENTS:
        raise HTTPException(400, "Unknown department.")
    own = {officer["department"], REVIEW} if officer["department"] == "other" else {officer["department"]}
    if officer["department"] != ALL_DEPARTMENTS and dept not in own:
        raise HTTPException(403, "You can only see your own department.")
    return dept


@app.get("/api/officer/stats")
def officer_stats(days: int = 30, hours: int = 0, dept: str = "", officer: dict = Depends(current_officer)) -> dict:
    """Status counts for the same window as the insights, so the donut and the tiles always agree."""
    return get_store().stats(officer["department"], days=max(1, min(days, 365)), focus=_focus(officer, dept),
                             hours=max(0, min(hours, 48)))


@app.get("/api/officer/insights")
def officer_insights(days: int = 30, hours: int = 0, dept: str = "", officer: dict = Depends(current_officer)) -> dict:
    """Trend, rankings and attention lists for the officer's own scope over 1 to 365 days, or the last 1 to 48
    hours (`hours` wins when given), for the whole scope or one department in it."""
    return get_store().insights(officer["department"], days=max(1, min(days, 365)), focus=_focus(officer, dept),
                                hours=max(0, min(hours, 48)))


@app.get("/api/officer/pulse")
def officer_pulse(after: int = 0, officer: dict = Depends(current_officer)) -> dict:
    """Cheap, polled every few seconds: the newest complaint in the officer's scope, and any filed after `after`,
    so the dashboard can ring a bell for new work without reloading everything."""
    return get_store().pulse(officer["department"], after)


@app.get("/api/public/stats")
def public_stats(place: str = "") -> dict:
    """Home-page numbers anyone may see, for all of India or one town: counts, per-department progress,
    the latest problems."""
    return get_store().public_stats(place=place.strip()[:MAX_TOWN_CHARS])


@app.get("/api/places")
def places() -> list[dict]:
    """Every town complaints have come from, busiest first; new places appear as soon as someone reports."""
    return get_store().places()


# Which moves an officer may make from each state.
# The work moves forward one stage at a time (skipping ahead is allowed, going back only by reopening).
STAGES = ["inspected", "approved", "in_progress", "resolved"]

TRANSITIONS = {
    "open": {*STAGES, "rejected"},
    "in_progress": set(STAGES),  # narrowed to the stages after the current one below
    "needs_review": {"open", "rejected"},
    # a 'fixed' that was not fixed, or a wrong closing, can be undone with a reason
    "resolved": {"reopened"},
    "rejected": {"reopened"},
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
    allowed = TRANSITIONS.get(c["status"], set())
    if c["status"] == "in_progress":
        current = c.get("stage") or "in_progress"
        allowed = set(STAGES[STAGES.index(current) + 1:])
    if body.status not in allowed:
        raise HTTPException(409, f"Cannot move a complaint from '{c.get('stage') or c['status']}' to '{body.status}'.")
    if body.status in ("rejected", "reopened") and not body.note.strip():
        raise HTTPException(400, "Give a reason when closing or reopening a complaint.")
    if c["status"] == "needs_review" and body.status == "open":
        if body.category not in CATEGORIES:
            raise HTTPException(400, "Pick the department to route this complaint to.")
        store.set_category(complaint_id, body.category)
        c = store.get(complaint_id)

    note = body.note.strip()
    message, source = status_writer.write_message(c, body.status, note)
    update_id = store.add_update(complaint_id, body.status, note, message, officer["username"])
    if body.status == "reopened":
        store.set_status(complaint_id, "open")  # back in the queue; the update keeps the 'reopened' mark
    elif body.status in STAGES:
        # inspected and approved are steps of work in progress; the complaint remembers which one
        store.set_status(complaint_id, "resolved" if body.status == "resolved" else "in_progress", body.status)
    return {"id": complaint_id, "update_id": update_id, "status": body.status, "message_hi": message,
            "written_by": source}


PROOF_STATES = ("inspected", "approved", "in_progress", "resolved")


@app.post("/api/officer/updates/{update_id}/photo")
async def officer_update_photo(
    update_id: int, photo: UploadFile = File(...), officer: dict = Depends(current_officer)
) -> dict:
    """A photo of the work, so the citizen sees it being done instead of only being told."""
    store = get_store()
    u = store.update(update_id)
    if u is None:
        raise HTTPException(404, "No such update.")
    if u["officer"] != officer["username"] or not auth.can_act_on(officer, store.get(u["complaint_id"])):
        raise HTTPException(403, "Only the officer who wrote this update can add its photo.")
    if u["status"] not in PROOF_STATES:
        raise HTTPException(409, "Only work started or finished can carry a photo.")
    if u["photo"]:
        raise HTTPException(409, "This update already has a photo.")
    raw = await photo.read()
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(413, "Photo must be under 10 MB.")
    mime = photo.content_type or "image/jpeg"
    try:
        data, width, height = clean_photo(raw, mime)
    except PhotoError as exc:
        raise HTTPException(400, str(exc)) from exc
    # The work photo is public too: screened like a citizen's, and never published unchecked.
    try:
        verdict = await moderation.screen("", photo=data, mime=mime)
    except BudgetExceeded:
        raise
    except Exception as exc:
        raise HTTPException(503, moderation.PROOF_UNCHECKED) from exc
    if not verdict["photo_safe"]:
        raise HTTPException(422, moderation.PROOF_BLOCKED)
    name = f"u{update_id}.{'png' if mime == 'image/png' else 'jpg'}"
    photos_dir().mkdir(parents=True, exist_ok=True)
    (photos_dir() / name).write_bytes(data)
    info = {"file": name, "width": width, "height": height}
    store.set_update_photo(update_id, info)
    return {"update_id": update_id, "photo": info}


@app.get("/api/updates/{update_id}/photo")
def update_photo(update_id: int) -> FileResponse:
    u = get_store().update(update_id)
    if u is None or not u["photo"]:
        raise HTTPException(404, "No photo for this update.")
    return FileResponse(photos_dir() / u["photo"]["file"])


# Last, so the /api routes above win over the static files.
if FRONTEND_DIR.is_dir():
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
