"""The complaint agent: a Muse Spark tool-calling loop whose final answer is checked in code.

The model searches for duplicates, checks the photo with SAM 3.1, then calls `submit_decision`.
`verify_decision` re-checks that decision against what the tools actually returned; a rejected
decision goes back to the model as a tool result with the errors, so it can correct itself.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any

from openai import AsyncOpenAI

from .config import settings
from .departments import CATEGORIES, DEPARTMENTS, URGENCIES, catalog_text
from .meta_client import async_meta_client
from .store import Store
from .vision import segment_image

MAX_TURNS = 8
MAX_PHOTO_CHECKS = 3
DEVANAGARI = re.compile(r"[ऀ-ॿ]")

SYSTEM_PROMPT = f"""You are Awaaz, an assistant that turns a citizen's report about a local civic problem
in Supaul, Bihar (India) into a formal complaint for the right government department.
Reports arrive in Hindi, English or Hinglish, often typed from a voice note, with spelling mistakes.

Departments (pick the category key):
{catalog_text()}

Work in this order:
1. Decide if this is a genuine civic complaint. Reject spam, abuse, advertisements, personal or family
   disputes, requests for medical or legal advice, and anything about political parties, leaders or
   elections. If rejected, call submit_decision right away with is_valid_complaint=false.
2. Call search_similar_complaints with the area and category to find open complaints about the SAME
   problem at the SAME place. Only mark a duplicate when it is clearly the same issue (same street /
   landmark / problem), not just the same category in the same ward.
3. If a photo is attached, call check_photo with a short English noun phrase for what the photo should
   show (e.g. "pothole", "garbage pile", "broken street light", "water puddle"). You may try up to
   {MAX_PHOTO_CHECKS} phrases.
4. Call submit_decision. Urgency: critical = immediate danger to life (live wire on the ground, open
   manhole on a busy road, sewage in drinking water); high = affects many people or health/safety
   within days; medium = ongoing inconvenience; low = cosmetic or minor.
   formal_letter_hi is a short formal letter in Hindi (Devanagari) to the department officer:
   subject line, the problem, exact location, since when, and a request for action. Do not invent
   facts that are not in the report. Leave it empty for duplicates.
   citizen_reply is 1–2 friendly sentences in the same language and script the citizen used, saying
   what happens next.

