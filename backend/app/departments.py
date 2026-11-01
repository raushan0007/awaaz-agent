"""The fixed routing catalog. The agent picks a category; the department follows from it in code."""

from __future__ import annotations

DEPARTMENTS: dict[str, dict[str, str]] = {
    "roads": {
        "name_en": "Roads & Construction",
        "name_hi": "सड़क एवं निर्माण विभाग",
        "handles": "potholes, broken or unfinished roads, culverts, small bridges, footpaths",
    },
    "water": {
        "name_en": "Drinking Water (PHED)",
        "name_hi": "पेयजल एवं स्वच्छता विभाग (PHED)",
        "handles": "no water supply, dirty tap water, broken handpumps, leaking supply pipelines",
    },
    "electricity": {
        "name_en": "Electricity Distribution",
        "name_hi": "बिजली वितरण विभाग",
        "handles": "power cuts, burnt transformers, hanging or live wires, leaning electric poles",
    },
    "streetlight": {
        "name_en": "Municipal Street Lighting",
        "name_hi": "नगर परिषद – स्ट्रीट लाइट",
        "handles": "street lights not working or on during the day",
    },
    "sanitation": {
        "name_en": "Municipal Sanitation",
        "name_hi": "नगर परिषद – सफ़ाई विभाग",
        "handles": "garbage piles, uncollected waste, dead animals, dirty public spaces",
    },
    "drainage": {
        "name_en": "Drainage & Sewerage",
        "name_hi": "नाला एवं जल-निकासी विभाग",
        "handles": "blocked or overflowing drains, waterlogging, open manholes, sewage on roads",
    },
    "other": {
        "name_en": "Public Grievance Cell",
        "name_hi": "लोक शिकायत प्रकोष्ठ",
        "handles": "any genuine civic problem that fits none of the above",
    },
}

# Awaaz takes reports from anywhere in India; the citizen names the town or district and every stored
# area ends with it ("Ward 8, Forbesganj"), so places never mix.
MAX_TOWN_CHARS = 40

CATEGORIES = list(DEPARTMENTS)
URGENCIES = ["low", "medium", "high", "critical"]


def catalog_text() -> str:
    return "\n".join(f"- {key}: {d['name_en']} — {d['handles']}" for key, d in DEPARTMENTS.items())
