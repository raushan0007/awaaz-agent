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


def test_public_dashboard_shows_emergencies_backers_trend_and_before_after(client, store, open_model, tmp_path, monkeypatch):
    from backend.tests.test_photos import jpeg

    monkeypatch.setattr(main, "photos_dir", lambda: tmp_path / "photos")
    danger = add(store, urgency="critical", area="Ward 5, Supaul")
    add(store, status="merged", duplicate_of=danger, area="Ward 5, Supaul")
    add(store, status="merged", duplicate_of=danger, area="Ward 5, Supaul")
    fixed = store.add(text="gaddha", area="Ward 9, Supaul", has_photo=True, status="open", category="roads",
                      urgency="medium", duplicate_of=None, decision={"title_hi": TITLE}, trace=[])
    h = headers(client, "roads.officer", "road-pass")
    uid = client.post(f"/api/officer/complaints/{fixed}/status", headers=h,
                      json={"status": "resolved", "note": "bhar diya"}).json()["update_id"]
    client.post(f"/api/officer/updates/{uid}/photo", headers=h, files={"photo": ("w.jpg", jpeg(), "image/jpeg")})

    s = client.get("/api/public/stats").json()
    assert [e["id"] for e in s["emergency"]] == [danger] and s["emergency"][0]["supporters"] == 3
    assert [m["id"] for m in s["most_reported"]] == [danger]
    assert s["by_category"]["roads"]["reports"] == 4 and s["by_category"]["roads"]["total"] == 2
    assert len(s["trend"]) == 14 and s["trend"][-1] == {"day": s["trend"][-1]["day"], "filed": 4, "fixed": 1,
                                                       "open": 1, "in_progress": 0, "resolved": 1}
    solved = s["solved"][0]
    assert solved["id"] == fixed and solved["has_photo"] and solved["proof_update"] == uid and solved["fix_days"] == 0.0


def test_a_complaint_without_a_pin_shows_its_supporters_pin(client, store):
    parent = add(store, area="Ward 8, Forbesganj")
    store.add(text="wahi kooda", area="Ward 8, Forbesganj", has_photo=False, status="merged", category="roads",
              urgency="medium", duplicate_of=parent, decision={"title_hi": TITLE}, trace=[],
              location={"lat": 26.311235, "lon": 87.260094, "accuracy": 11})
    queue = client.get("/api/officer/queue", headers=headers(client, "roads.officer", "road-pass")).json()
    loc = next(c for c in queue if c["id"] == parent)["location"]
    assert loc == {"lat": 26.311235, "lon": 87.260094, "accuracy": 11, "from_supporter": True}


def test_a_wrong_fix_is_reopened_with_a_reason_and_seen_in_closed_work(client, store, open_model):
    cid = add(store)
    h = headers(client, "roads.officer", "road-pass")
    client.post(f"/api/officer/complaints/{cid}/status", headers=h, json={"status": "resolved", "note": "bhar diya"})
    closed = client.get("/api/officer/queue?closed=1", headers=h).json()
    assert [c["id"] for c in closed] == [cid]
    assert client.post(f"/api/officer/complaints/{cid}/status", headers=h, json={"status": "reopened"}).status_code == 400
    r = client.post(f"/api/officer/complaints/{cid}/status", headers=h,
                    json={"status": "reopened", "note": "site par gaddha abhi bhi hai"})
    assert r.status_code == 200
    assert store.get(cid)["status"] == "open"
    assert [u["status"] for u in client.get(f"/api/complaints/{cid}/track").json()["updates"]] == ["resolved", "reopened"]
    assert cid in [c["id"] for c in client.get("/api/officer/queue", headers=h).json()]


def test_queue_flags_work_left_idle_too_long(client, store):
    old = add(store)
    store._db.execute("UPDATE complaints SET created_at = '2026-01-01T00:00:00+00:00' WHERE id = ?", (old,))
    store._db.commit()
    fresh = add(store)
    q = {c["id"]: c for c in client.get("/api/officer/queue", headers=headers(client, "roads.officer", "road-pass")).json()}
    assert q[old]["overdue"] is True and q[old]["idle_days"] > 3
    assert q[fresh]["overdue"] is False


def test_export_is_a_spreadsheet_excel_reads_in_hindi(client, store):
    add(store)
    r = client.get("/api/officer/export.csv", headers=headers(client, "roads.officer", "road-pass"))
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    text = r.content.decode("utf-8")
    assert text.startswith("﻿id,filed_at") and TITLE in text
    assert client.get("/api/officer/export.csv").status_code == 401


