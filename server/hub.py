"""Shared runtime state: connected browser clients, event broadcast, and the loaded face engine.

Any feature can push an event to every open page (patient view, caregiver) with broadcast().
Code running in a worker thread (Whisper, Ollama) uses broadcast_threadsafe().
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import WebSocket

if TYPE_CHECKING:
    from faces.engine import FaceEngine

clients: set[WebSocket] = set()
loop: asyncio.AbstractEventLoop | None = None  # set at startup
engine: FaceEngine | None = None               # set at startup


async def broadcast(event: dict):
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(event)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def broadcast_threadsafe(event: dict):
    """Call from a worker thread (not from async code)."""
    if loop is not None:
        asyncio.run_coroutine_threadsafe(broadcast(event), loop)
