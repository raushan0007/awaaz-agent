"""Copy the seeded local database into demo/awaaz-demo.db, without officer accounts or sessions.

Usage: python scripts/seed_demo.py first, then python scripts/make_demo_db.py
The hosted copy loads this file on first start (backend/app/bootstrap.py).
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.config import settings  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "demo" / "awaaz-demo.db"


def main() -> None:
    source = sqlite3.connect(settings.data_dir / "awaaz.db")
    OUT.parent.mkdir(exist_ok=True)
    OUT.unlink(missing_ok=True)
    target = sqlite3.connect(OUT)
    source.backup(target)
    source.close()
    with target:
        target.execute("DELETE FROM sessions")
        target.execute("DELETE FROM officers")
    target.execute("VACUUM")
    counts = {t: target.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
              for t in ("complaints", "updates", "officers", "sessions")}
    target.close()
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {counts}")


if __name__ == "__main__":
    main()
