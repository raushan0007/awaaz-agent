"""Plain-Hindi status updates for citizens, written by Muse Spark Open (open weights, on Baseten).

The officer's note is often terse English ("JE visited, patch work Monday"). The model turns it into
two short Hindi sentences a citizen understands. The output is checked; if the open model is
unreachable or its text fails the checks, a fixed template is used so the citizen is never left
without an update.
"""

from __future__ import annotations

import logging
import re

from . import meta_client
from .departments import DEPARTMENTS

log = logging.getLogger("awaaz.status_writer")
ATTEMPTS = 2
# Spark Open always reasons before answering and can spend 1000+ tokens doing it; too small a budget
# leaves the answer empty.
MAX_TOKENS = 4000
DEVANAGARI = re.compile(r"[ऀ-ॿ]")
DIGITS = re.compile(r"\d")
MAX_CHARS = 400

STATUS_HI = {
    "in_progress": "काम शुरू हो गया है",
    "resolved": "समस्या हल कर दी गई है",
    "rejected": "शिकायत बंद कर दी गई है",
    "open": "शिकायत सही विभाग को भेज दी गई है",
}

TEMPLATES = {
    "in_progress": "आपकी शिकायत \"{title}\" पर {dept} ने काम शुरू कर दिया है। काम पूरा होने पर आपको फिर बताया जाएगा।",
    "resolved": "आपकी शिकायत \"{title}\" को {dept} ने हल कर दिया है। अगर समस्या अब भी है, तो दोबारा शिकायत करें।",
    "rejected": "आपकी शिकायत \"{title}\" बंद कर दी गई है। ज़रूरत हो तो पूरी जानकारी के साथ नई शिकायत करें।",
    "open": "आपकी शिकायत \"{title}\" {dept} को भेज दी गई है। आगे की जानकारी यहीं मिलेगी।",
}

PROMPT = """You write status updates for citizens of Supaul, Bihar about their civic complaint.
Write exactly 1 or 2 short, polite sentences in simple Hindi (Devanagari script), as a government
helpdesk would. Say what has happened and what happens next. Use only facts given below; do not
add dates, times, names, phone numbers or promises that are not in the officer's note. No greeting,
no sign-off, no quotation marks, no English words unless they are in the note.

Complaint: {title}
Department: {dept}
New status: {status_hi}
Officer's note (may be English or Hinglish, may be empty): {note}

Reply with only the message."""


def check_message(message: str, note: str, title: str = "") -> list[str]:
    """Problems with a model-written update; empty means it can be shown to the citizen."""
    problems = []
    if len(DEVANAGARI.findall(message)) < 20:
        problems.append("not Hindi")
    if len(message) > MAX_CHARS:
        problems.append("too long")
    # Numbers are where invented promises hide ("2 दिन में", "तारीख 5"): only allow ones already given,
    # in the officer's note or the complaint title ("वार्ड 5").
    if set(DIGITS.findall(message)) - set(DIGITS.findall(note + title)):
        problems.append("numbers not in the officer's note")
    return problems


def template_message(complaint: dict, status: str) -> str:
    decision = complaint.get("decision") or {}
    dept = DEPARTMENTS.get(complaint.get("category") or "", DEPARTMENTS["other"])["name_hi"]
    return TEMPLATES[status].format(title=decision.get("title_hi") or "आपकी समस्या", dept=dept)


def write_message(complaint: dict, status: str, note: str) -> tuple[str, str]:
    """(message, source) where source is 'spark-open' or 'template'."""
    decision = complaint.get("decision") or {}
    dept = DEPARTMENTS.get(complaint.get("category") or "", DEPARTMENTS["other"])["name_hi"]
    title = decision.get("title_hi") or complaint["text"][:200]
    prompt = PROMPT.format(
        title=title,
        dept=dept,
        status_hi=STATUS_HI[status],
        note=note or "(none)",
    )
    for attempt in range(1, ATTEMPTS + 1):
        try:
            message = meta_client.ask_open([{"role": "user", "content": prompt}], max_tokens=MAX_TOKENS)
        except Exception as exc:  # noqa: BLE001 - the citizen still gets the template below
            log.warning("status writer attempt %d: %s: %s", attempt, type(exc).__name__, str(exc)[:200])
            continue
        message = message.strip().strip('"“”').strip()
        problems = check_message(message, note, title)
        if not problems:
            return message, "spark-open"
        log.warning("status writer attempt %d rejected (%s): %r", attempt, ", ".join(problems), message[:200])
    return template_message(complaint, status), "template"
