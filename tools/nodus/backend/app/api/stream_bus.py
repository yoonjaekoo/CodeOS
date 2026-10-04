"""In-memory SSE event bus: debate engine publishes, /stream endpoint consumes."""

from __future__ import annotations

import asyncio
from collections import defaultdict

_subscribers: dict[str, list[asyncio.Queue]] = defaultdict(list)
_lock = asyncio.Lock()


async def publish(branch_id: str, event: str, data: dict) -> None:
    queues = list(_subscribers.get(branch_id, []))
    for q in queues:
        try:
            q.put_nowait({"event": event, "data": data})
        except asyncio.QueueFull:
            pass


async def subscribe(branch_id: str) -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=500)
    async with _lock:
        _subscribers[branch_id].append(q)
    return q


async def unsubscribe(branch_id: str, q: asyncio.Queue) -> None:
    async with _lock:
        if q in _subscribers.get(branch_id, []):
            _subscribers[branch_id].remove(q)
