"""Officer passwords (PBKDF2, stdlib only) and signed bearer tokens.

A token is `username.expiry.signature` (HMAC-SHA256). Nothing is stored for it, so a login survives a server
restart: the free hosting plan restarts the server and reloads its database now and then."""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta, timezone

from .config import settings
from .departments import CATEGORIES
from .store import ALL_DEPARTMENTS, Store

ITERATIONS = 200_000
SESSION_HOURS = 12
DEPARTMENT_SCOPES = [*CATEGORIES, ALL_DEPARTMENTS]
_PROCESS_SECRET = secrets.token_bytes(32)


def _secret() -> bytes:
    """AWAAZ_SESSION_SECRET if set; else derived from the model key, which is stable across restarts and never
    leaves the server; else (no key at all, e.g. tests) a secret for this process only."""
    if os.environ.get("AWAAZ_SESSION_SECRET"):
        return os.environ["AWAAZ_SESSION_SECRET"].encode()
    if settings.meta_api_key:
        return hashlib.sha256(b"awaaz-officer-session:" + settings.meta_api_key.encode()).digest()
    return _PROCESS_SECRET


def _sign(body: str) -> str:
    return base64.urlsafe_b64encode(hmac.new(_secret(), body.encode(), hashlib.sha256).digest()).decode().rstrip("=")


def make_token(username: str, hours: int = SESSION_HOURS) -> str:
    name = base64.urlsafe_b64encode(username.encode()).decode().rstrip("=")
    body = f"{name}.{int((datetime.now(timezone.utc) + timedelta(hours=hours)).timestamp())}"
    return f"{body}.{_sign(body)}"


def officer_for(store: Store, token: str) -> dict | None:
    """The officer a token belongs to, if its signature is right, it has not expired and the officer exists."""
    try:
        name, expires, signature = token.split(".")
        username = base64.urlsafe_b64decode(name + "=" * (-len(name) % 4)).decode()
        expires_at = int(expires)
    except (ValueError, UnicodeDecodeError):
        return None
    if not hmac.compare_digest(signature, _sign(f"{name}.{expires}")):
        return None
    if expires_at < datetime.now(timezone.utc).timestamp():
        return None
    officer = store.officer(username)
    return {k: officer[k] for k in ("username", "name", "department")} if officer else None


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
    return make_token(username), {k: officer[k] for k in ("username", "name", "department")}


def can_act_on(officer: dict, complaint: dict) -> bool:
    scope = officer["department"]
    if scope == ALL_DEPARTMENTS:
        return True
    if complaint["status"] == "needs_review":
        return scope == "other"
    return complaint["category"] == scope
