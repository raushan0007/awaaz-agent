"""First-start setup for a hosted copy: run before the server (`python -m backend.app.bootstrap`).

- An empty data folder gets the demo database (demo/awaaz-demo.db): two weeks of Supaul and Forbesganj
  reports that went through the live agent, plus their photos (demo/photos), so judges see a working
  dashboard straight away.
- If AWAAZ_DEMO_OFFICER_PASSWORD is set, a district-level `demo.officer` login is created (or its
  password reset) with it. The snapshot itself holds no officer accounts.
"""

from __future__ import annotations

import os
import shutil
from pathlib import Path

from .auth import create_officer
from .config import settings
from .store import ALL_DEPARTMENTS, Store

DEMO_DB = Path(__file__).resolve().parents[2] / "demo" / "awaaz-demo.db"
DEMO_OFFICER = "demo.officer"


def bootstrap(data_dir: Path, demo_db: Path = DEMO_DB, officer_password: str = "") -> list[str]:
    """Returns what it did, for the start-up log."""
    done = []
    data_dir.mkdir(parents=True, exist_ok=True)
    db = data_dir / "awaaz.db"
    if not db.exists() and demo_db.exists():
        shutil.copyfile(demo_db, db)
        done.append(f"loaded demo database from {demo_db.name}")
        photos = demo_db.parent / "photos"  # the citizens' photos the snapshot's complaints point to
        if photos.is_dir():
            shutil.copytree(photos, data_dir / "photos", dirs_exist_ok=True)
            done.append(f"loaded {len(list(photos.iterdir()))} demo photos")
    if officer_password:
        store = Store(db)
        create_officer(store, DEMO_OFFICER, "Demo District Officer", ALL_DEPARTMENTS, officer_password)
        store.close()
        done.append(f"demo officer '{DEMO_OFFICER}' ready")
    return done


if __name__ == "__main__":
    for line in bootstrap(settings.data_dir, officer_password=os.environ.get("AWAAZ_DEMO_OFFICER_PASSWORD", "")):
        print("bootstrap:", line)