You must finish by calling submit_decision. If it returns errors, fix them and call it again."""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "search_similar_complaints",
            "description": "Open complaints from the last 30 days in the same area and category.",
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "area": {"type": "string", "description": "Ward / locality / village, e.g. 'Ward 5, Supaul'"},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "keywords": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "A few words that identify the problem or landmark",
                    },
                },
                "required": ["area", "category", "keywords"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_photo",
            "description": "Run SAM 3.1 on the attached photo and count instances of a concept.",
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "concept": {"type": "string", "description": "Short English noun phrase, e.g. 'pothole'"},
                },
                "required": ["concept"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit_decision",
            "description": "Final triage decision. Checked by the server; errors come back as the result.",
            "strict": True,
            "parameters": {
                "type": "object",
                "properties": {
                    "is_valid_complaint": {"type": "boolean"},
                    "rejection_reason": {"type": "string", "description": "Empty when valid"},
                    "category": {"type": "string", "enum": CATEGORIES},
                    "urgency": {"type": "string", "enum": URGENCIES},
                    "urgency_reason": {"type": "string"},
                    "area": {"type": "string"},
                    "duplicate_of": {"type": "integer", "description": "Id of the open complaint this repeats, 0 if none"},
                    "photo_matches": {"type": "string", "enum": ["yes", "no", "unverified", "no_photo"]},
                    "title_en": {"type": "string"},
                    "title_hi": {"type": "string"},
                    "formal_letter_hi": {"type": "string"},
                    "citizen_reply": {"type": "string"},
                },
                "required": [
                    "is_valid_complaint", "rejection_reason", "category", "urgency", "urgency_reason", "area",
                    "duplicate_of", "photo_matches", "title_en", "title_hi", "formal_letter_hi", "citizen_reply",
                ],
                "additionalProperties": False,
            },
        },
    },
]


@dataclass
class Report:
    text: str
    area: str = ""
    photo: bytes | None = None
    photo_mime: str = "image/jpeg"


@dataclass
class RunState:
    searched: bool = False
    seen_ids: set[int] = field(default_factory=set)
    photo_checks: list[dict] = field(default_factory=list)
    # Full SAM output (with masks) per successful check; masks are too big to send back to the model.
    segmentations: list[dict] = field(default_factory=list)

    def best_evidence(self) -> dict | None:
        """The check that found the most instances: what the officer and citizen see over the photo."""
        found = [s for s in self.segmentations if s["boxes"]]
        return max(found, key=lambda s: len(s["boxes"])) if found else None


@dataclass
class AgentResult:
    status: str  # open | merged | rejected | needs_review
    decision: dict | None
    trace: list[dict]
    errors: list[str] = field(default_factory=list)
    evidence: dict | None = None


def verify_decision(d: dict, state: RunState, has_photo: bool) -> list[str]:
    """Every rule here is checkable from the tool results; none of it trusts the model's say-so."""
    errors: list[str] = []
    if not d["is_valid_complaint"]:
        if not d["rejection_reason"].strip():
            errors.append("rejection_reason is required when is_valid_complaint is false.")
        return errors

    if d["rejection_reason"].strip():
        errors.append("rejection_reason must be empty for a valid complaint.")
    if not state.searched:
        errors.append("Call search_similar_complaints before deciding.")
    if d["duplicate_of"] and d["duplicate_of"] not in state.seen_ids:
        errors.append(f"duplicate_of={d['duplicate_of']} was not returned by search_similar_complaints.")
    if not d["area"].strip():
        errors.append("area is required.")
    if not d["title_en"].strip() or not d["title_hi"].strip():
        errors.append("title_en and title_hi are required.")
    if d["urgency"] in ("high", "critical") and not d["urgency_reason"].strip():
        errors.append("urgency_reason is required for high or critical urgency.")
    if not d["citizen_reply"].strip():
        errors.append("citizen_reply is required.")
    if not d["duplicate_of"]:
        letter = d["formal_letter_hi"]
        if len(letter.strip()) < 80 or len(DEVANAGARI.findall(letter)) < 40:
            errors.append("formal_letter_hi must be a complete letter written in Hindi (Devanagari).")

    ok_checks = [c for c in state.photo_checks if "instances" in c]
    if not has_photo:
        if d["photo_matches"] != "no_photo":
            errors.append("No photo is attached, so photo_matches must be 'no_photo'.")
    elif not state.photo_checks:
        errors.append("A photo is attached: call check_photo before deciding.")
    elif d["photo_matches"] == "yes" and not any(c["instances"] > 0 for c in ok_checks):
        errors.append("photo_matches='yes' but check_photo found nothing for any concept.")
    elif d["photo_matches"] == "no" and any(c["instances"] > 0 for c in ok_checks):
        errors.append("photo_matches='no' but check_photo did find the concept.")
    elif d["photo_matches"] == "no_photo":
        errors.append("A photo is attached, so photo_matches cannot be 'no_photo'.")
    elif d["photo_matches"] == "unverified" and ok_checks:
        errors.append("check_photo succeeded, so photo_matches must be 'yes' or 'no'.")
    return errors


def _rank(candidates: list[dict], keywords: list[str]) -> list[dict]:
    words = {w.lower() for k in keywords for w in k.split() if len(w) > 2}

    def score(c: dict) -> int:
        decision = c["decision"] or {}
        hay = f"{c['text']} {decision.get('title_en', '')} {decision.get('title_hi', '')}".lower()
        return sum(w in hay for w in words)

    return sorted(candidates, key=score, reverse=True)


