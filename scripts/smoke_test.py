"""Hit every model Awaaz depends on once and print a pass/fail line per model.

Usage: python scripts/smoke_test.py <sample.wav> <image.jpg>
Keys come from MODEL_API_KEY and BASETEN_API_KEY.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import httpx
from openai import OpenAI

META_BASE = "https://api.meta.ai/v1"
BASETEN_BASE = "https://inference.baseten.co/v1"


def check(name, fn):
    start = time.perf_counter()
    try:
        detail = fn()
        print(f"PASS  {name:<22} {time.perf_counter() - start:5.1f}s  {detail}")
        return True
    except Exception as exc:  # noqa: BLE001 - report every failure, keep going
        print(f"FAIL  {name:<22} {type(exc).__name__}: {str(exc)[:300]}")
        return False


def spark_text():
    client = OpenAI(base_url=META_BASE, api_key=os.environ["MODEL_API_KEY"])
    r = client.responses.create(
        model="muse-spark-1.3",
        input="Translate to formal Hindi in one sentence: 'The road near my house is broken.'",
    )
    return r.output_text.strip()[:120]


def spark_json():
    client = OpenAI(base_url=META_BASE, api_key=os.environ["MODEL_API_KEY"])
    schema = {
        "type": "object",
        "properties": {
            "department": {"type": "string", "enum": ["roads", "water", "electricity", "sanitation"]},
            "urgency": {"type": "string", "enum": ["low", "medium", "high"]},
        },
        "required": ["department", "urgency"],
        "additionalProperties": False,
    }
    r = client.responses.create(
        model="muse-spark-1.3",
        input="Complaint: 'Mohalle mein 3 din se paani nahi aa raha, bachche beemar hain.'",
        text={"format": {"type": "json_schema", "name": "triage", "schema": schema, "strict": True}},
    )
    return json.loads(r.output_text)


def voice(wav: Path):
    request = {
        "model": "muse-voice-transcribe-1.0",
        "audioEncoding": "WAV",
        "mode": "PUSH_TO_TALK",
        "languageBias": ["Hindi", "English"],
    }
    r = httpx.post(
        f"{META_BASE}/asr/transcribe",
        headers={"Authorization": f"Bearer {os.environ['MODEL_API_KEY']}", "Accept": "application/json"},
        files={
            "request": (None, json.dumps(request), "application/json"),
            "audio": (wav.name, wav.read_bytes(), "audio/wav"),
        },
        timeout=120,
    )
    r.raise_for_status()
    body = r.json()
    return f"{body.get('audioDurationMs')}ms -> {body.get('transcript', '')[:120]!r}"


def sam(image: Path):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from backend.app.vision import segment_image

    result = asyncio.run(segment_image(image.read_bytes(), "image/jpeg", "duck"))
    return f"{len(result['boxes'])} box(es), {len(result['masks'])} mask(s)"


def spark_open():
    client = OpenAI(base_url=BASETEN_BASE, api_key=os.environ["BASETEN_API_KEY"])
    r = client.chat.completions.create(
        model="meta-models/muse-spark-open-1026",
        messages=[{"role": "user", "content": "Reply with one Hindi word meaning 'ready'."}],
        max_tokens=1500,
    )
    return r.choices[0].message.content.strip()


def main() -> int:
    wav, image = Path(sys.argv[1]), Path(sys.argv[2])
    results = [
        check("muse-spark-1.3 text", spark_text),
        check("muse-spark-1.3 json", spark_json),
        check("voice-transcribe", lambda: voice(wav)),
        check("sam-3.1", lambda: sam(image)),
        check("spark-open (baseten)", spark_open),
    ]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
