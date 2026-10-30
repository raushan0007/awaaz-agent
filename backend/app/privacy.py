"""Hide personal numbers in a report before the model, the officers or the database see it.

People often add "mera number 98xxxxxxxx hai" or an Aadhaar number to a complaint. None of it is
needed to fix a road, so it is replaced with a visible tag and the citizen is told it was hidden.
"""

from __future__ import annotations

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