def test_only_a_reporter_can_say_it_is_not_fixed(client, store, open_model, tmp_path, monkeypatch):
    from backend.app import config
    from backend.app.privacy import contact_hash

    monkeypatch.setattr(config.settings, "data_dir", tmp_path)
    salt = config.settings.contact_salt
    cid = store.add(text="gaddha", area="Ward 5", has_photo=False, status="open", category="roads", urgency="medium",
                    duplicate_of=None, decision={"title_hi": TITLE}, trace=[], contact=contact_hash("9876543210", salt))
    child = store.add(text="wahi gaddha", area="Ward 5", has_photo=False, status="merged", category="roads",
                      urgency="medium", duplicate_of=cid, decision={"title_hi": TITLE}, trace=[],
                      contact=contact_hash("9123456789", salt))
    body = {"mobile": "9123456789", "note": "gaddha abhi bhi hai, call 9988776655"}
    assert client.post(f"/api/complaints/{child}/dispute", json=body).status_code == 409  # not marked fixed yet
    client.post(f"/api/officer/complaints/{cid}/status", headers=headers(client, "roads.officer", "road-pass"),
                json={"status": "resolved", "note": "theek"})
    assert client.post(f"/api/complaints/{cid}/dispute", json={"mobile": "9000000000"}).status_code == 403
    r = client.post(f"/api/complaints/{child}/dispute", json=body)  # a merged supporter may dispute too
    assert r.status_code == 200 and store.get(cid)["status"] == "open"
    assert "9988776655" not in r.text and "छिपाया" in r.text


def test_work_moves_forward_stage_by_stage_and_the_citizen_sees_each(client, store, open_model):
    cid = add(store)
    h = headers(client, "roads.officer", "road-pass")
    step = lambda s, note="": client.post(f"/api/officer/complaints/{cid}/status", headers=h, json={"status": s, "note": note})
    assert step("inspected", "JE ne site dekhi").status_code == 200
    assert (store.get(cid)["status"], store.get(cid)["stage"]) == ("in_progress", "inspected")
    assert step("inspected").status_code == 409  # no going back or repeating
    assert step("approved", "patch ka kaam manzoor").status_code == 200
    track = client.get(f"/api/complaints/{cid}/track").json()
    assert track["stage"] == "approved" and [u["status"] for u in track["updates"]] == ["inspected", "approved"]
    assert step("resolved", "bhar diya").status_code == 200  # skipping 'work started' is allowed
    assert (store.get(cid)["status"], store.get(cid)["stage"]) == ("resolved", "resolved")
    assert step("reopened", "phir se gaddha").status_code == 200
    assert (store.get(cid)["status"], store.get(cid)["stage"]) == ("open", None)


def test_daily_trend_tracks_each_day_end_state():
    from backend.app.store import _day_trend
    days = ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]
    reports = [{"created_at": "2026-10-01T05:00:00+00:00"}, {"created_at": "2026-10-01T06:00:00+00:00"},
               {"created_at": "2026-10-02T05:00:00+00:00"}, {"created_at": "2026-10-03T05:00:00+00:00"}]
    problems = [{"id": 1, "created_at": "2026-10-01T05:00:00+00:00"}, {"id": 2, "created_at": "2026-10-02T05:00:00+00:00"},
                {"id": 3, "created_at": "2026-10-03T05:00:00+00:00"}]
    history = {1: [("2026-10-01T09:00:00+00:00", "inspected"), ("2026-10-02T09:00:00+00:00", "resolved"),
                   ("2026-10-03T09:00:00+00:00", "reopened")],
               2: [("2026-10-03T09:00:00+00:00", "resolved")],
               3: [("2026-10-04T09:00:00+00:00", "rejected")]}
    t = {d["day"]: d for d in _day_trend(days, reports, problems, history)}
    assert [t[d]["filed"] for d in days] == [2, 1, 1, 0]
    assert [t[d]["fixed"] for d in days] == [0, 1, 1, 0]
    # day 1: #1 work on; day 2: #1 fixed, #2 open; day 3: #1 reopened, #2 fixed, #3 open; day 4: #3 rejected drops out
    assert [(t[d]["open"], t[d]["in_progress"], t[d]["resolved"]) for d in days] == [(0, 1, 0), (1, 0, 1), (2, 0, 1), (1, 0, 1)]


