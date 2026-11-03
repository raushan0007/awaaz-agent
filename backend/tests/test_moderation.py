import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from backend.app import config, main, moderation
from backend.app.agent import AgentResult, ComplaintAgent
from backend.app.store import Store
from backend.tests.test_officer import add, client, headers, open_model, store  # noqa: F401 (fixtures)
from backend.tests.test_photos import jpeg

pytestmark = pytest.mark.anyio


@pytest.fixture()
def anyio_backend():
    return "asyncio"


REPORT = {"text": "ward 5 me kachra pada hai", "town": "Supaul"}


@pytest.fixture()
def app(tmp_path, monkeypatch):
    monkeypatch.setattr(config.settings, "data_dir", tmp_path)
    monkeypatch.setattr(main, "_store", Store(tmp_path / "a.db"))
    seen = {}

    async def fake_run(self, report):
        seen["photo"] = report.photo
        return AgentResult("open", {"area": "Ward 5, Supaul", "category": "sanitation", "urgency": "medium",
                                    "duplicate_of": 0, "photo_matches": "no_photo"}, [])

    monkeypatch.setattr(ComplaintAgent, "run", fake_run)
    return TestClient(main.app), seen


def photo():
    return {"photo": ("p.jpg", jpeg(), "image/jpeg")}


def test_an_unsafe_photo_never_reaches_the_agent_the_disk_or_the_public(app, safe_content, tmp_path):
    client, seen = app
    safe_content.update(photo_safe=False, photo_category="nudity_or_sexual")
    body = client.post("/api/complaints", data=REPORT, files=photo()).json()
    assert body["status"] == "open" and body["photo"] is None and not body["has_photo"]
    assert body["photo_note"] == moderation.PHOTO_BLOCKED_HI
    assert seen["photo"] is None  # not even the model saw it again
    assert not (tmp_path / "photos").exists() or not any((tmp_path / "photos").iterdir())
    assert client.get(f"/api/complaints/{body['id']}/photo").status_code == 404


def test_unsafe_text_is_refused_and_nothing_is_stored(app, safe_content):
    client, _ = app
    safe_content.update(text_safe=False, text_category="sexual_or_obscene")
    r = client.post("/api/complaints", data=REPORT, files=photo())
    assert r.status_code == 422 and r.json()["detail"] == moderation.TEXT_BLOCKED_HI
    assert client.get("/api/complaints").json() == []


def test_when_the_screen_fails_the_photo_is_dropped_but_the_complaint_is_filed(app, safe_content):
    client, seen = app
    safe_content["raise"] = RuntimeError("model down")
    body = client.post("/api/complaints", data=REPORT, files=photo()).json()
    assert body["status"] == "open" and body["photo"] is None
    assert body["photo_note"] == moderation.PHOTO_UNCHECKED_HI and seen["photo"] is None


def test_a_safe_photo_is_kept(app):
    client, seen = app
    body = client.post("/api/complaints", data=REPORT, files=photo()).json()
    assert body["photo"] and body["photo_note"] is None and seen["photo"]
    assert client.get(f"/api/complaints/{body['id']}/photo").status_code == 200


def test_a_rejected_report_keeps_no_photo(app, monkeypatch, tmp_path):
    client, _ = app

    async def reject(self, report):
        return AgentResult("rejected", {"is_valid_complaint": False, "rejection_reason": "spam"}, [])

    monkeypatch.setattr(ComplaintAgent, "run", reject)
    body = client.post("/api/complaints", data=REPORT, files=photo()).json()
    assert body["status"] == "rejected" and body["photo"] is None and not body["has_photo"]
    assert client.get(f"/api/complaints/{body['id']}/photo").status_code == 404


def test_an_officers_work_photo_is_screened_too(store, client, safe_content, tmp_path, monkeypatch):
    monkeypatch.setattr(main, "photos_dir", lambda: tmp_path / "photos")
    h = headers(client, "roads.officer", "road-pass")
    uid = client.post(f"/api/officer/complaints/{add(store)}/status", headers=h,
                      json={"status": "in_progress"}).json()["update_id"]
    safe_content.update(photo_safe=False, photo_category="graphic_violence_or_gore")
    r = client.post(f"/api/officer/updates/{uid}/photo", headers=h, files=photo())
    assert r.status_code == 422 and r.json()["detail"] == moderation.PROOF_BLOCKED
    safe_content.update(photo_safe=True, photo_category="none")
    safe_content["raise"] = RuntimeError("model down")
    assert client.post(f"/api/officer/updates/{uid}/photo", headers=h, files=photo()).status_code == 503
    assert client.get(f"/api/updates/{uid}/photo").status_code == 404  # nothing was published


class FakeAPI:
    def __init__(self, verdict):
        self.verdict, self.sent = verdict, None
        self.responses = SimpleNamespace(create=self.create)

    async def create(self, **kwargs):
        self.sent = kwargs
        return SimpleNamespace(output_text=json.dumps(self.verdict),
                               usage=SimpleNamespace(input_tokens=100, output_tokens=20))

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False


@pytest.fixture()
def real_screen(monkeypatch, tmp_path):
    """Undo the autouse stand-in, so screen() itself runs against a fake API."""
    import importlib

    monkeypatch.setattr(config.settings, "budget", config.Budget(5, tmp_path))
    return importlib.reload(moderation)


@pytest.mark.parametrize("verdict, photo_ok, text_ok", [
    ({"photo_safe": True, "photo_category": "none", "text_safe": True, "text_category": "none"}, True, True),
    # a flag that contradicts its own category counts as unsafe: doubt keeps content off the site
    ({"photo_safe": True, "photo_category": "nudity_or_sexual", "text_safe": False, "text_category": "none"},
     False, False),
])
async def test_screen_reads_doubt_as_unsafe(real_screen, monkeypatch, verdict, photo_ok, text_ok):
    api = FakeAPI(verdict)
    monkeypatch.setattr(real_screen, "async_meta_client", lambda: api)
    out = await real_screen.screen("kachra", "Ward 5", "Supaul", photo=b"jpgbytes")
    assert out["photo_safe"] is photo_ok and out["text_safe"] is text_ok
    content = api.sent["input"][0]["content"]
    assert content[1]["type"] == "input_image" and content[1]["image_url"].startswith("data:image/jpeg;base64,")
    assert api.sent["text"]["format"]["strict"] is True


async def test_screen_without_a_photo_sends_only_text(real_screen, monkeypatch):
    api = FakeAPI({"photo_safe": False, "photo_category": "other_disturbing", "text_safe": True,
                   "text_category": "none"})
    monkeypatch.setattr(real_screen, "async_meta_client", lambda: api)
    out = await real_screen.screen("kachra")
    assert out["photo_safe"] and len(api.sent["input"][0]["content"]) == 1
