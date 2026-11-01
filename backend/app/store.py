"""SQLite storage for complaints. One row per citizen report; duplicates point at their parent."""

from __future__ import annotations

import json
import unicodedata
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

IST = timezone(timedelta(hours=5, minutes=30))
from pathlib import Path
from typing import Any

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
    "complaints": {"photo": "TEXT", "evidence": "TEXT", "masked": "TEXT"},
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
            evidence: dict | None = None, masked: list[str] | None = None) -> int:
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO complaints (created_at, text, area, area_key, has_photo, status, category,"
                " urgency, duplicate_of, decision, trace, evidence, masked) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    text, area, area_key(area), int(has_photo), status, category, urgency, duplicate_of,
                    _dump(decision), json.dumps(trace, ensure_ascii=False), _dump(evidence),
                    json.dumps(masked or []),
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
        return [self._row(r) for r in rows]

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

    def public_stats(self, recent: int = 8) -> dict[str, Any]:
        """What the home page shows anyone: counts, per-department progress and the latest problems.

        Titles, places and status only, never report text or photos."""
        rows = self._db.execute(
            "SELECT id, created_at, area, status, category, urgency, duplicate_of, decision FROM complaints"
            " WHERE status NOT IN ('rejected', 'needs_review') ORDER BY id DESC"
        ).fetchall()
        problems = [r for r in rows if r["duplicate_of"] is None]
        fixed_at = dict(self._db.execute(
            "SELECT complaint_id, MIN(created_at) FROM updates WHERE status = 'resolved' GROUP BY complaint_id"
        ).fetchall())
        days = [
            (datetime.fromisoformat(fixed_at[r["id"]]) - datetime.fromisoformat(r["created_at"])).total_seconds() / 86400
            for r in problems if r["status"] == "resolved" and r["id"] in fixed_at
        ]
        today = (datetime.now(IST)).date()
        is_today = lambda iso: datetime.fromisoformat(iso).astimezone(IST).date() == today  # noqa: E731
        by_status: dict[str, int] = {}
        by_category: dict[str, dict[str, int]] = {}
        for r in problems:
            by_status[r["status"]] = by_status.get(r["status"], 0) + 1
            c = by_category.setdefault(r["category"] or "other", {"total": 0, "open": 0, "in_progress": 0, "resolved": 0})
            c["total"] += 1
            c[r["status"]] = c.get(r["status"], 0) + 1
        return {
            "reports": len(rows),
            "problems": len(problems),
            "by_status": by_status,
            "avg_days_to_fix": round(sum(days) / len(days), 1) if days else None,
            "today": {"filed": sum(is_today(r["created_at"]) for r in rows),
                      "fixed": sum(is_today(t) for t in fixed_at.values())},
            "by_category": by_category,
            "just_fixed": [
                {"id": r["id"], "area": r["area"], "category": r["category"], "fixed_at": fixed_at[r["id"]],
                 "title_hi": (json.loads(r["decision"]) if r["decision"] else {}).get("title_hi", "")}
                for r in sorted((r for r in problems if r["status"] == "resolved" and r["id"] in fixed_at),
                                key=lambda r: fixed_at[r["id"]], reverse=True)[:8]
            ],
            "recent": [
                {
                    "id": r["id"], "created_at": r["created_at"], "area": r["area"], "status": r["status"],
                    "category": r["category"], "urgency": r["urgency"], "supporters": self.supporters(r["id"]),
                    "title_hi": (json.loads(r["decision"]) if r["decision"] else {}).get("title_hi", ""),
                }
                for r in problems[:recent]
            ],
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
        return d
