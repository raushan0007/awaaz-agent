import pytest
from fastapi.testclient import TestClient

from backend.app import auth, main, meta_client, status_writer
from backend.app.store import Store

TITLE = "वार्ड 5 में सड़क पर गड्ढे"


@pytest.fixture()
def store(tmp_path, monkeypatch):
    s = Store(tmp_path / "a.db")
    monkeypatch.setattr(main, "_store", s)
    auth.create_officer(s, "roads.officer", "Roads Officer", "roads", "road-pass")
    auth.create_officer(s, "water.officer", "Water Officer", "water", "water-pass")
    auth.create_officer(s, "grievance.officer", "Grievance Officer", "other", "grievance-pass")
    auth.create_officer(s, "district.officer", "District Officer", "all", "district-pass")
    return s


@pytest.fixture()
def client(store):
    return TestClient(main.app)


@pytest.fixture(autouse=True)
def open_model(monkeypatch):
    """Muse Spark Open stand-in: returns whatever the test sets."""
    reply = {"text": "सड़क के गड्ढे भरने का काम शुरू हो गया है। काम पूरा होने पर आपको बताया जाएगा।"}
    monkeypatch.setattr(meta_client, "ask_open", lambda messages, max_tokens=2000: reply["text"])
    return reply


def add(store, category="roads", urgency="medium", status="open", duplicate_of=None, area="Ward 5"):
    return store.add(text="sadak tooti hai", area=area, has_photo=False, status=status, category=category,
                     urgency=urgency, duplicate_of=duplicate_of,
                     decision={"title_hi": TITLE, "urgency_reason": ""}, trace=[])


