"""Create one demo officer per department plus a district officer who sees everything.

Usage: python scripts/seed_officers.py
Passwords are random and written to backend/data/officers.local.txt (git-ignored), never printed.
Running it again replaces the passwords.
"""

from __future__ import annotations

import secrets
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.auth import create_officer  # noqa: E402
from backend.app.config import settings  # noqa: E402
from backend.app.departments import DEPARTMENTS  # noqa: E402
from backend.app.store import ALL_DEPARTMENTS, Store  # noqa: E402


def main() -> None:
    store = Store(settings.data_dir / "awaaz.db")
    accounts = [(f"{key}.officer", d["name_en"] + " Officer", key) for key, d in DEPARTMENTS.items()]
    accounts.append(("district.officer", "District Grievance Officer", ALL_DEPARTMENTS))
    lines = ["# Demo officer logins for the local Awaaz dashboard (/officer.html). Do not commit.", ""]
    for username, name, department in accounts:
        password = secrets.token_urlsafe(9)
        create_officer(store, username, name, department, password)
        lines.append(f"{username:<24} {password:<16} {department}")
    out = settings.data_dir / "officers.local.txt"
    out.write_text("\n".join(lines) + "\n", encoding="utf-8")
    store.close()
    print(f"{len(accounts)} officers saved; logins in {out}")


if __name__ == "__main__":
    main()