def test_dashboards_trend_ends_where_the_status_counts_are(client, store, open_model):
    a, b = add(store), add(store, area="Ward 6")
    add(store, duplicate_of=a)
    h = headers(client, "district.officer", "district-pass")
    assert client.post(f"/api/officer/complaints/{b}/status", json={"status": "resolved", "note": "theek"}, headers=h).status_code == 200
    pub = client.get("/api/public/stats").json()
    end = pub["trend"][-1]
    assert end["filed"] == 3 and end["fixed"] == 1
    assert {k: end[k] for k in ("open", "in_progress", "resolved")} == {"open": 1, "in_progress": 0, "resolved": 1}
    ins = client.get("/api/officer/insights?days=7", headers=h).json()
    assert {k: ins["trend"][-1][k] for k in ("open", "in_progress", "resolved")} == {"open": 1, "in_progress": 0, "resolved": 1}


def test_dashboard_narrows_to_one_department_but_keeps_the_comparison(client, store):
    add(store, category="roads")
    add(store, category="roads", status="in_progress")
    add(store, category="water")
    add(store, category=None, urgency=None, status="needs_review")
    h = headers(client, "district.officer", "district-pass")

    whole = client.get("/api/officer/insights", headers=h).json()
    assert whole["kpis"]["issues"] == 4 and whole["focus"] == ""
    roads = client.get("/api/officer/insights?dept=roads", headers=h).json()
    assert roads["kpis"]["issues"] == 2 and roads["kpis"]["in_progress"] == 1
    assert roads["trend"][-1]["open"] + roads["trend"][-1]["in_progress"] == 2  # the chart follows the filter
    assert {d["category"] for d in roads["departments"]} == {"roads", "water", "review"}  # all still compared
    review = client.get("/api/officer/insights?dept=review", headers=h).json()
    assert review["kpis"]["issues"] == 1
    assert client.get("/api/officer/stats?dept=water", headers=h).json()["by_status"] == {"open": 1}

    assert client.get("/api/officer/insights?dept=nope", headers=h).status_code == 400
    own = headers(client, "roads.officer", "road-pass")
    assert client.get("/api/officer/insights?dept=water", headers=own).status_code == 403
    assert client.get("/api/officer/insights?dept=roads", headers=own).status_code == 200
    cell = headers(client, "grievance.officer", "grievance-pass")
    assert client.get("/api/officer/stats?dept=review", headers=cell).status_code == 200


def test_short_windows_count_by_the_hour_and_by_five_minutes(client, store):
    add(store)
    h = headers(client, "district.officer", "district-pass")
    hour = client.get("/api/officer/insights?hours=1", headers=h).json()
    assert hour["hours"] == 1 and len(hour["trend"]) == 12 and hour["trend"][-1]["unit"] == "5min"
    assert hour["trend"][-1]["filed"] == 1 and hour["kpis"]["issues"] == 1
    day = client.get("/api/officer/insights?hours=24", headers=h).json()
    assert len(day["trend"]) == 24 and day["trend"][-1]["unit"] == "hour" and day["trend"][-1]["open"] == 1
    assert client.get("/api/officer/insights?days=7", headers=h).json()["trend"][-1]["unit"] == "day"
    assert client.get("/api/officer/stats?hours=1", headers=h).json()["by_status"] == {"open": 1}


def test_pulse_names_new_complaints_for_the_bell(client, store):
    first = add(store)
    h = headers(client, "roads.officer", "road-pass")
    assert client.get("/api/officer/pulse", headers=h).json() == {"latest": first, "new": []}
    second = add(store)
    add(store, category="water")  # another department: not this officer's bell
    p = client.get(f"/api/officer/pulse?after={first}", headers=h).json()
    assert p["latest"] == second and [n["id"] for n in p["new"]] == [second] and p["new"][0]["title_hi"] == TITLE
    assert client.get("/api/officer/pulse").status_code == 401


def test_a_login_survives_a_restart_and_cannot_be_forged(tmp_path):
    from backend.app.store import Store as S

    first = S(tmp_path / "a.db")
    auth.create_officer(first, "roads.officer", "Roads Officer", "roads", "road-pass")
    token, _ = auth.login(first, "roads.officer", "road-pass")
    first.close()
    # a restart: a fresh database with the officer created again (new password hash), the same token still works
    again = S(tmp_path / "b.db")
    auth.create_officer(again, "roads.officer", "Roads Officer", "roads", "road-pass")
    assert auth.officer_for(again, token)["department"] == "roads"
    name, expires, sig = token.split(".")
    forged_name = auth.make_token("district.officer").split(".")[0]
    assert auth.officer_for(again, f"{forged_name}.{expires}.{sig}") is None  # a changed name breaks the signature
    assert auth.officer_for(again, f"{name}.{int(expires) + 99999}.{sig}") is None  # so does a longer expiry
    assert auth.officer_for(again, auth.make_token("roads.officer", hours=-1)) is None  # expired
    assert auth.officer_for(again, "garbage") is None
