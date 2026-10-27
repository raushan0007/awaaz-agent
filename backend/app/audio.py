"""WAV checks and a background-noise score, so only clean voice samples are kept for the demo video."""

from __future__ import annotations

import io
import json
import math
import wave
from array import array
from datetime import datetime
from pathlib import Path

from .config import IST

FRAME_MS = 30
# A sample is "good" when speech stands well clear of the background and nothing clips.
MIN_SECONDS = 1.5
MIN_SNR_DB = 20.0
MAX_NOISE_DBFS = -45.0
MAX_CLIP_RATIO = 0.001


def read_pcm16_mono(data: bytes) -> tuple[array, int]:
    with wave.open(io.BytesIO(data)) as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            raise ValueError("WAV must be mono 16-bit PCM.")
        rate = w.getframerate()
        samples = array("h", w.readframes(w.getnframes()))
    return samples, rate


def _percentile(sorted_values: list[float], p: float) -> float:
    return sorted_values[min(len(sorted_values) - 1, int(p * len(sorted_values)))]


def voice_quality(data: bytes) -> dict:
    """Noise floor = quietest 10% of 30 ms frames, speech = loudest 10%; SNR is the gap between them."""
    samples, rate = read_pcm16_mono(data)
    seconds = len(samples) / rate if rate else 0.0
    frame = max(1, rate * FRAME_MS // 1000)
    levels = []
    for start in range(0, len(samples) - frame + 1, frame):
        chunk = samples[start:start + frame]
        rms = math.sqrt(sum(s * s for s in chunk) / frame)
        levels.append(20 * math.log10(max(rms, 1.0) / 32768))
    clipped = sum(1 for s in samples if s >= 32700 or s <= -32700)
    if not levels:
        return {"seconds": round(seconds, 2), "noise_dbfs": None, "speech_dbfs": None, "snr_db": None,
                "clip_ratio": 0.0, "good": False, "problems": ["too_short"]}

    levels.sort()
    noise, speech = _percentile(levels, 0.10), _percentile(levels, 0.90)
    clip_ratio = clipped / len(samples)
    problems = []
    if seconds < MIN_SECONDS:
        problems.append("too_short")
    if noise > MAX_NOISE_DBFS:
        problems.append("noisy")
    if speech - noise < MIN_SNR_DB:
        problems.append("unclear")
    if clip_ratio > MAX_CLIP_RATIO:
        problems.append("clipping")
    return {
        "seconds": round(seconds, 2),
        "noise_dbfs": round(noise, 1),
        "speech_dbfs": round(speech, 1),
        "snr_db": round(speech - noise, 1),
        "clip_ratio": round(clip_ratio, 5),
        "good": not problems,
        "problems": problems,
    }


def save_sample(data: bytes, quality: dict, root: Path, transcript: str = "") -> Path:
    """good/ holds samples fit for the demo video; noisy/ keeps the rest for testing only."""
    folder = root / ("good" if quality["good"] else "noisy")
    folder.mkdir(parents=True, exist_ok=True)
    stem = datetime.now(IST).strftime("%Y%m%d-%H%M%S-%f")[:-3]
    path = folder / f"{stem}.wav"
    path.write_bytes(data)
    meta = {**quality, "transcript": transcript}
    path.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return path
