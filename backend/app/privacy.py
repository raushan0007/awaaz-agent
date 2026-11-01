"""Hide personal numbers in a report before the model, the officers or the database see it.

People often add "mera number 98xxxxxxxx hai" or an Aadhaar number to a complaint. None of it is
needed to fix a road, so it is replaced with a visible tag and the citizen is told it was hidden.
"""

from __future__ import annotations

import hashlib
import re

# Devanagari digits (०-९) count as digits too; spans are found on an ASCII copy of the same length.
_TO_ASCII = str.maketrans("०१२३४५६७८९", "0123456789")

# Order matters: the 12-digit Aadhaar must win over anything shorter inside it.
PATTERNS: list[tuple[str, re.Pattern, str]] = [
    ("aadhaar", re.compile(r"(?<!\d)[2-9]\d{3}[\s-]?\d{4}[\s-]?\d{4}(?!\d)"), "[आधार नंबर छिपाया गया]"),
    ("mobile", re.compile(r"(?<![\d+])(?:\+?91[\s-]?|0)?[6-9]\d{4}[\s-]?\d{5}(?!\d)"), "[मोबाइल नंबर छिपाया गया]"),
    ("email", re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+"), "[ईमेल छिपाया गया]"),
    ("pan", re.compile(r"\b[A-Z]{5}\d{4}[A-Z]\b"), "[PAN छिपाया गया]"),
]


def mask_pii(text: str) -> tuple[str, list[str]]:
    """(masked text, kinds found), e.g. ("call [मोबाइल नंबर छिपाया गया]", ["mobile"])."""
    found: list[str] = []
    for kind, pattern, tag in PATTERNS:
        ascii_text = text.translate(_TO_ASCII)
        spans = [m.span() for m in pattern.finditer(ascii_text)]
        if not spans:
            continue
        found.append(kind)
        for start, end in reversed(spans):
            text = text[:start] + tag + text[end:]
    return text, found


def normalize_mobile(raw: str) -> str | None:
    """'+91 98765-43210' -> '9876543210'; anything that is not an Indian mobile number -> None."""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    return digits if re.fullmatch(r"[6-9]\d{9}", digits) else None


def contact_hash(mobile: str, salt: str) -> str:
    """A salted one-way fingerprint: it can find a citizen's own complaints again, never show the number."""
    return hashlib.sha256(f"{salt}:{mobile}".encode()).hexdigest()


def info_level(gave_mobile: bool, pinned: bool, photo: bool) -> int:
    """1 (text only) to 4 (mobile, exact spot and photo). Every level is accepted; more is just surer."""
    return 1 + int(gave_mobile) + int(pinned) + int(photo)
