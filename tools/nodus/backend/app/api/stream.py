"""SSE endpoint: GET /api/discussions/{id}/stream."""

from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.api.stream_bus import subscribe, unsubscribe

router = APIRouter(tags=["stream"])


@router.get("/api/discussions/{branch_id}/stream")
async def stream_discussion(branch_id: str):
    q = await subscribe(branch_id)

    async def gen():
        try:
            # hello event so EventSource connects immediately
            yield f"event: connected\ndata: {json.dumps({'branch_id': branch_id}, ensure_ascii=False)}\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=25)
                    yield f"event: {item['event']}\ndata: {json.dumps(item['data'], ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            await unsubscribe(branch_id, q)

    return StreamingResponse(gen(), media_type="text/event-stream")