def headers(client, user, password):
    r = client.post("/api/officer/login", json={"username": user, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}


def test_password_hashing():
    stored = auth.hash_password("secret")
    assert stored.startswith("pbkdf2$") and "secret" not in stored
    assert auth.check_password("secret", stored) and not auth.check_password("Secret", stored)
    assert not auth.check_password("x", "garbage")


def test_login_and_token_required(client):
    assert client.post("/api/officer/login", json={"username": "roads.officer", "password": "nope"}).status_code == 401
    assert client.post("/api/officer/login", json={"username": "ghost", "password": "nope"}).status_code == 401
    assert client.get("/api/officer/queue").status_code == 401
    assert client.get("/api/officer/queue", headers={"Authorization": "Bearer forged"}).status_code == 401
    me = client.get("/api/officer/me", headers=headers(client, "roads.officer", "road-pass")).json()
    assert me == {"username": "roads.officer", "name": "Roads Officer", "department": "roads"}


def test_queue_is_scoped_and_sorted(client, store):
    low = add(store, urgency="low")
    critical = add(store, urgency="critical")
    popular = add(store, urgency="medium")
    add(store, urgency="medium", status="merged", duplicate_of=popular)
    add(store, category="water", urgency="critical")
    add(store, status="resolved")
    review = add(store, category=None, urgency=None, status="needs_review")

    roads = client.get("/api/officer/queue", headers=headers(client, "roads.officer", "road-pass")).json()
    assert [c["id"] for c in roads] == [critical, popular, low]
    assert roads[1]["supporters"] == 2

    grievance = client.get("/api/officer/queue", headers=headers(client, "grievance.officer", "grievance-pass")).json()
    assert [c["id"] for c in grievance] == [review]
    district = client.get("/api/officer/queue", headers=headers(client, "district.officer", "district-pass")).json()
    assert len(district) == 5


def test_stats_count_areas_without_duplicates(client, store):
    first = add(store, urgency="high", area="Ward 5, Supaul")
    add(store, urgency="medium", area="ward 5 supaul")
    add(store, status="merged", duplicate_of=first, area="Ward 5, Supaul")
    add(store, area="Ward 9")
    stats = client.get("/api/officer/stats", headers=headers(client, "roads.officer", "road-pass")).json()
    assert stats["by_status"] == {"open": 3}
    assert stats["reports"] == 4
    # Ward 5 had three reports (one merged); Ward 9 had only one, so it is not a hotspot.
    assert stats["top_areas"] == [{"area": "Ward 5, Supaul", "reports": 3, "open": 2, "urgent": 1}]


def test_status_flow_reaches_citizen_and_merged_reports(client, store, open_model):
    parent = add(store)
    child = add(store, status="merged", duplicate_of=parent)
    h = headers(client, "roads.officer", "road-pass")

    r = client.post(f"/api/officer/complaints/{parent}/status", headers=h,
                    json={"status": "in_progress", "note": "JE ne site dekh li"}).json()
    assert r["written_by"] == "spark-open" and r["message_hi"] == open_model["text"]

    open_model["text"] = "Work will be done in 2 days"  # English and an invented number: falls back
    r = client.post(f"/api/officer/complaints/{parent}/status", headers=h,
                    json={"status": "resolved", "note": "patch ho gaya"}).json()
    assert r["written_by"] == "template" and TITLE in r["message_hi"]

    track = client.get(f"/api/complaints/{child}/track").json()
    assert track["merged_into"] == parent and track["status"] == "resolved" and track["supporters"] == 2
    assert [u["status"] for u in track["updates"]] == ["in_progress", "resolved"]
    assert "text" not in track  # the public page never shows the citizen's own words

    again = client.post(f"/api/officer/complaints/{parent}/status", headers=h, json={"status": "in_progress"})
    assert again.status_code == 409


def test_other_department_and_reject_rules(client, store):
    c = add(store)
    water = headers(client, "water.officer", "water-pass")
    assert client.post(f"/api/officer/complaints/{c}/status", headers=water,
                       json={"status": "resolved"}).status_code == 403
    roads = headers(client, "roads.officer", "road-pass")
    assert client.post(f"/api/officer/complaints/{c}/status", headers=roads,
                       json={"status": "rejected"}).status_code == 400
    assert client.post("/api/officer/complaints/999/status", headers=roads,
                       json={"status": "resolved"}).status_code == 404


def test_needs_review_is_routed_to_a_department(client, store):
    c = add(store, category=None, urgency=None, status="needs_review")
    h = headers(client, "grievance.officer", "grievance-pass")
    assert client.post(f"/api/officer/complaints/{c}/status", headers=h,
                       json={"status": "open"}).status_code == 400
    r = client.post(f"/api/officer/complaints/{c}/status", headers=h, json={"status": "open", "category": "drainage"})
    assert r.status_code == 200
    assert store.get(c)["category"] == "drainage" and store.get(c)["status"] == "open"


def test_status_message_checks():
    note = "JE visited"
    assert status_writer.check_message("सड़क की मरम्मत का काम शुरू हो गया है, जल्द पूरा होगा।", note) == []
    assert "not Hindi" in status_writer.check_message("Work has started.", note)
    assert status_writer.check_message("काम 3 दिन में पूरा होगा, सड़क की मरम्मत शुरू हो गई है।", note)
    assert status_writer.check_message("वार्ड 5 की सड़क की मरम्मत का काम शुरू हो गया है।", note, "वार्ड 5") == []


def test_open_model_outage_falls_back_to_template(monkeypatch):
    def down(messages, max_tokens=2000):
        raise ConnectionError("baseten down")

    monkeypatch.setattr(meta_client, "ask_open", down)
    message, source = status_writer.write_message(
        {"text": "x", "category": "water", "decision": {"title_hi": "नल में पानी नहीं"}}, "in_progress", "")
    assert source == "template" and "पेयजल" in message


def test_pages_are_served(client):
    for page in ("/officer.html", "/track.html", "/officer.js", "/track.js", "/shared.js"):
        r = client.get(page)
        assert r.status_code == 200, page
        assert r.headers["cache-control"] == "no-cache"  # a redeploy must not leave stale scripts


def test_officer_adds_a_work_photo_the_citizen_sees(client, store, tmp_path, monkeypatch):
    from backend.tests.test_photos import jpeg

    monkeypatch.setattr(main, "photos_dir", lambda: tmp_path / "photos")
    cid = add(store)
    h = headers(client, "roads.officer", "road-pass")
    r = client.post(f"/api/officer/complaints/{cid}/status", headers=h, json={"status": "in_progress"}).json()
    uid = r["update_id"]
    photo = {"photo": ("work.jpg", jpeg(), "image/jpeg")}

    assert client.post(f"/api/officer/updates/{uid}/photo", files=photo).status_code == 401
    other = headers(client, "district.officer", "district-pass")
    assert client.post(f"/api/officer/updates/{uid}/photo", headers=other, files=photo).status_code == 403

    added = client.post(f"/api/officer/updates/{uid}/photo", headers=h, files=photo)
    assert added.status_code == 200 and added.json()["photo"]["width"] == 640
    assert client.post(f"/api/officer/updates/{uid}/photo", headers=h, files=photo).status_code == 409

    track = client.get(f"/api/complaints/{cid}/track").json()
    assert track["updates"][0]["photo"]["file"] == f"u{uid}.jpg"
    served = client.get(f"/api/updates/{uid}/photo").content
    assert b"GPS" not in served and b"Exif" not in served  # metadata stripped like citizen photos
    assert client.get("/api/updates/999/photo").status_code == 404


def test_closing_a_complaint_cannot_carry_a_photo(client, store, tmp_path, monkeypatch):
    from backend.tests.test_photos import jpeg

    monkeypatch.setattr(main, "photos_dir", lambda: tmp_path / "photos")
    h = headers(client, "roads.officer", "road-pass")
    uid = client.post(f"/api/officer/complaints/{add(store)}/status", headers=h,
                      json={"status": "rejected", "note": "duplicate of a fixed road"}).json()["update_id"]
    r = client.post(f"/api/officer/updates/{uid}/photo", headers=h, files={"photo": ("w.jpg", jpeg(), "image/jpeg")})
    assert r.status_code == 409


def test_old_databases_gain_the_update_photo_column(tmp_path):
    import sqlite3

    db = sqlite3.connect(tmp_path / "old.db")
    db.executescript("CREATE TABLE updates (id INTEGER PRIMARY KEY AUTOINCREMENT, complaint_id INTEGER NOT NULL,"
                     " created_at TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',"
                     " message_hi TEXT NOT NULL DEFAULT '', officer TEXT NOT NULL DEFAULT '')")
    db.close()
    s = Store(tmp_path / "old.db")
    assert "photo" in {r["name"] for r in s._db.execute("PRAGMA table_info(updates)")}
    s.close()


def test_insights_rank_departments_and_list_what_needs_attention(client, store, open_model):
    fixed = add(store, urgency="high", area="Ward 5, Supaul")
    waiting = add(store, area="Ward 5, Supaul")
    popular = add(store, area="Ward 9, Supaul")
    add(store, status="merged", duplicate_of=popular, area="Ward 9, Supaul")
    add(store, category="water", area="Ward 2, Supaul")
    h = headers(client, "district.officer", "district-pass")
    client.post(f"/api/officer/complaints/{fixed}/status", headers=h, json={"status": "resolved", "note": "theek"})

    ins = client.get("/api/officer/insights?days=7", headers=h).json()
    assert ins["kpis"]["issues"] == 4 and ins["kpis"]["reports"] == 5 and ins["kpis"]["resolved"] == 1
    assert ins["kpis"]["rate"] == 25 and ins["kpis"]["unheard"] == 3
    assert len(ins["trend"]) == 7 and sum(d["filed"] for d in ins["trend"]) == 5
    assert sum(d["fixed"] for d in ins["trend"]) == 1
    roads = next(d for d in ins["departments"] if d["category"] == "roads")
    assert (roads["issues"], roads["resolved"], roads["rate"]) == (3, 1, 33)
    assert ins["lists"]["most_reported"][0]["id"] == popular
    assert [p["id"] for p in ins["lists"]["unheard"]] == [waiting, popular, popular + 2]
    assert [p["id"] for p in ins["lists"]["times"]] == [fixed]

    water = client.get("/api/officer/insights", headers=headers(client, "water.officer", "water-pass")).json()
    assert water["kpis"]["issues"] == 1  # an officer sees only their own department


def test_public_stats_count_without_report_text(client, store, open_model):
    fixed = add(store)
    add(store, status="merged", duplicate_of=fixed)
    add(store, category="water")
    h = headers(client, "roads.officer", "road-pass")
    client.post(f"/api/officer/complaints/{fixed}/status", headers=h, json={"status": "resolved", "note": "theek"})
    s = client.get("/api/public/stats").json()
    assert (s["reports"], s["problems"]) == (3, 2)
    assert s["by_status"] == {"resolved": 1, "open": 1}
    assert s["by_category"]["roads"]["resolved"] == 1 and s["today"] == {"filed": 3, "fixed": 1}
    assert s["avg_days_to_fix"] == 0.0
    assert [f["id"] for f in s["just_fixed"]] == [fixed]
    assert "sadak tooti hai" not in str(s)


def test_officers_see_the_pin(client, store):
    cid = store.add(text="naali jam", area="Ward 8, Forbesganj", has_photo=False, status="open", category="roads",
                    urgency="high", duplicate_of=None, decision={"title_hi": TITLE}, trace=[],
                    location={"lat": 26.31045, "lon": 87.2562, "accuracy": 9})
    queue = client.get("/api/officer/queue", headers=headers(client, "roads.officer", "road-pass")).json()
    assert next(c for c in queue if c["id"] == cid)["location"]["accuracy"] == 9
