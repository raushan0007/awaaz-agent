import json

import pytest
from fastapi.testclient import TestClient
from openai.types.chat import ChatCompletion

from backend.app import agent, config, main
from backend.app.agent import ComplaintAgent, Report, RunState, verify_decision
from backend.app.store import Store, area_key

pytestmark = pytest.mark.anyio

LETTER = (
    "सेवा में, कार्यपालक अभियंता महोदय। विषय: वार्ड 5 में सड़क पर गहरे गड्ढे। "
    "महोदय, निवेदन है कि वार्ड 5 सुपौल में मुख्य सड़क पर पिछले एक महीने से बड़े गड्ढे हैं, "
    "जिससे आने-जाने में भारी परेशानी हो रही है। कृपया शीघ्र मरम्मत कराने की कृपा करें।"
)


def decision(**overrides):
    d = {
        "is_valid_complaint": True,
        "rejection_reason": "",
        "category": "roads",
        "urgency": "medium",
        "urgency_reason": "",
        "area": "Ward 5, Supaul",
        "duplicate_of": 0,
        "photo_matches": "no_photo",
        "title_en": "Potholes on main road",
        "title_hi": "मुख्य सड़क पर गड्ढे",
        "formal_letter_hi": LETTER,
        "citizen_reply": "Aapki shikayat sadak vibhag ko bhej di gayi hai.",
    }
    d.update(overrides)
    return d


