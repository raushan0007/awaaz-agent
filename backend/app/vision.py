"""Photo evidence check with SAM 3.1: does the photo actually show the reported problem?"""

from __future__ import annotations

import base64
from contextlib import aclosing
from typing import Any

from meta_sam_parser import decode_mask_to_svg_path, image_segmentation_format, parse_responses_stream

from .config import settings
from .meta_client import async_meta_client

SAM_MODEL = "sam-3.1"


async def _as_event_dicts(stream):
    # The parser closes a text lane on `response.output_text.done`, which the API does not
    # send, so emit one from each finished `output_text` content part.
    closed: set[tuple] = set()
    async for event in stream:
        data = event.model_dump() if hasattr(event, "model_dump") else dict(event)
        lane = (data.get("item_id"), data.get("output_index"), data.get("content_index"))
        if data.get("type") == "response.output_text.done":
            if lane not in closed:
                closed.add(lane)
                yield data
            continue
        yield data
        part = data.get("part")
        if (
            data.get("type") == "response.content_part.done"
            and lane not in closed
            and isinstance(part, dict)
            and part.get("type") == "output_text"
        ):
            closed.add(lane)
            yield {
                "type": "response.output_text.done",
                "item_id": data.get("item_id"),
                "output_index": data.get("output_index"),
                "content_index": data.get("content_index"),
                "text": part.get("text", ""),
            }


async def segment_image(image: bytes, mime: str, concept: str) -> dict[str, Any]:
    """Find every instance of `concept` (a short noun phrase) in the image."""
    data_url = f"data:{mime};base64,{base64.b64encode(image).decode('ascii')}"
    async with async_meta_client() as api:
        stream = await api.responses.create(
            model=SAM_MODEL,
            stream=True,
            input=[
                {
                    "type": "message",
                    "role": "user",
                    "content": [
                        {"type": "input_text", "text": concept.strip()},
                        {"type": "input_image", "image_url": data_url},
                    ],
                }
            ],
        )
        async with stream, aclosing(_as_event_dicts(stream)) as events:
            result = await parse_responses_stream(events, image_segmentation_format()).final_result()

    if result.outcome.status != "completed":
        raise RuntimeError(f"SAM did not complete: {getattr(result.outcome, 'reason', 'unknown')}")
    settings.budget.charge_images(1)
    boxes = [r for r in result.records if r.kind == "box"]
    masks = [r for r in result.records if r.kind == "mask"]
    return {
        "concept": concept,
        "boxes": [
            {"id": b.object_id, "left": b.left, "top": b.top, "right": b.right, "bottom": b.bottom}
            for b in boxes
        ],
        "masks": [
            {"id": m.object_id, "width": m.mask.width, "height": m.mask.height, "path": decode_mask_to_svg_path(m.mask)}
            for m in masks
        ],
    }
