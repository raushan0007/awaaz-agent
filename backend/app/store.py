"""SQLite storage for complaints. One row per citizen report; duplicates point at their parent."""

from __future__ import annotations

import json
import unicodedata
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
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
    officer TEXT NOT NULL DEFAULT ''
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
LATER_COLUMNS = {"photo": "TEXT", "evidence": "TEXT", "masked": "TEXT"}
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
        have = {r["name"] for r in self._db.execute("PRAGMA table_info(complaints)")}
        for name, kind in LATER_COLUMNS.items():
            if name not in have:
                self._db.execute(f"ALTER TABLE complaints ADD COLUMN {name} {kind}")

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

    def set_category(self, complaint_id: int, category: str) -> None:
        with self._lock, self._db:
            self._db.execute("UPDATE complaints SET category = ? WHERE id = ?", (category, complaint_id))

    # --- status updates -------------------------------------------------------------------------

    def add_update(self, complaint_id: int, status: str, note: str, message_hi: str, officer: str) -> None:
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO updates (complaint_id, created_at, status, note, message_hi, officer)"
                " VALUES (?,?,?,?,?,?)",
                (complaint_id, _now(), status, note, message_hi, officer),
            )
            self._db.execute("UPDATE complaints SET status = ? WHERE id = ?", (status, complaint_id))

    def updates(self, complaint_id: int) -> list[dict[str, Any]]:
        rows = self._db.execute(
            "SELECT created_at, status, message_hi FROM updates WHERE complaint_id = ? ORDER BY id",
            (complaint_id,),
        ).fetchall()
        return [dict(r) for r in rows]

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
