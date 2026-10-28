import json
import sqlite3
import struct
import zlib

import pytest
from fastapi.testclient import TestClient

from backend.app import agent, config, main
from backend.app.agent import AgentResult, ComplaintAgent, RunState
from backend.app.photos import PhotoError, clean_photo
from backend.app.store import Store

pytestmark = pytest.mark.anyio


def segment(marker: int, body: bytes) -> bytes:
    return b"\xff" + bytes([marker]) + struct.pack(">H", len(body) + 2) + body


def jpeg(width=640, height=480, exif=b"Exif\x00\x00GPS 25.9N 86.6E iPhone"):
    sof = b"\x08" + struct.pack(">HH", height, width) + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01"
    return (b"\xff\xd8" + segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00")
            + segment(0xE1, exif) + segment(0xFE, b"shot on my phone") + segment(0xC0, sof)
            + b"\xff\xda" + b"\x00\x08scan-data\xff\xd9")


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))


def png(width=300, height=200):
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", ihdr) + png_chunk(b"tEXt", b"GPS\x0025.9N")
            + png_chunk(b"IDAT", zlib.compress(b"\x00" * 10)) + png_chunk(b"IEND", b""))


def test_jpeg_metadata_is_stripped_and_size_read():
    clean, w, h = clean_photo(jpeg(), "image/jpeg")
    assert (w, h) == (640, 480)
    assert b"GPS" not in clean and b"iPhone" not in clean and b"my phone" not in clean
    assert b"JFIF" in clean and clean.endswith(b"scan-data\xff\xd9")


def test_png_metadata_is_stripped_and_size_read():
    clean, w, h = clean_photo(png(), "image/png")
    assert (w, h) == (300, 200)
    assert b"tEXt" not in clean and b"IDAT" in clean and clean.endswith(png_chunk(b"IEND", b""))


@pytest.mark.parametrize("data,mime", [(b"GIF89a", "image/gif"), (b"RIFF....WEBP", "image/webp"),
                                       (b"not a jpeg", "image/jpeg"), (b"\xff\xd8\xff\xd9", "image/jpeg")])
def test_bad_photos_are_rejected(data, mime):
    with pytest.raises(PhotoError):
        clean_photo(data, mime)


def test_best_evidence_picks_most_instances():
    state = RunState(segmentations=[
        {"concept": "puddle", "boxes": [{"id": "0"}], "masks": []},
        {"concept": "pothole", "boxes": [{"id": "0"}, {"id": "1"}], "masks": []},
        {"concept": "garbage", "boxes": [], "masks": []},
    ])
    assert state.best_evidence()["concept"] == "pothole"
    assert RunState().best_evidence() is None


def test_complaint_with_photo_stores_clean_photo_and_evidence(tmp_path, monkeypatch):
    monkeypatch.setattr(config.settings, "data_dir", tmp_path)
    monkeypatch.setattr(main, "_store", Store(tmp_path / "a.db"))
    seen = {}
    evidence = {"concept": "pothole", "boxes": [{"id": "0", "left": 1, "top": 2, "right": 30, "bottom": 40}],
                "masks": [{"id": "0", "width": 29, "height": 38, "path": "M0 0L1 1Z"}]}

    async def fake_run(self, report):
        seen["photo"] = report.photo
        return AgentResult("open", {"area": "Ward 5", "category": "roads", "urgency": "high",
                                    "duplicate_of": 0, "photo_matches": "yes"}, [], evidence=evidence)

    monkeypatch.setattr(ComplaintAgent, "run", fake_run)
    client = TestClient(main.app)
    body = client.post("/api/complaints", data={"text": "sadak me gaddha"},
                       files={"photo": ("p.jpg", jpeg(), "image/jpeg")}).json()
    assert b"GPS" not in seen["photo"]
    assert body["photo"] == {"file": f"{body['id']}.jpg", "width": 640, "height": 480}
    assert body["evidence"]["concept"] == "pothole"
    served = client.get(f"/api/complaints/{body['id']}/photo")
    assert served.status_code == 200 and b"GPS" not in served.content

    no_photo = client.post("/api/complaints", data={"text": "sadak me gaddha"}).json()
    assert no_photo["photo"] is None
    assert client.get(f"/api/complaints/{no_photo['id']}/photo").status_code == 404
    bad = client.post("/api/complaints", data={"text": "sadak me gaddha"},
                      files={"photo": ("p.webp", b"RIFF....WEBP", "image/webp")})
    assert bad.status_code == 400


def test_old_database_gains_new_columns(tmp_path):
    db = sqlite3.connect(tmp_path / "old.db")
    db.execute("CREATE TABLE complaints (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL,"
               " text TEXT NOT NULL, area TEXT NOT NULL DEFAULT '', area_key TEXT NOT NULL DEFAULT '',"
               " has_photo INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, category TEXT, urgency TEXT,"
               " duplicate_of INTEGER, decision TEXT, trace TEXT)")
    db.execute("INSERT INTO complaints (created_at, text, status) VALUES ('2026-10-27', 'old', 'open')")
    db.commit()
    db.close()
    store = Store(tmp_path / "old.db")
    assert store.get(1)["photo"] is None and store.get(1)["evidence"] is None
    store.close()


async def test_agent_keeps_masks_out_of_model_messages(monkeypatch, tmp_path):
    from backend.tests.test_agent import SEARCH, ScriptedClient, completion, decision

    async def fake_sam(image, mime, concept):
        return {"concept": concept, "boxes": [{"id": "0", "left": 0, "top": 0, "right": 5, "bottom": 5}],
                "masks": [{"id": "0", "width": 5, "height": 5, "path": "M0 0" * 500}]}

    monkeypatch.setattr(agent, "segment_image", fake_sam)
    monkeypatch.setattr(config.settings, "budget", config.Budget(daily_limit_usd=5, ledger_dir=tmp_path))
    client = ScriptedClient(completion(SEARCH, ("check_photo", {"concept": "pothole"})),
                            completion(("submit_decision", decision(photo_matches="yes"))))
    result = await ComplaintAgent(Store(":memory:"), client).run(agent.Report("gaddha", photo=b"jpg"))
    assert result.status == "open" and result.evidence["masks"][0]["path"].startswith("M0 0")
    assert "M0 0" not in json.dumps(client.sent[1])


@pytest.fixture()
def anyio_backend():
    return "asyncio"
