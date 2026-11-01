import io
import json
import math
import random
import wave

import pytest
from fastapi.testclient import TestClient

from backend.app import config, main
from backend.app.audio import voice_quality

RATE = 16000


def wav(samples, rate=RATE, channels=1):
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(int(s).to_bytes(2, "little", signed=True) for s in samples))
    return buf.getvalue()


def speech_like(seconds=3.0, noise_amp=10, voice_amp=8000, rng=None):
    """Half pauses, half 'speech' (a 220 Hz tone), with background noise throughout."""
    rng = rng or random.Random(1)
    out = []
    for i in range(int(seconds * RATE)):
        talking = (i // (RATE // 4)) % 2 == 0
        s = voice_amp * math.sin(2 * math.pi * 220 * i / RATE) if talking else 0
        out.append(max(-32768, min(32767, s + rng.uniform(-noise_amp, noise_amp))))
    return out


def test_clean_recording_is_good():
    q = voice_quality(wav(speech_like()))
    assert q["good"] is True, q
    assert q["snr_db"] > 40


def test_noisy_recording_is_flagged():
    q = voice_quality(wav(speech_like(noise_amp=3000)))
    assert q["good"] is False
    assert "noisy" in q["problems"]


def test_short_and_clipped_recordings():
    assert "too_short" in voice_quality(wav(speech_like(seconds=0.5)))["problems"]
    assert "clipping" in voice_quality(wav(speech_like(voice_amp=40000)))["problems"]


def test_stereo_is_rejected():
    with pytest.raises(ValueError):
        voice_quality(wav([0] * 3200, channels=2))


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(config.settings, "samples_dir", tmp_path / "samples")
    return TestClient(main.app)


def test_voice_sample_endpoint_sorts_good_and_noisy(client, tmp_path):
    good = client.post("/api/voice-samples", files={"audio": ("a.wav", wav(speech_like()), "audio/wav")},
                       data={"transcript": "सड़क टूटी है"}).json()
    noisy = client.post("/api/voice-samples",
                        files={"audio": ("b.wav", wav(speech_like(noise_amp=3000)), "audio/wav")}).json()
    assert good["saved_as"].startswith("good/") and noisy["saved_as"].startswith("noisy/")
    meta = json.loads((tmp_path / "samples" / good["saved_as"]).with_suffix(".json").read_text(encoding="utf-8"))
    assert meta["transcript"] == "सड़क टूटी है"
    assert client.post("/api/voice-samples", files={"audio": ("c.mp3", b"ID3...", "audio/mpeg")}).status_code == 400


def test_hosted_copy_keeps_no_voice_samples(monkeypatch):
    monkeypatch.setattr(config.settings, "samples_dir", None)
    client = TestClient(main.app)
    r = client.post("/api/voice-samples", files={"audio": ("a.wav", wav(speech_like()), "audio/wav")})
    assert r.status_code == 404
    assert client.get("/api/health").json()["keeps_voice_samples"] is False


def test_frontend_is_served(client):
    r = client.get("/")
    assert r.status_code == 200 and "Awaaz" in r.text
    assert client.get("/recorder.js").status_code == 200
    assert client.get("/api/health").json()["ok"] is True
