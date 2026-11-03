"""Content safety: photos and report text are screened by Muse Spark before anything is stored or shown.

Photos are public on Awaaz, so a photo that is sexual, shows nudity, gore or a hateful symbol must never
reach the disk. The check fails closed: if the screen cannot run, the photo is not kept.
"""

from __future__ import annotations

import base64
import json

from .config import settings
from .meta_client import async_meta_client

PHOTO_CATEGORIES = ["none", "nudity_or_sexual", "graphic_violence_or_gore", "hateful_symbol_or_gesture",
                    "self_harm", "other_disturbing"]
TEXT_CATEGORIES = ["none", "sexual_or_obscene", "abusive_or_hateful", "threat_of_violence"]

PROMPT = """You screen uploads to a public civic-complaint website in India, where anyone can see the
photos. Decide only whether the content is safe to show in public; whether it is a real complaint is
decided elsewhere.

Photo (if attached) is UNSAFE when it shows: nudity or partial nudity, sexual acts or sexual poses,
anything sexualising a child; graphic violence, blood, wounds, dead or badly injured people, or gore;
hateful symbols or obscene gestures; self-harm; or anything else most people would find disturbing.
Ordinary civic problems are SAFE even when unpleasant: garbage, sewage, open drains, potholes, flooding,
broken wires, stray animals, a dead animal lying on a road (unless it is a gory close-up), crowds or
people in normal clothes in the background.

Text is UNSAFE when it is itself sexual or obscene, uses slurs or abuse against a person or group, or
threatens violence. A report ABOUT a problem is SAFE even if serious: harassment of women near a school,
drunk men fighting, a theft, a road accident, an officer asking for a bribe.

Citizen's text: {text}
Area: {area}
Town: {town}"""

SCHEMA = {
    "type": "object",
    "properties": {
        "photo_safe": {"type": "boolean", "description": "true when there is no photo"},
        "photo_category": {"type": "string", "enum": PHOTO_CATEGORIES},
        "text_safe": {"type": "boolean"},
        "text_category": {"type": "string", "enum": TEXT_CATEGORIES},
    },
    "required": ["photo_safe", "photo_category", "text_safe", "text_category"],
    "additionalProperties": False,
}

# What the citizen is told, in plain Hindi.
PHOTO_BLOCKED_HI = "यह फ़ोटो स्वीकार नहीं की गई: यह सबके सामने दिखाने लायक नहीं है। शिकायत बिना फ़ोटो के दर्ज की गई है।"
PHOTO_UNCHECKED_HI = "फ़ोटो की जाँच नहीं हो सकी, इसलिए फ़ोटो नहीं रखी गई। शिकायत बिना फ़ोटो के दर्ज की गई है।"
TEXT_BLOCKED_HI = ("यह शिकायत स्वीकार नहीं की जा सकती: इसमें अश्लील, अपमानजनक या धमकी भरी बातें हैं। "
                   "कृपया समस्या को सामान्य शब्दों में लिखें।")
PROOF_BLOCKED = "This photo cannot be published: it is not fit to show in public."
PROOF_UNCHECKED = "The photo could not be checked for safety; please try again in a minute."


async def screen(text: str, area: str = "", town: str = "", photo: bytes | None = None,
                 mime: str = "image/jpeg") -> dict:
    """One Muse Spark call over the text and the photo. Returns the schema's four fields."""
    settings.budget.ensure_room()
    content: list[dict] = [{"type": "input_text", "text": PROMPT.format(
        text=json.dumps(text, ensure_ascii=False), area=json.dumps(area, ensure_ascii=False),
        town=json.dumps(town, ensure_ascii=False))}]
    if photo is not None:
        url = f"data:{mime};base64,{base64.b64encode(photo).decode('ascii')}"
        content.append({"type": "input_image", "image_url": url})
    model = settings.reasoning_model
    async with async_meta_client() as api:
        r = await api.responses.create(
            model=model,
            input=[{"type": "message", "role": "user", "content": content}],
            text={"format": {"type": "json_schema", "name": "safety", "schema": SCHEMA, "strict": True}},
        )
    settings.budget.charge_tokens(model, r.usage.input_tokens, r.usage.output_tokens)
    verdict = json.loads(r.output_text)
    if photo is None:
        verdict["photo_safe"], verdict["photo_category"] = True, "none"
    # an unsafe flag with category "none" (or the reverse) is read as unsafe: doubt keeps content off the site
    verdict["photo_safe"] = verdict["photo_safe"] and verdict["photo_category"] == "none"
    verdict["text_safe"] = verdict["text_safe"] and verdict["text_category"] == "none"
    return verdict
