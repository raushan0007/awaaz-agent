"""Run the complaint agent live on a few sample reports against a throwaway database.

Usage: python scripts/agent_demo.py [photo.jpg]
Needs MODEL_API_KEY. Prints each decision and the agent's tool trace.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.app.agent import ComplaintAgent, Report  # noqa: E402
from backend.app.config import settings  # noqa: E402
from backend.app.store import Store  # noqa: E402

REPORTS = [
    Report("Ward 5 mein Gandhi Chowk ke paas main road pe bahut bade gaddhe hain, ek mahine se. "
           "Kal ek bike wala gir gaya.", "Ward 5, Supaul"),
    Report("गांधी चौक वार्ड 5 वाली सड़क में गड्ढे अभी तक नहीं भरे, बारिश में और खतरनाक हो गए हैं", "वार्ड 5 सुपौल"),
    Report("Sirf 999 rupaye mein loan paayein! Abhi call karein 98xxxxxx", ""),
]


async def main() -> None:
    photo = Path(sys.argv[1]).read_bytes() if len(sys.argv) > 1 else None
    if photo:
        REPORTS[0].photo = photo
    with tempfile.TemporaryDirectory() as tmp:
        store = Store(Path(tmp) / "demo.db")
        agent = ComplaintAgent(store)
        for report in REPORTS:
            result = await agent.run(report)
            d = result.decision or {}
            store.add(text=report.text, area=d.get("area") or report.area, has_photo=bool(report.photo),
                      status=result.status, category=d.get("category"), urgency=d.get("urgency"),
                      duplicate_of=d.get("duplicate_of") or None, decision=result.decision, trace=result.trace)
            print("=" * 80)
            print("REPORT:", report.text)
            print("STATUS:", result.status, "| errors:", result.errors)
            for step in result.trace:
                if "tool" in step:
                    res = step["result"]
                    short = {k: v for k, v in res.items() if k != "boxes"}
                    print(f"  turn {step['turn']} {step['tool']}({json.dumps(step['args'], ensure_ascii=False)[:160]})"
                          f" -> {json.dumps(short, ensure_ascii=False)[:200]}  [{step['model_ms']}ms]")
                else:
                    print(f"  turn {step['turn']} text: {step['note'][:160]}")
            for key in ("category", "urgency", "urgency_reason", "duplicate_of", "title_hi", "citizen_reply",
                        "rejection_reason", "formal_letter_hi"):
                if d.get(key):
                    print(f"  {key}: {d[key]}")
        store.close()
    print("=" * 80)
    print(f"spent today: ${settings.budget.spent_today():.4f}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(main())
