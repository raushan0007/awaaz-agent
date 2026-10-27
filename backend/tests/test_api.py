import io
import struct

import pytest
from fastapi.testclient import TestClient

from backend.app import config, main


@pytest.fixture()
def budget(tmp_path, monkeypatch):
    b = config.Budget(daily_limit_usd=0.01, ledger_dir=tmp_path)
    monkeypatch.setattr(config.settings, "budget", b)
    return b


@pytest.fixture()
def client(budget):
    return TestClient(main.app)


def wav_bytes(seconds=0.1, rate=16000):
    frames = b"\x00\x00" * int(seconds * rate)
    header = b"RIFF" + struct.pack("<I", 36 + len(frames)) + b"WAVE"
    fmt = b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    return header + fmt + b"data" + struct.pack("<I", len(frames)) + frames


def test_budget_accumulates_and_blocks(budget):
    budget.charge_tokens("muse-spark-1.3", 1000, 1000)  # $0.0055
    assert budget.spent_today() == pytest.approx(0.0055)
    budget.ensure_room()
    budget.charge_images(2)  # +$0.005 -> over $0.01
    with pytest.raises(config.BudgetExceeded):
        budget.ensure_room()


def test_audio_and_unknown_model_pricing(budget):
    budget.charge_audio_ms(3_600_000)
    assert budget.spent_today() == pytest.approx(0.18)
    fresh = config.Budget(daily_limit_usd=1, ledger_dir=budget.ledger_dir / "x")
    fresh.charge_tokens("some-new-model", 1_000_000, 0)
    assert fresh.spent_today() == pytest.approx(1.25)


def test_health_reports_budget(client):
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["daily_limit_usd"] == 0.01


def test_transcribe_rejects_non_wav(client):
    r = client.post("/api/transcribe", files={"audio": ("a.mp3", b"ID3....", "audio/mpeg")})
    assert r.status_code == 400


def test_transcribe_passes_wav_to_voice_model(client, monkeypatch):
    seen = {}

    def fake(wav):
        seen["len"] = len(wav)
        return {"transcript": "sadak tooti hai", "duration_ms": 100}

    monkeypatch.setattr(main, "transcribe_wav", fake)
    wav = wav_bytes()
    r = client.post("/api/transcribe", files={"audio": ("r.wav", wav, "audio/wav")})
    assert r.status_code == 200
    assert r.json()["transcript"] == "sadak tooti hai"
    assert seen["len"] == len(wav)


def test_evidence_validates_input(client):
    jpg = io.BytesIO(b"\xff\xd8\xff" + b"0" * 10)
    r = client.post("/api/evidence", files={"photo": ("p.gif", jpg, "image/gif")}, data={"concept": "pothole"})
    assert r.status_code == 400
    r = client.post("/api/evidence", files={"photo": ("p.jpg", b"x", "image/jpeg")}, data={"concept": " "})
    assert r.status_code == 400


def test_evidence_found_flag_and_budget_block(client, budget, monkeypatch):
    async def fake(image, mime, concept):
        return {"concept": concept, "boxes": [{"id": "1"}], "masks": []}

    monkeypatch.setattr(main, "segment_image", fake)
    r = client.post("/api/evidence", files={"photo": ("p.jpg", b"x", "image/jpeg")}, data={"concept": "pothole"})
    assert r.status_code == 200 and r.json()["found"] is True

    budget.charge_images(10)
    r = client.post("/api/evidence", files={"photo": ("p.jpg", b"x", "image/jpeg")}, data={"concept": "pothole"})
    assert r.status_code == 429