class ComplaintAgent:
    def __init__(self, store: Store, client: AsyncOpenAI | None = None, model: str | None = None):
        self.store = store
        self.client = client
        self.model = model or settings.reasoning_model

    async def _search(self, args: dict, state: RunState) -> dict:
        found = _rank(self.store.find_open(args["area"], args["category"]), args.get("keywords", []))[:5]
        state.searched = True
        state.seen_ids.update(c["id"] for c in found)
        return {
            "matches": [
                {
                    "id": c["id"],
                    "reported_at": c["created_at"],
                    "area": c["area"],
                    "title": (c["decision"] or {}).get("title_en", ""),
                    "report": c["text"][:300],
                    "supporters": self.store.supporters(c["id"]),
                }
                for c in found
            ]
        }

    async def _check_photo(self, args: dict, report: Report, state: RunState) -> dict:
        concept = args["concept"].strip()[:40]
        if report.photo is None:
            return {"error": "No photo is attached to this report."}
        if len(state.photo_checks) >= MAX_PHOTO_CHECKS:
            return {"error": f"Photo already checked {MAX_PHOTO_CHECKS} times; decide with what you have."}
        try:
            settings.budget.ensure_room()
            seg = await segment_image(report.photo, report.photo_mime, concept)
            result = {"concept": concept, "instances": len(seg["boxes"]), "boxes": seg["boxes"]}
            state.segmentations.append({"concept": concept, "boxes": seg["boxes"], "masks": seg["masks"]})
        except Exception as exc:  # noqa: BLE001 - a SAM outage must not sink the whole complaint
            result = {"concept": concept, "error": f"{type(exc).__name__}: {str(exc)[:200]}"}
        state.photo_checks.append(result)
        return result

    async def run(self, report: Report) -> AgentResult:
        client = self.client or async_meta_client()
        state = RunState()
        trace: list[dict] = []
        user = f"Area given by citizen: {report.area or '(not given)'}\n"
        user += f"Photo attached: {'yes' if report.photo else 'no'}\n\nReport:\n{report.text}"
        messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}, {"role": "user", "content": user}]
        last_errors: list[str] = []

        for turn in range(1, MAX_TURNS + 1):
            settings.budget.ensure_room()
            started = time.perf_counter()
            r = await client.chat.completions.create(model=self.model, messages=messages, tools=TOOLS)
            settings.budget.charge_tokens(self.model, r.usage.prompt_tokens, r.usage.completion_tokens)
            msg = r.choices[0].message
            model_ms = int((time.perf_counter() - started) * 1000)

            if not msg.tool_calls:
                # tool_choice="required" is not supported by the Meta API, so nudge instead.
                trace.append({"turn": turn, "note": (msg.content or "")[:500], "ms": model_ms})
                messages.append({"role": "assistant", "content": msg.content or ""})
                messages.append({"role": "user", "content": "Use the tools, and finish by calling submit_decision."})
                continue

            messages.append(msg.model_dump(exclude_none=True))
            for call in msg.tool_calls:
                started = time.perf_counter()
                try:
                    args = json.loads(call.function.arguments or "{}")
                except json.JSONDecodeError:
                    args, result = {}, {"error": "arguments were not valid JSON"}
                else:
                    result = await self._dispatch(call.function.name, args, report, state)

                if call.function.name == "submit_decision" and "accepted" in result:
                    if result["accepted"]:
                        trace.append(self._step(turn, call.function.name, args, result, started, model_ms))
                        return self._finish(args, trace, state.best_evidence())
                    last_errors = result["errors"]
                trace.append(self._step(turn, call.function.name, args, result, started, model_ms))
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "content": json.dumps(result, ensure_ascii=False)}
                )

        return AgentResult("needs_review", None, trace, last_errors or ["Agent did not submit a decision."],
                           state.best_evidence())

    async def _dispatch(self, name: str, args: dict, report: Report, state: RunState) -> dict:
        if name == "search_similar_complaints":
            return await self._search(args, state)
        if name == "check_photo":
            return await self._check_photo(args, report, state)
        if name == "submit_decision":
            errors = verify_decision(args, state, report.photo is not None)
            return {"accepted": not errors, "errors": errors}
        return {"error": f"Unknown tool {name!r}."}

    @staticmethod
    def _step(turn: int, tool: str, args: dict, result: dict, started: float, model_ms: int) -> dict:
        return {
            "turn": turn,
            "tool": tool,
            "args": args,
            "result": result,
            "model_ms": model_ms,
            "tool_ms": int((time.perf_counter() - started) * 1000),
        }

    @staticmethod
    def _finish(decision: dict, trace: list[dict], evidence: dict | None) -> AgentResult:
        if not decision["is_valid_complaint"]:
            return AgentResult("rejected", decision, trace, evidence=evidence)
        decision = {**decision, "department": DEPARTMENTS[decision["category"]]}
        status = "merged" if decision["duplicate_of"] else "open"
        return AgentResult(status, decision, trace, evidence=evidence)
