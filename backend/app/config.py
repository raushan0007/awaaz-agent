"""Settings and the daily spend guard. The Meta API has no hard spend cap, so we keep our own."""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path

IST = timezone(timedelta(hours=5, minutes=30))

# USD per 1M tokens (input, output), per image, per audio hour. From dev.meta.ai pricing, Oct 2026.
TOKEN_PRICES = {
    "muse-spark-1.3": (1.25, 4.25),
    "muse-wonder-1.0": (4.00, 20.00),
    # Baseten bills from its own $100 credit; tracked so the guard sees it.
    "meta-models/muse-spark-open-1026": (1.25, 4.25),
}
SAM_PER_IMAGE = 2.50 / 1000
VOICE_PER_HOUR = 0.18


class BudgetExceeded(RuntimeError):
    pass


@dataclass
class Budget:
    daily_limit_usd: float
    ledger_dir: Path
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def _ledger(self) -> Path:
        return self.ledger_dir / f"spend-{datetime.now(IST):%Y-%m-%d}.json"

    def spent_today(self) -> float:
        path = self._ledger()
        return json.loads(path.read_text())["usd"] if path.exists() else 0.0

    def ensure_room(self) -> None:
        if self.spent_today() >= self.daily_limit_usd:
            raise BudgetExceeded(
                f"Daily AI budget of ${self.daily_limit_usd:.2f} used up; resets at midnight IST."
            )

    def _add(self, usd: float) -> None:
        with self._lock:
            self.ledger_dir.mkdir(parents=True, exist_ok=True)
            total = self.spent_today() + usd
            self._ledger().write_text(json.dumps({"usd": round(total, 6)}))

    def charge_tokens(self, model: str, input_tokens: int, output_tokens: int) -> None:
        price_in, price_out = TOKEN_PRICES.get(model, TOKEN_PRICES["muse-spark-1.3"])
        self._add((input_tokens * price_in + output_tokens * price_out) / 1_000_000)

    def charge_images(self, count: int) -> None:
        self._add(count * SAM_PER_IMAGE)

    def charge_audio_ms(self, ms: int) -> None:
        self._add(ms / 3_600_000 * VOICE_PER_HOUR)


@dataclass
class Settings:
    meta_api_key: str = field(default_factory=lambda: os.environ.get("MODEL_API_KEY", ""))
    baseten_api_key: str = field(default_factory=lambda: os.environ.get("BASETEN_API_KEY", ""))
    reasoning_model: str = field(default_factory=lambda: os.environ.get("AWAAZ_MODEL", "muse-spark-1.3"))
    data_dir: Path = field(
        default_factory=lambda: Path(os.environ.get("AWAAZ_DATA_DIR", Path(__file__).resolve().parents[1] / "data"))
    )
    samples_dir: Path | None = field(init=False)
    budget: Budget = field(init=False)

    def __post_init__(self) -> None:
        limit = float(os.environ.get("AWAAZ_DAILY_BUDGET_USD", "3"))
        self.budget = Budget(daily_limit_usd=limit, ledger_dir=self.data_dir)
        # Voice samples are kept only where a folder is named for them (the author's own machine),
        # never on a hosted copy where citizens speak.
        samples = os.environ.get("AWAAZ_SAMPLES_DIR", "")
        self.samples_dir = Path(samples) if samples else None


settings = Settings()
