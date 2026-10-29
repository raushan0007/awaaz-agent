"""Officer passwords (PBKDF2, stdlib only) and bearer-token sessions."""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone

from .departments import CATEGORIES
from .store import ALL_DEPARTMENTS, Store

ITERATIONS = 200_000
SESSION_HOURS = 12
DEPARTMENT_SCOPES = [*CATEGORIES, ALL_DEPARTMENTS]


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), ITERATIONS).hex()
    return f"pbkdf2${ITERATIONS}${salt}${digest}"


def check_password(password: str, stored: str) -> bool:
    try:
        _, iterations, salt, digest = stored.split("$")
    except ValueError:
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), int(iterations)).hex()
    return hmac.compare_digest(candidate, digest)


def create_officer(store: Store, username: str, name: str, department: str, password: str) -> None:
    if department not in DEPARTMENT_SCOPES:
        raise ValueError(f"department must be one of {DEPARTMENT_SCOPES}")
    store.add_officer(username, name, department, hash_password(password))


def login(store: Store, username: str, password: str) -> tuple[str, dict] | None:
    officer = store.officer(username)
    # Hash even for an unknown name, so response time does not reveal which usernames exist.
    stored = officer["pw_hash"] if officer else hash_password("unused")
    if not check_password(password, stored) or officer is None:
        return None
    token = secrets.token_urlsafe(32)
    expires = datetime.now(timezone.utc) + timedelta(hours=SESSION_HOURS)
    store.add_session(token, username, expires.isoformat(timespec="seconds"))
    return token, {k: officer[k] for k in ("username", "name", "department")}


def can_act_on(officer: dict, complaint: dict) -> bool:
    scope = officer["department"]
    if scope == ALL_DEPARTMENTS:
        return True
    if complaint["status"] == "needs_review":
        return scope == "other"
    return complaint["category"] == scope
