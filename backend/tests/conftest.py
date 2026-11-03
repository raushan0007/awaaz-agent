import pytest

from backend.app import moderation


@pytest.fixture(autouse=True)
def safe_content(monkeypatch):
    """The safety screen is a live model call; tests pass everything unless they set a verdict."""
    verdict = {"photo_safe": True, "photo_category": "none", "text_safe": True, "text_category": "none"}

    async def fake_screen(text, area="", town="", photo=None, mime="image/jpeg"):
        if isinstance(verdict.get("raise"), Exception):
            raise verdict["raise"]
        return {k: v for k, v in verdict.items() if k != "raise"}

    monkeypatch.setattr(moderation, "screen", fake_screen)
    return verdict