def completion(*calls, content=None):
    tool_calls = [
        {"id": f"call_{i}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
        for i, (name, args) in enumerate(calls)
    ]
    return ChatCompletion.model_validate({
        "id": "x", "object": "chat.completion", "created": 0, "model": "muse-spark-1.3",
        "choices": [{
            "index": 0,
            "finish_reason": "tool_calls" if calls else "stop",
            "message": {"role": "assistant", "content": content, "tool_calls": tool_calls or None},
        }],
        "usage": {"prompt_tokens": 1000, "completion_tokens": 200, "total_tokens": 1200},
    })


class ScriptedClient:
    """Plays back model turns and records the messages each turn was sent."""

    def __init__(self, *turns):
        self.turns = list(turns)
        self.sent = []
        self.chat = self
        self.completions = self

    async def create(self, **kwargs):
        self.sent.append(json.loads(json.dumps(kwargs["messages"], default=str)))
        return self.turns.pop(0)


@pytest.fixture()
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def budget(tmp_path, monkeypatch):
    b = config.Budget(daily_limit_usd=5, ledger_dir=tmp_path)
    monkeypatch.setattr(config.settings, "budget", b)
    return b


@pytest.fixture()
def store():
    return Store(":memory:")


SEARCH = ("search_similar_complaints", {"area": "Ward 5, Supaul", "category": "roads", "keywords": ["pothole"]})


def seed_open(store, text="Ward 5 main road par bade gaddhe", area="ward 5 supaul"):
    return store.add(text=text, area=area, has_photo=False, status="open", category="roads", urgency="medium",
                     duplicate_of=None, decision=decision(), trace=[])


async def test_happy_path_routes_and_charges(store, budget):
    client = ScriptedClient(completion(SEARCH), completion(("submit_decision", decision())))
    result = await ComplaintAgent(store, client).run(Report("Ward 5 mein sadak tooti hai", "Ward 5"))
    assert result.status == "open"
    assert result.decision["department"]["name_en"] == "Roads & Construction"
    assert [s["tool"] for s in result.trace] == ["search_similar_complaints", "submit_decision"]
    assert budget.spent_today() == pytest.approx(2 * (1000 * 1.25 + 200 * 4.25) / 1e6)
    # The full assistant message must precede its tool result, or the API answers 400.
    second = client.sent[1]
    assert second[2]["role"] == "assistant" and second[2]["tool_calls"][0]["id"] == "call_0"
    assert second[3] == {"role": "tool", "tool_call_id": "call_0", "content": json.dumps({"matches": []})}


async def test_verifier_bounces_unsearched_and_invented_duplicate(store):
    client = ScriptedClient(
        completion(("submit_decision", decision(duplicate_of=42))),
        completion(SEARCH),
        completion(("submit_decision", decision())),
    )
    result = await ComplaintAgent(store, client).run(Report("sadak tooti hai"))
    assert result.status == "open"
    bounced = result.trace[0]["result"]
    assert bounced["accepted"] is False
    assert any("search_similar_complaints" in e for e in bounced["errors"])
    assert any("duplicate_of=42" in e for e in bounced["errors"])
    tool_reply = json.loads(client.sent[1][-1]["content"])
    assert tool_reply["accepted"] is False


async def test_duplicate_merges_into_found_complaint(store):
    parent = seed_open(store)
    seed_open(store, text="Ward 9 me gaddha", area="ward 9 supaul")
    client = ScriptedClient(
        completion(SEARCH),
        completion(("submit_decision", decision(duplicate_of=parent, formal_letter_hi=""))),
    )
    result = await ComplaintAgent(store, client).run(Report("ward 5 road gaddha"))
    search = result.trace[0]["result"]
    assert [m["id"] for m in search["matches"]] == [parent]  # ward 9 is a different area
    assert result.status == "merged" and result.decision["duplicate_of"] == parent


async def test_rejection_needs_no_search(store):
    client = ScriptedClient(completion(("submit_decision", decision(
        is_valid_complaint=False, rejection_reason="Advertisement, not a civic problem"))))
    result = await ComplaintAgent(store, client).run(Report("Sasta loan lo, call karo"))
    assert result.status == "rejected"


async def test_photo_must_be_checked_and_agree_with_sam(store, monkeypatch):
    async def fake_sam(image, mime, concept):
        return {"concept": concept, "boxes": [] if concept == "pothole" else [{"id": "1"}], "masks": []}

    monkeypatch.setattr(agent, "segment_image", fake_sam)
    client = ScriptedClient(
        completion(SEARCH, ("submit_decision", decision(photo_matches="yes"))),
        completion(("check_photo", {"concept": "pothole"})),
        completion(("submit_decision", decision(photo_matches="yes"))),
        completion(("check_photo", {"concept": "water puddle"})),
        completion(("submit_decision", decision(photo_matches="yes"))),
    )
    result = await ComplaintAgent(store, client).run(Report("gaddhe me paani", photo=b"jpg"))
    assert result.status == "open"
    errors = [s["result"]["errors"] for s in result.trace if s["tool"] == "submit_decision"]
    assert "call check_photo" in errors[0][0]
    assert "found nothing" in errors[1][0]
    assert errors[2] == []


async def test_nudges_text_reply_and_gives_up_after_max_turns(store):
    client = ScriptedClient(*[completion(content="Main samajh gaya.") for _ in range(agent.MAX_TURNS)])
    result = await ComplaintAgent(store, client).run(Report("sadak tooti hai"))
    assert result.status == "needs_review"
    assert client.sent[1][-1]["role"] == "user" and "submit_decision" in client.sent[1][-1]["content"]


def test_verifier_rules():
    searched = RunState(searched=True)
    assert verify_decision(decision(), searched, False) == []
    assert verify_decision(decision(urgency="critical"), searched, False)
    assert verify_decision(decision(formal_letter_hi="Dear sir, please fix the road. " * 5), searched, False)
    assert verify_decision(decision(photo_matches="yes"), searched, False)
    assert verify_decision(decision(is_valid_complaint=False), RunState(), False)


def test_area_key_normalises():
    assert area_key("Ward No. 5, Supaul ") == "ward 5 supaul"
    assert area_key("वार्ड नं 5") == "वार्ड 5"


def test_complaint_endpoint_stores_and_counts_supporters(tmp_path, monkeypatch):
    store = Store(tmp_path / "a.db")
    monkeypatch.setattr(main, "_store", store)
    parent = seed_open(store)

    async def fake_run(self, report):
        return agent.AgentResult("merged", {**decision(duplicate_of=parent), "department": {}}, [])

    monkeypatch.setattr(ComplaintAgent, "run", fake_run)
    client = TestClient(main.app)
    assert client.post("/api/complaints", data={"text": "hi"}).status_code == 400
    body = client.post("/api/complaints", data={"text": "ward 5 sadak", "area": "Ward 5", "town": "Supaul"}).json()
    assert body["status"] == "merged" and body["supporters"] == 2
    assert client.get(f"/api/complaints/{parent}").json()["supporters"] == 2
    assert len(client.get("/api/complaints").json()) == 2
    assert client.get("/api/complaints/999").status_code == 404


def test_area_must_end_with_the_citizens_town():
    searched = RunState(searched=True)
    assert verify_decision(decision(area="Ward 8, Forbesganj"), searched, False, "Forbesganj") == []
    errors = verify_decision(decision(area="Ward 8"), searched, False, "Forbesganj")
    assert any("Ward 8, Forbesganj" in e for e in errors)
    assert verify_decision(decision(area="Ward 8, Supaul"), searched, False, "Forbesganj")


async def test_search_stays_inside_the_citizens_town(store):
    supaul = seed_open(store, area="Ward 8, Supaul")
    forbesganj = seed_open(store, area="Ward 8, Forbesganj")
    search = ("search_similar_complaints", {"area": "Ward 8", "category": "roads", "keywords": ["gaddha"]})
    client = ScriptedClient(completion(search), completion(("submit_decision", decision(area="Ward 8, Forbesganj"))))
    result = await ComplaintAgent(store, client).run(Report("ward 8 gaddha", "Ward 8", town="Forbesganj"))
    assert [m["id"] for m in result.trace[0]["result"]["matches"]] == [forbesganj]
    assert supaul != forbesganj and result.status == "open"
    assert "Town: Forbesganj" in client.sent[0][1]["content"]


def test_area_summary_shows_the_whole_place_without_report_text(tmp_path, monkeypatch):
    store = Store(tmp_path / "a.db")
    monkeypatch.setattr(main, "_store", store)
    first = seed_open(store, text="secret details", area="Ward 8, Forbesganj")
    store.add(text="same again", area="Ward 8, Forbesganj", has_photo=False, status="merged", category="roads",
              urgency="medium", duplicate_of=first, decision=decision(), trace=[])
    store.add(text="naali jam", area="Ward 8, Forbesganj", has_photo=False, status="resolved",
              category="drainage", urgency="high", duplicate_of=None, decision=decision(), trace=[])
    seed_open(store, area="Ward 8, Supaul")
    client = TestClient(main.app)
    s = client.get("/api/areas/summary", params={"area": "Ward 8, Forbesganj"}).json()
    assert (s["problems"], s["reports"]) == (2, 3)
    assert s["by_status"] == {"open": 1, "resolved": 1}
    assert s["by_category"] == {"roads": 1, "drainage": 1}
    assert s["items"][1]["supporters"] == 2
    assert "secret details" not in json.dumps(s)
    assert client.get("/api/areas/summary", params={"area": " "}).status_code == 400


def test_complaint_endpoint_needs_a_town_but_takes_any(tmp_path, monkeypatch):
    store = Store(tmp_path / "a.db")
    monkeypatch.setattr(main, "_store", store)
    client = TestClient(main.app)
    for bad in ["", "   ", "1234", "x" * 41]:
        assert client.post("/api/complaints", data={"text": "sadak tooti hai", "town": bad}).status_code == 400

    async def fake_run(self, report):
        assert report.town == "Patna"  # extra spaces squeezed
        return agent.AgentResult("open", {**decision(area="Boring Road, Patna"), "department": {}}, [])

    monkeypatch.setattr(ComplaintAgent, "run", fake_run)
    body = client.post("/api/complaints", data={"text": "sadak tooti hai", "town": "  Patna "}).json()
    assert body["area"] == "Boring Road, Patna"
    seed_open(store, area="Ward 5, Supaul")
    assert [p["place"] for p in client.get("/api/places").json()] == ["Patna", "Supaul"]
    patna = client.get("/api/public/stats", params={"place": "patna"}).json()
    assert patna["reports"] == 1 and patna["recent"][0]["area"] == "Boring Road, Patna"
    assert client.get("/api/public/stats").json()["reports"] == 2


def test_area_ends_with_any_town_the_citizen_gives():
    searched = RunState(searched=True)
    assert verify_decision(decision(area="Boring Road, Patna"), searched, False, "Patna") == []
    assert verify_decision(decision(area="Boring Road"), searched, False, "Patna")
    assert agent.in_town("Ward 3", "Gaya") == "Ward 3, Gaya"
    assert agent.in_town("Ward 3, Gaya", "gaya") == "Ward 3, Gaya"
