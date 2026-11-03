"""SQLite storage for complaints. One row per citizen report; duplicates point at their parent."""

from __future__ import annotations

import json
import math
import unicodedata
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
from pathlib import Path
from typing import Any

from .privacy import info_level

SCHEMA = """
CREATE TABLE IF NOT EXISTS complaints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    text TEXT NOT NULL,
    area TEXT NOT NULL DEFAULT '',
    area_key TEXT NOT NULL DEFAULT '',
    has_photo INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL,
    category TEXT,
    urgency TEXT,
    duplicate_of INTEGER REFERENCES complaints(id),
    decision TEXT,
    trace TEXT,
    photo TEXT,
    evidence TEXT,
    masked TEXT
);
CREATE INDEX IF NOT EXISTS idx_open ON complaints(status, category, area_key);
CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_id INTEGER NOT NULL REFERENCES complaints(id),
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    message_hi TEXT NOT NULL DEFAULT '',
    officer TEXT NOT NULL DEFAULT '',
    photo TEXT
);
CREATE INDEX IF NOT EXISTS idx_updates ON updates(complaint_id);
CREATE TABLE IF NOT EXISTS officers (
    username TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    department TEXT NOT NULL,
    pw_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    username TEXT NOT NULL REFERENCES officers(username),
    expires_at TEXT NOT NULL
);
"""
# Columns added after the first release, so databases made earlier keep working.
LATER_COLUMNS = {
    # lat/lon/loc_accuracy: the phone's position, only when the citizen tapped 📍. Officers see it; the
    # public endpoints never do.
    "complaints": {"photo": "TEXT", "evidence": "TEXT", "masked": "TEXT",
                   "lat": "REAL", "lon": "REAL", "loc_accuracy": "REAL",
                   # salted fingerprint of the mobile number, if one was given; the number itself is never kept
                   "contact_hash": "TEXT",
                   # where the work stands: inspected -> approved -> in_progress -> resolved
                   "stage": "TEXT"},
    "updates": {"photo": "TEXT"},  # the officer's photo of the work, if any
}
JSON_COLUMNS = ("decision", "photo", "evidence", "masked")

# open: routed to a department; merged: a duplicate of an open complaint; rejected: failed
# verification (spam, not civic); needs_review: the agent could not reach a valid decision.
OPEN_STATES = ("open", "in_progress")
URGENCY_ORDER = "CASE urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END"
ALL_DEPARTMENTS = "all"  # a district-level officer who sees every department and the review queue
NUMBER_WORDS = {"no", "number", "नं", "नंबर"}


def area_key(area: str) -> str:
    """'Ward No. 5, Supaul ' -> 'ward 5 supaul', so spelling noise does not split one area in two."""
    # Not `\w`: it misses Devanagari vowel signs, which would split "वार्ड" into letters.
    text = "".join(" " if unicodedata.category(ch)[0] in "PSZ" else ch for ch in area.lower())
    return " ".join(w for w in text.split() if w not in NUMBER_WORDS)


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres (haversine); plenty for 'is this the same street corner'."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


def town_of(area: str) -> str:
    """'Sultan Pokhar West, Forbesganj' -> 'Forbesganj': the town is what follows the last comma."""
    return area.rsplit(",", 1)[-1].strip() if "," in area else area.strip()


def _dump(value: dict | list | None) -> str | None:
    return json.dumps(value, ensure_ascii=False) if value is not None else None


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _areas_match(a: str, b: str) -> bool:
    if not a or not b:
        return False
    return a in b or b in a


