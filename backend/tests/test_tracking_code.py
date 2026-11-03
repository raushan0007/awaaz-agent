import re
import sqlite3

from backend.app import main
from backend.app.store import Store, new_code, normalize_code
from backend.tests.test_officer import TITLE, add, client, headers, open_model, store  # noqa: F401 (fixtures)

CODE = re.compile(r"^AWZ-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$")


def test_codes_are_random_readable_and_forgiving_to_type():
    codes = {new_code() for _ in range(2000)}
    assert len(codes) == 2000 and all(CODE.match(c) for c in codes)
    c = new_code()
    assert normalize_code(c.lower().replace("-", " ")) == c == normalize_code(c[4:].replace("-", ""))
    assert normalize_code("12") == normalize_code("AWZ-123") == ""


def test_the_code_is_private_and_finds_the_citizens_own_report(client, store):
    parent = add(store)
    child = store.add(text="wahi gaddha", area="Ward 5", has_photo=False, status="merged", category="roads",
                      urgency="medium", duplicate_of=parent, decision={"title_hi": TITLE}, trace=[])
    code = store.code_of(child)
    assert CODE.match(code) and code != store.code_of(parent)

    # never in a public or officer view
    assert "code" not in client.get(f"/api/complaints/{child}").json()
    assert all("code" not in c for c in client.get("/api/complaints").json())
    queue = client.get("/api/officer/queue", headers=headers(client, "roads.officer", "road-pass")).json()
    assert all("code" not in c for c in queue) and queue[0]["merged_ids"] == [child]
    public = client.get(f"/api/complaints/{child}/track").json()
    assert public["mine"] is False and "code" not in public

    mine = client.get(f"/api/track/{code[4:].lower()}").json()  # typed without prefix, in lower case
    assert mine["mine"] is True and mine["code"] == code and mine["merged_into"] == parent
    assert mine["title_hi"] == TITLE  # follows the complaint it was merged into
    assert client.get("/api/track/AWZ-2222-2222").status_code == 404


def test_the_code_proves_a_reporter_for_not_fixed(client, store, open_model):
    cid = add(store)
    client.post(f"/api/officer/complaints/{cid}/status", headers=headers(client, "roads.officer", "road-pass"),
                json={"status": "resolved", "note": "theek"})
    assert client.post(f"/api/complaints/{cid}/dispute", json={"code": new_code()}).status_code == 403
    r = client.post(f"/api/complaints/{cid}/dispute", json={"code": store.code_of(cid)})
    assert r.status_code == 200 and store.get(cid)["status"] == "open"


def test_old_databases_get_codes_and_indexes(tmp_path):
    Store(tmp_path / "a.db").add(text="x", area="", has_photo=False, status="open", category="roads",
                                 urgency="low", duplicate_of=None, decision=None, trace=[])
    db = sqlite3.connect(tmp_path / "a.db")
    db.execute("UPDATE complaints SET code = NULL")
    db.commit()
    db.close()
    s = Store(tmp_path / "a.db")  # reopening fills the gap
    assert CODE.match(s.code_of(1))
    names = {r[0] for r in s._db.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
    assert {"idx_code", "idx_duplicate", "idx_created"} <= names


def test_responses_are_compressed(client, store):
    for _ in range(12):
        add(store)
    r = client.get("/api/complaints", headers={"Accept-Encoding": "gzip"})
    assert r.headers.get("content-encoding") == "gzip"


def test_filing_returns_the_code_once(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend.app import config
    from backend.app.agent import AgentResult, ComplaintAgent

    monkeypatch.setattr(config.settings, "data_dir", tmp_path)
    monkeypatch.setattr(main, "_store", Store(tmp_path / "b.db"))

    async def fake_run(self, report):
        return AgentResult("open", {"area": "Ward 5, Supaul", "category": "roads", "urgency": "low",
                                    "duplicate_of": 0, "photo_matches": "no_photo"}, [])

    monkeypatch.setattr(ComplaintAgent, "run", fake_run)
    body = TestClient(main.app).post("/api/complaints", data={"text": "sadak tooti", "town": "Supaul"}).json()
    assert CODE.match(body["code"])
