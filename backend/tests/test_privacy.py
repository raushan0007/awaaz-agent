import re

import pytest
from fastapi.testclient import TestClient

from backend.app import main
from backend.app.agent import AgentResult, ComplaintAgent
from backend.app.privacy import mask_pii
from backend.app.store import Store


@pytest.mark.parametrize("text,kind", [
    ("Mera number 9876543210 hai", "mobile"),
    ("मेरा नंबर +91 98765 43210 है", "mobile"),
    ("phone 09876543210", "mobile"),
    ("call ९८७६५४३२१० pe", "mobile"),
    ("Aadhaar 2345 6789 0123", "aadhaar"),
    ("aadhaar 234567890123", "aadhaar"),
    ("mail ram.k@gmail.com", "email"),
    ("PAN ABCDE1234F", "pan"),
])
def test_personal_numbers_are_hidden(text, kind):
    masked, found = mask_pii(text)
    assert found == [kind]
    assert "छिपाया गया" in masked
    assert not re.search(r"\d{4}", masked)  # no part of the number survives


@pytest.mark.parametrize("text", [
    "Ward 12 mein 3 din se 10000 log pareshan",
    "पिन 852131, वार्ड 5",
    "Gaddha 2 feet gehra aur 15 feet lamba hai",
    "Transformer 2024 se kharab hai",
])
def test_ordinary_numbers_stay(text):
    assert mask_pii(text) == (text, [])


def test_filed_complaint_is_masked_everywhere(tmp_path, monkeypatch):
    store = Store(tmp_path / "a.db")
    monkeypatch.setattr(main, "_store", store)
    seen = {}

    async def fake_run(self, report):
        seen["text"], seen["area"] = report.text, report.area
        return AgentResult("open", {"area": report.area, "category": "roads", "urgency": "medium",
                                    "duplicate_of": 0}, [])

    monkeypatch.setattr(ComplaintAgent, "run", fake_run)
    body = TestClient(main.app).post("/api/complaints", data={
        "text": "Sadak tooti hai, mujhe 9876543210 par call karein", "area": "Ward 5, ram@x.in"}).json()
    assert "9876543210" not in seen["text"] and "ram@x.in" not in seen["area"]
    assert "9876543210" not in store.get(body["id"])["text"]
    assert body["masked"] == ["email", "mobile"]