class Store:
    def __init__(self, path: Path | str):
        self._lock = threading.Lock()
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(str(path), check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.executescript(SCHEMA)
        for table, columns in LATER_COLUMNS.items():
            have = {r["name"] for r in self._db.execute(f"PRAGMA table_info({table})")}
            for name, kind in columns.items():
                if name not in have:
                    self._db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {kind}")

    def add(self, *, text: str, area: str, has_photo: bool, status: str, category: str | None,
            urgency: str | None, duplicate_of: int | None, decision: dict | None, trace: list,
            evidence: dict | None = None, masked: list[str] | None = None,
            location: dict | None = None, contact: str | None = None) -> int:
        loc = location or {}
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO complaints (created_at, text, area, area_key, has_photo, status, category,"
                " urgency, duplicate_of, decision, trace, evidence, masked, lat, lon, loc_accuracy, contact_hash)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    text, area, area_key(area), int(has_photo), status, category, urgency, duplicate_of,
                    _dump(decision), json.dumps(trace, ensure_ascii=False), _dump(evidence),
                    json.dumps(masked or []), loc.get("lat"), loc.get("lon"), loc.get("accuracy"), contact,
                ),
            )
            return cur.lastrowid

    def set_photo(self, complaint_id: int, photo: dict) -> None:
        """photo = {"file", "width", "height"}; the file itself lives in the photos folder."""
        with self._lock, self._db:
            self._db.execute("UPDATE complaints SET photo = ? WHERE id = ?", (_dump(photo), complaint_id))

    def get(self, complaint_id: int) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM complaints WHERE id = ?", (complaint_id,)).fetchone()
        return self._row(row) if row else None

    def recent(self, limit: int = 50, status: str | None = None) -> list[dict[str, Any]]:
        sql, args = "SELECT * FROM complaints", []
        if status:
            sql, args = sql + " WHERE status = ?", [status]
        rows = self._db.execute(sql + " ORDER BY id DESC LIMIT ?", (*args, limit)).fetchall()
        return [self._row(r) for r in rows]

    def supporters(self, complaint_id: int) -> int:
        """The original reporter plus everyone whose report was merged into this one."""
        n = self._db.execute(
            "SELECT COUNT(*) FROM complaints WHERE duplicate_of = ?", (complaint_id,)
        ).fetchone()[0]
        return n + 1

    def find_open(self, area: str, category: str, days: int = 30) -> list[dict[str, Any]]:
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        rows = self._db.execute(
            "SELECT * FROM complaints WHERE status IN (%s) AND category = ? AND created_at >= ?"
            " ORDER BY id DESC" % ",".join("?" * len(OPEN_STATES)),
            (*OPEN_STATES, category, since),
        ).fetchall()
        key = area_key(area)
        return [self._row(r) for r in rows if _areas_match(key, r["area_key"])]

    def area_summary(self, area: str, limit: int = 10) -> dict[str, Any]:
        """Everything the public may know about one place: its problems, their state, how many reported them.

        Titles and status only, never report text or photos (same rule as the tracking page)."""
        key = area_key(area)
        rows = [r for r in self._db.execute(
            "SELECT id, created_at, area_key, status, category, urgency, duplicate_of, decision FROM complaints"
            " WHERE status NOT IN ('rejected', 'needs_review') ORDER BY id DESC"
        ).fetchall() if _areas_match(key, r["area_key"])]
        problems = [r for r in rows if r["duplicate_of"] is None]
        by_status: dict[str, int] = {}
        by_category: dict[str, int] = {}
        for r in problems:
            by_status[r["status"]] = by_status.get(r["status"], 0) + 1
            by_category[r["category"]] = by_category.get(r["category"], 0) + 1
        return {
            "area": area,
            "reports": len(rows),
            "problems": len(problems),
            "by_status": by_status,
            "by_category": dict(sorted(by_category.items(), key=lambda kv: -kv[1])),
            "items": [
                {
                    "id": r["id"],
                    "created_at": r["created_at"],
                    "status": r["status"],
                    "category": r["category"],
                    "urgency": r["urgency"],
                    "title_hi": (json.loads(r["decision"]) if r["decision"] else {}).get("title_hi", ""),
                    "supporters": self.supporters(r["id"]),
                }
                for r in problems[:limit]
            ],
        }

    def find_near(self, lat: float, lon: float, category: str, radius_m: float = 200,
                  days: int = 30) -> list[dict[str, Any]]:
        """Open complaints of this kind pinned within `radius_m`, nearest first, each with `distance_m`."""
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        rows = self._db.execute(
            "SELECT * FROM complaints WHERE status IN (%s) AND category = ? AND created_at >= ? AND lat IS NOT NULL"
            % ",".join("?" * len(OPEN_STATES)),
            (*OPEN_STATES, category, since),
        ).fetchall()
        near = []
        for r in rows:
            d = distance_m(lat, lon, r["lat"], r["lon"])
            if d <= radius_m:
                near.append({**self._row(r), "distance_m": round(d)})
        return sorted(near, key=lambda c: c["distance_m"])

    def set_category(self, complaint_id: int, category: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE complaints SET category = ? WHERE id = ?", (category, complaint_id))

    # --- status updates -------------------------------------------------------------------------

    def add_update(self, complaint_id: int, status: str, note: str, message_hi: str, officer: str) -> int:
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO updates (complaint_id, created_at, status, note, message_hi, officer)"
                " VALUES (?,?,?,?,?,?)",
                (complaint_id, _now(), status, note, message_hi, officer),
            )
            self._db.execute("UPDATE complaints SET status = ? WHERE id = ?", (status, complaint_id))
        return cur.lastrowid

    def updates(self, complaint_id: int) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT id, created_at, status, message_hi, photo FROM updates WHERE complaint_id = ? ORDER BY id",
            (complaint_id,),
        ).fetchall()
        return [{**dict(r), "photo": json.loads(r["photo"]) if r["photo"] else None} for r in rows]

    def set_status(self, complaint_id: int, status: str, stage: str | None = None) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE complaints SET status = ?, stage = ? WHERE id = ?", (status, stage, complaint_id))

    def contact_hashes(self, complaint_id: int) -> set[str]:
        """Fingerprints of everyone who reported this problem: the original reporter and those merged into it."""
        rows = self._db.execute(
            "SELECT contact_hash FROM complaints WHERE (id = ? OR duplicate_of = ?) AND contact_hash IS NOT NULL",
            (complaint_id, complaint_id)).fetchall()
        return {r[0] for r in rows}

    def closed(self, department: str, days: int = 30, limit: int = 100) -> list[dict[str, Any]]:
        """Recently fixed or closed complaints, newest first: where a wrong 'fixed' is caught and reopened."""
        where, args = self._scope(department)
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        rows = self._db.execute(
            f"SELECT c.*, (SELECT COUNT(*) FROM complaints d WHERE d.duplicate_of = c.id) + 1 AS supporters"
            f" FROM complaints c WHERE status IN ('resolved', 'rejected') AND {where}"
            f" AND (SELECT MAX(created_at) FROM updates u WHERE u.complaint_id = c.id) >= ?"
            f" ORDER BY (SELECT MAX(created_at) FROM updates u WHERE u.complaint_id = c.id) DESC LIMIT ?",
            (*args, since, limit)).fetchall()
        return [self._row(r) for r in rows]

    def update(self, update_id: int) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM updates WHERE id = ?", (update_id,)).fetchone()
        return {**dict(row), "photo": json.loads(row["photo"]) if row["photo"] else None} if row else None

    def set_update_photo(self, update_id: int, photo: dict) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE updates SET photo = ? WHERE id = ?", (_dump(photo), update_id))

    # --- officer views ----------------------------------------------------------------------------

    def _scope(self, department: str) -> tuple[str, list]:
        if department == ALL_DEPARTMENTS:
            return "1=1", []
        if department == "other":  # the grievance cell also clears what the agent could not decide
            return "(category = ? OR status = 'needs_review')", [department]
        return "category = ?", [department]

    def queue(self, department: str, limit: int = 100) -> list[dict[str, Any]]:
        """Open work for one department, most urgent first, then the most-reported."""
        where, args = self._scope(department)
        rows = self._db.execute(
            f"SELECT c.*, (SELECT COUNT(*) FROM complaints d WHERE d.duplicate_of = c.id) + 1 AS supporters"
            f" FROM complaints c WHERE status IN ('open', 'in_progress', 'needs_review') AND {where}"
            f" ORDER BY {URGENCY_ORDER}, supporters DESC, id LIMIT ?",
            (*args, limit),
        ).fetchall()
        items = [self._row(r) for r in rows]
        # A complaint with no pin of its own takes the first pin among the reports joined to it.
        for c in items:
            if c["location"] is None:
                pin = self._db.execute(
                    "SELECT lat, lon, loc_accuracy FROM complaints WHERE duplicate_of = ? AND lat IS NOT NULL"
                    " ORDER BY id LIMIT 1", (c["id"],)).fetchone()
                if pin:
                    c["location"] = {"lat": pin["lat"], "lon": pin["lon"], "accuracy": pin["loc_accuracy"], "from_supporter": True}
        return items

    def stats(self, department: str, days: int = 30) -> dict[str, Any]:
        where, args = self._scope(department)
        since = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat(timespec="seconds")
        recent = f"{where} AND created_at >= ? AND duplicate_of IS NULL"
        by_status = dict(self._db.execute(
            f"SELECT status, COUNT(*) FROM complaints WHERE {recent} GROUP BY status", (*args, since)
        ).fetchall())
        # A hotspot is where reports keep coming (merged ones and fixed-then-recurring ones count too),
        # not just where something is open right now.
        areas = self._db.execute(
            # One area may be spelled several ways; show it as it was first reported.
            f"SELECT (SELECT f.area FROM complaints f WHERE f.area_key = c.area_key ORDER BY f.id LIMIT 1),"
            f" COUNT(*) AS n,"
            f" SUM(status IN ('open','in_progress') AND duplicate_of IS NULL) AS still_open,"
            f" SUM(status IN ('open','in_progress') AND duplicate_of IS NULL"
            f"     AND urgency IN ('high','critical')) AS urgent"
            f" FROM complaints c WHERE {where} AND created_at >= ? AND status != 'rejected' AND area_key != ''"
            f" GROUP BY area_key HAVING n > 1 ORDER BY n DESC, still_open DESC LIMIT 8",
            (*args, since),
        ).fetchall()
        reports = self._db.execute(
            f"SELECT COUNT(*) FROM complaints WHERE {where} AND created_at >= ? AND status != 'rejected'",
            (*args, since),
        ).fetchone()[0]
        return {
            "days": days,
            "by_status": by_status,
            "reports": reports,
            "top_areas": [{"area": a, "reports": n, "open": o or 0, "urgent": u or 0} for a, n, o, u in areas],
        }

    def insights(self, department: str, days: int = 30) -> dict[str, Any]:
        """The officer's analysis for the last `days` days: KPIs, a daily trend, department and area
        rankings, and the lists that need attention (most reported, unheard, slowest/fastest fixes)."""
        where, args = self._scope(department)
        now = datetime.now(timezone.utc)
        since = (now - timedelta(days=days)).isoformat(timespec="seconds")
        rows = [dict(r) for r in self._db.execute(
            f"SELECT id, created_at, area, area_key, status, category, urgency, duplicate_of, decision"
            f" FROM complaints WHERE {where} AND created_at >= ? AND status != 'rejected' ORDER BY id",
            (*args, since),
        ).fetchall()]
        ids = [r["id"] for r in rows]
        marks = ",".join("?" * len(ids)) or "NULL"
        first_update, fixed_at = {}, {}
        for cid, status, at in self._db.execute(
            f"SELECT complaint_id, status, created_at FROM updates WHERE complaint_id IN ({marks}) ORDER BY id", ids
        ).fetchall():
            first_update.setdefault(cid, at)
            if status == "resolved":
                fixed_at.setdefault(cid, at)
        supporters = dict(self._db.execute(
            f"SELECT duplicate_of, COUNT(*) + 1 FROM complaints WHERE duplicate_of IN ({marks}) GROUP BY duplicate_of", ids
        ).fetchall())
        span = lambda a, b: (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds()  # noqa: E731
        problems = [r for r in rows if r["duplicate_of"] is None]
        for r in problems:
            r["supporters"] = supporters.get(r["id"], 1)
            r["title_hi"] = (json.loads(r["decision"]) if r["decision"] else {}).get("title_hi", "")
            r["fix_days"] = round(span(r["created_at"], fixed_at[r["id"]]) / 86400, 1) if r["id"] in fixed_at else None
            r["response_hours"] = round(span(r["created_at"], first_update[r["id"]]) / 3600, 1) if r["id"] in first_update else None
            del r["decision"]

        def summary(group: list[dict]) -> dict[str, Any]:
            fixed = [g["fix_days"] for g in group if g["status"] == "resolved" and g["fix_days"] is not None]
            responded = [g["response_hours"] for g in group if g["response_hours"] is not None]
            resolved = sum(g["status"] == "resolved" for g in group)
            return {
                "issues": len(group),
                "reports": sum(g["supporters"] for g in group),
                "open": sum(g["status"] in OPEN_STATES for g in group),
                "resolved": resolved,
                "rate": round(100 * resolved / len(group)) if group else 0,
                "avg_days": round(sum(fixed) / len(fixed), 1) if fixed else None,
                "avg_response_hours": round(sum(responded) / len(responded), 1) if responded else None,
                "unheard": sum(g["status"] == "open" and g["response_hours"] is None for g in group),
            }

        trend = {}
        for i in range(days - 1, -1, -1):
            trend[(now - timedelta(days=i)).astimezone(IST).date().isoformat()] = {"filed": 0, "fixed": 0}
        for r in rows:
            day = datetime.fromisoformat(r["created_at"]).astimezone(IST).date().isoformat()
            if day in trend:
                trend[day]["filed"] += 1
        for at in fixed_at.values():
            day = datetime.fromisoformat(at).astimezone(IST).date().isoformat()
            if day in trend:
                trend[day]["fixed"] += 1

        by_dept: dict[str, list] = {}
        by_area: dict[str, list] = {}
        for p in problems:
            by_dept.setdefault(p["category"] or "review", []).append(p)
            if p["area_key"]:
                by_area.setdefault(p["area_key"], []).append(p)
        departments = sorted(({"category": k, **summary(v)} for k, v in by_dept.items()),
                             key=lambda d: (-d["rate"], -d["issues"]))
        ranked = [d for d in departments if d["issues"] >= 3]  # too few to judge otherwise
        if len(ranked) >= 2:
            ranked[0]["badge"], ranked[-1]["badge"] = "best", "lagging"
        areas = sorted(({"area": v[0]["area"], **summary(v)} for v in by_area.values()),
                       key=lambda a: (-a["issues"], -a["open"]))[:10]

        open_now = [p for p in problems if p["status"] in OPEN_STATES]
        waiting = lambda p: round(span(p["created_at"], now.isoformat()) / 86400, 1)  # noqa: E731
        lists = {
            "most_reported": sorted(open_now, key=lambda p: (-p["supporters"], p["id"]))[:8],
            "unheard": [{**p, "waiting_days": waiting(p)} for p in
                        sorted((p for p in open_now if p["response_hours"] is None), key=lambda p: p["created_at"])][:8],
            "recent": problems[::-1][:8],
            "times": sorted((p for p in problems if p["fix_days"] is not None), key=lambda p: p["fix_days"]),
        }
        return {"days": days, "kpis": {**summary(problems), "reports": len(rows)}, "trend": [
            {"day": d, **v} for d, v in trend.items()], "departments": departments, "areas": areas, "lists": lists}

    def places(self) -> list[dict[str, Any]]:
        """Towns with at least one report, busiest first, shown as first spelled."""
        seen: dict[str, dict[str, Any]] = {}
        for area, status in self._db.execute(
            "SELECT area, status FROM complaints WHERE status NOT IN ('rejected', 'needs_review') AND area != ''"
            " ORDER BY id"
        ).fetchall():
            town = town_of(area)
            key = area_key(town)
            if not key:
                continue
            p = seen.setdefault(key, {"place": town, "reports": 0, "open": 0})
            p["reports"] += 1
            p["open"] += status in OPEN_STATES
        return sorted(seen.values(), key=lambda p: -p["reports"])

    def public_stats(self, recent: int = 8, place: str = "") -> dict[str, Any]:
        """The public dashboard, for all of India or one town: counts, a 14-day trend, every department's
        progress and reply time, emergencies, what most people reported, and solved problems with their
        before/after photos. Titles, places, status and photos only; never report text, numbers or pins."""
        rows = self._db.execute(
            "SELECT id, created_at, area, area_key, status, category, urgency, duplicate_of, decision,"
            " contact_hash IS NOT NULL AS gave_mobile, lat IS NOT NULL AS pinned, has_photo FROM complaints"
            " WHERE status NOT IN ('rejected', 'needs_review') ORDER BY id DESC"
        ).fetchall()
        if place:
            key = area_key(place)
            rows = [r for r in rows if area_key(town_of(r["area"])) == key]
        problems = [r for r in rows if r["duplicate_of"] is None]
        fixed_at = dict(self._db.execute(
            "SELECT complaint_id, MIN(created_at) FROM updates WHERE status = 'resolved' GROUP BY complaint_id"
        ).fetchall())
        first_reply = dict(self._db.execute(
            "SELECT complaint_id, MIN(created_at) FROM updates GROUP BY complaint_id").fetchall())
        proof = dict(self._db.execute(  # the latest photo an officer sent of the work
            "SELECT complaint_id, MAX(id) FROM updates WHERE photo IS NOT NULL GROUP BY complaint_id").fetchall())
        backers: dict[int, int] = {}
        for r in rows:
            if r["duplicate_of"] is not None:
                backers[r["duplicate_of"]] = backers.get(r["duplicate_of"], 0) + 1
        hours = lambda a, b: (datetime.fromisoformat(b) - datetime.fromisoformat(a)).total_seconds() / 3600  # noqa: E731
        days = [hours(r["created_at"], fixed_at[r["id"]]) / 24
                for r in problems if r["status"] == "resolved" and r["id"] in fixed_at]
        now = datetime.now(IST)
        today = now.date()
        is_today = lambda iso: datetime.fromisoformat(iso).astimezone(IST).date() == today  # noqa: E731

        def card(r) -> dict[str, Any]:
            d = {
                "id": r["id"], "created_at": r["created_at"], "area": r["area"], "status": r["status"],
                "category": r["category"], "urgency": r["urgency"], "supporters": backers.get(r["id"], 0) + 1,
                "info_level": info_level(bool(r["gave_mobile"]), bool(r["pinned"]), bool(r["has_photo"])),
                "title_hi": (json.loads(r["decision"]) if r["decision"] else {}).get("title_hi", ""),
                "has_photo": bool(r["has_photo"]),
            }
            if r["id"] in fixed_at:
                d["fixed_at"] = fixed_at[r["id"]]
                d["fix_days"] = round(hours(r["created_at"], fixed_at[r["id"]]) / 24, 1)
            if r["id"] in proof:
                d["proof_update"] = proof[r["id"]]
            return d

        by_status: dict[str, int] = {}
        by_category: dict[str, dict[str, Any]] = {}
        for r in problems:
            by_status[r["status"]] = by_status.get(r["status"], 0) + 1
            c = by_category.setdefault(r["category"] or "other", {"total": 0, "reports": 0, "open": 0,
                                                                  "in_progress": 0, "resolved": 0, "_replies": []})
            c["total"] += 1
            c["reports"] += backers.get(r["id"], 0) + 1
            c[r["status"]] = c.get(r["status"], 0) + 1
            if r["id"] in first_reply:
                c["_replies"].append(hours(r["created_at"], first_reply[r["id"]]))
        for c in by_category.values():
            replies = c.pop("_replies")
            # Public accountability: how long a department takes to answer at all.
            c["avg_reply_hours"] = round(sum(replies) / len(replies), 1) if replies else None

        trend = {(today - timedelta(days=i)).isoformat(): {"filed": 0, "fixed": 0} for i in range(13, -1, -1)}
        for r in rows:
            day = datetime.fromisoformat(r["created_at"]).astimezone(IST).date().isoformat()
            if day in trend:
                trend[day]["filed"] += 1
        ids = {r["id"] for r in problems}
        for cid, at in fixed_at.items():
            day = datetime.fromisoformat(at).astimezone(IST).date().isoformat()
            if cid in ids and day in trend:
                trend[day]["fixed"] += 1

        open_now = [r for r in problems if r["status"] in OPEN_STATES]
        solved = sorted((r for r in problems if r["status"] == "resolved" and r["id"] in fixed_at),
                        key=lambda r: fixed_at[r["id"]], reverse=True)
        return {
            "place": place,
            "reports": len(rows),
            "problems": len(problems),
            "by_status": by_status,
            "avg_days_to_fix": round(sum(days) / len(days), 1) if days else None,
            "today": {"filed": sum(is_today(r["created_at"]) for r in rows),
                      "fixed": sum(is_today(fixed_at[i]) for i in ids if i in fixed_at)},
            "by_category": by_category,
            "trend": [{"day": d, **v} for d, v in trend.items()],
            # danger to life or health, still open: shown first and loud
            "emergency": [card(r) for r in sorted((r for r in open_now if r["urgency"] == "critical"),
                                                  key=lambda r: -(backers.get(r["id"], 0)))][:6],
            "most_reported": [card(r) for r in sorted(open_now, key=lambda r: (-(backers.get(r["id"], 0)), r["id"]))
                              if backers.get(r["id"], 0)][:5],
            "just_fixed": [card(r) for r in solved[:8]],
            "solved": [card(r) for r in solved if r["has_photo"] or r["id"] in proof][:6],
            "recent": [card(r) for r in problems[:recent]],
        }

    # --- officer accounts -------------------------------------------------------------------------

    def add_officer(self, username: str, name: str, department: str, pw_hash: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT OR REPLACE INTO officers (username, name, department, pw_hash) VALUES (?,?,?,?)",
                (username, name, department, pw_hash),
            )

    def officer(self, username: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM officers WHERE username = ?", (username,)).fetchone()
        return dict(row) if row else None

    def add_session(self, token: str, username: str, expires_at: str) -> None:
        with self._lock, self._db:
            self._db.execute("DELETE FROM sessions WHERE expires_at < ?", (_now(),))
            self._db.execute("INSERT INTO sessions VALUES (?,?,?)", (token, username, expires_at))

    def session_officer(self, token: str) -> dict[str, Any] | None:
        row = self._db.execute(
            "SELECT o.username, o.name, o.department FROM sessions s JOIN officers o USING (username)"
            " WHERE s.token = ? AND s.expires_at > ?",
            (token, _now()),
        ).fetchone()
        return dict(row) if row else None

    def close(self) -> None:
        self._db.close()

    def _row(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["has_photo"] = bool(d["has_photo"])
        for column in JSON_COLUMNS:
            d[column] = json.loads(d[column]) if d[column] else None
        d["trace"] = json.loads(d["trace"]) if d["trace"] else []
        lat, lon, acc = d.pop("lat", None), d.pop("lon", None), d.pop("loc_accuracy", None)
        d["location"] = {"lat": lat, "lon": lon, "accuracy": acc} if lat is not None else None
        d["gave_mobile"] = bool(d.pop("contact_hash", None))
        d["info_level"] = info_level(d["gave_mobile"], lat is not None, d["has_photo"])
        return d

    def by_contact(self, contact: str, limit: int = 50) -> list[dict[str, Any]]:
        """A citizen's own complaints, found by the fingerprint of their mobile number."""
        rows = self._db.execute(
            "SELECT id, created_at, status, category, duplicate_of, decision FROM complaints"
            " WHERE contact_hash = ? ORDER BY id DESC LIMIT ?", (contact, limit)).fetchall()
        return [{"id": r["id"], "created_at": r["created_at"], "status": r["status"], "category": r["category"],
                 "merged_into": r["duplicate_of"],
                 "title_hi": (json.loads(r["decision"]) if r["decision"] else {}).get("title_hi", "")} for r in rows]
