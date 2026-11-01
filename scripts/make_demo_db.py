"""Copy the seeded local database into demo/awaaz-demo.db (photos into demo/photos), without officer logins.

Usage: python scripts/seed_demo.py first, then python scripts/make_demo_db.py
The hosted copy loads this file on first start (backend/app/bootstrap.py).
"""

from __future__ import annotations

import json
import shutil
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.config import settings  # noqa: E402

OUT = Path(__file__).resolve().parent.parent / "demo" / "awaaz-demo.db"
PHOTOS = OUT.parent / "photos"


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
    files = [json.loads(p)["file"] for (p,) in target.execute("SELECT photo FROM complaints WHERE photo IS NOT NULL")]
    target.close()
    shutil.rmtree(PHOTOS, ignore_errors=True)
    PHOTOS.mkdir()
    for name in files:
        shutil.copyfile(settings.data_dir / "photos" / name, PHOTOS / name)
    print(f"wrote {OUT} ({OUT.stat().st_size // 1024} KB): {counts}, {len(files)} photos")


if __name__ == "__main__":
    main()
