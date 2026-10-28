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
    evidence TEXT
);
CREATE INDEX IF NOT EXISTS idx_open ON complaints(status, category, area_key);
"""
# Columns added after the first release, so databases made earlier keep working.
LATER_COLUMNS = {"photo": "TEXT", "evidence": "TEXT"}
JSON_COLUMNS = ("decision", "photo", "evidence")

# open: routed to a department; merged: a duplicate of an open complaint; rejected: failed
# verification (spam, not civic); needs_review: the agent could not reach a valid decision.
OPEN_STATES = ("open",)
NUMBER_WORDS = {"no", "number", "नं", "नंबर"}


def area_key(area: str) -> str:
    """'Ward No. 5, Supaul ' -> 'ward 5 supaul', so spelling noise does not split one area in two."""
    # Not `\w`: it misses Devanagari vowel signs, which would split "वार्ड" into letters.
    text = "".join(" " if unicodedata.category(ch)[0] in "PSZ" else ch for ch in area.lower())
    return " ".join(w for w in text.split() if w not in NUMBER_WORDS)


def _dump(value: dict | None) -> str | None:
    return json.dumps(value, ensure_ascii=False) if value is not None else None


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
            evidence: dict | None = None) -> int:
        with self._lock, self._db:
            cur = self._db.execute(
                "INSERT INTO complaints (created_at, text, area, area_key, has_photo, status, category,"
                " urgency, duplicate_of, decision, trace, evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    datetime.now(timezone.utc).isoformat(timespec="seconds"),
                    text, area, area_key(area), int(has_photo), status, category, urgency, duplicate_of,
                    _dump(decision), json.dumps(trace, ensure_ascii=False), _dump(evidence),
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

    def close(self) -> None:
        self._db.close()

    def _row(self, row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["has_photo"] = bool(d["has_photo"])
        for column in JSON_COLUMNS:
            d[column] = json.loads(d[column]) if d[column] else None
        d["trace"] = json.loads(d["trace"]) if d["trace"] else []
        return d
