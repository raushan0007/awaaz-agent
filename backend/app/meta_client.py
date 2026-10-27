"""Clients for Meta Model API (Muse Spark, Voice Transcribe, SAM) and Baseten (Muse Spark Open)."""

from __future__ import annotations

import json

import httpx
from openai import AsyncOpenAI, OpenAI

from .config import settings

META_BASE = "https://api.meta.ai/v1"
BASETEN_BASE = "https://inference.baseten.co/v1"
SPARK_OPEN = "meta-models/muse-spark-open-1026"
VOICE_MODEL = "muse-voice-transcribe-1.0"


def meta_client() -> OpenAI:
    # The OpenAI SDK does not read MODEL_API_KEY by itself.
    return OpenAI(base_url=META_BASE, api_key=settings.meta_api_key)


def async_meta_client() -> AsyncOpenAI:
    return AsyncOpenAI(base_url=META_BASE, api_key=settings.meta_api_key)


def baseten_client() -> OpenAI:
    return OpenAI(base_url=BASETEN_BASE, api_key=settings.baseten_api_key)


def ask_json(prompt: str, schema: dict, name: str, model: str | None = None) -> dict:
    """One Responses API call whose output is guaranteed to match `schema`."""
    settings.budget.ensure_room()
    model = model or settings.reasoning_model
    r = meta_client().responses.create(
        model=model,
        input=prompt,
        # On the Responses API this is text.format; response_format returns HTTP 400.
        text={"format": {"type": "json_schema", "name": name, "schema": schema, "strict": True}},
    )
    settings.budget.charge_tokens(model, r.usage.input_tokens, r.usage.output_tokens)
    return json.loads(r.output_text)


def ask_open(messages: list[dict], max_tokens: int = 2000) -> str:
    """Muse Spark Open on Baseten. It always reasons first, so leave room in max_tokens."""
    settings.budget.ensure_room()
    r = baseten_client().chat.completions.create(model=SPARK_OPEN, messages=messages, max_tokens=max_tokens)
    settings.budget.charge_tokens(SPARK_OPEN, r.usage.prompt_tokens, r.usage.completion_tokens)
    return (r.choices[0].message.content or "").strip()


def transcribe_wav(wav: bytes, language_bias: tuple[str, ...] = ("Hindi", "English")) -> dict:
    """Mono 16-bit PCM WAV at 16 or 24 kHz, max 10 minutes / 32 MB."""
    settings.budget.ensure_room()
    request = {
        "model": VOICE_MODEL,
        "audioEncoding": "WAV",
        "mode": "PUSH_TO_TALK",
        "languageBias": list(language_bias),
    }
    r = httpx.post(
        f"{META_BASE}/asr/transcribe",
        headers={"Authorization": f"Bearer {settings.meta_api_key}", "Accept": "application/json"},
        files={
            "request": (None, json.dumps(request), "application/json"),
            "audio": ("report.wav", wav, "audio/wav"),
        },
        timeout=120,
    )
    r.raise_for_status()
    body = r.json()
    settings.budget.charge_audio_ms(int(body.get("audioDurationMs") or 0))
    return {"transcript": body.get("transcript", ""), "duration_ms": body.get("audioDurationMs")}
