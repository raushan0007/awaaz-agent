"""Add real photo reports from Forbesganj to the demo database, through the real API.

The photos were taken on the spot on 30 Oct 2026 (GPS-camera app). Their burned-in GPS strip is cut off
before use, and the server strips any remaining metadata. Each report goes through the live agent with
its photo, so the routing, the SAM check and the letter are real model output. Afterwards each report's
timestamp is set to the moment its photo was taken. No officer actions: nothing has been fixed yet.

Usage (server running on the demo database):
    python scripts/seed_photos.py PHOTO_DIR [--base http://localhost:8010]
PHOTO_DIR holds drain-1.jpg, garbage-1.jpg and chowk-1.jpg. Costs about $0.10 of model calls.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.config import settings  # noqa: E402

IST = timezone(timedelta(hours=5, minutes=30))

# (photo, taken at (IST), town, area, report text)
REPORTS: list[tuple[str, datetime, str, str, str]] = [
    ("garbage-1.jpg", datetime(2026, 10, 30, 8, 32, tzinfo=IST), "Forbesganj", "Sultan Pokhar West",
     "Sultan Pokhar West mein purani eent ki deewar ke paas sadak kinare kooda ka dher laga hai. Koi uthane nahi "
     "aata, log wahin kooda jala bhi dete hain, dhuan aur badbu rehti hai."),
    ("chowk-1.jpg", datetime(2026, 10, 30, 8, 42, tzinfo=IST), "Forbesganj", "Subhash Chowk, Ward 8",
     "Subhash Chowk railway crossing ke paas Bank of India ke saamne naali tooti hui hai. Poore chowk par kichad "
     "aur kooda bhara hai, barish mein paani nikal nahi pata aur log keechad mein chalte hain."),
    ("drain-1.jpg", datetime(2026, 10, 30, 8, 56, tzinfo=IST), "Forbesganj", "Sultan Pokhar West",
     "Sultan Pokhar West mein gali ki khuli naali mein ganda kaala paani ruka hua hai, plastic aur kooda bhara hai. "
     "Naali ki safai kab se nahi hui, machhar bahut ho gaye hain."),
]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("photo_dir", type=Path)
    parser.add_argument("--base", default="http://localhost:8010")
    args = parser.parse_args()
    client = httpx.Client(base_url=args.base, timeout=240)

    filed: list[tuple[int, datetime]] = []
    for photo, taken, town, area, text in REPORTS:
        started = time.perf_counter()
        with open(args.photo_dir / photo, "rb") as f:
            r = client.post("/api/complaints", data={"text": text, "area": area, "town": town},
                            files={"photo": (photo, f, "image/jpeg")})
        r.raise_for_status()
        c = r.json()
        checks = [s["result"] for s in c["trace"] if s.get("tool") == "check_photo"]
        print(f"#{c['id']:<3} {c['status']:<8} {c['category'] or '-':<11} {c['urgency'] or '-':<8} "
              f"dup={c['duplicate_of'] or '-':<4} {time.perf_counter() - started:4.0f}s  {c['area']}", flush=True)
        for check in checks:
            print(f"      SAM '{check.get('concept')}': {check.get('instances', check.get('error'))}")
        filed.append((c["id"], taken))

    db = sqlite3.connect(settings.data_dir / "awaaz.db")
    with db:
        for cid, taken in filed:
            db.execute("UPDATE complaints SET created_at = ? WHERE id = ?",
                       (taken.astimezone(timezone.utc).isoformat(timespec="seconds"), cid))
    db.close()
    print(f"done: {len(filed)} photo reports, spend today ${client.get('/api/health').json()['spent_today_usd']}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
