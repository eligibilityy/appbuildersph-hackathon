"""/ws: the live connection. Routes each incoming message to the feature that handles it.

  text  {"type": "frame", "jpeg": ...}  -> faces -> visits (-> tts)
  bytes  PCM16 audio chunk              -> audio
  text  {"type": "replay_brief"}        -> visits
"""
import asyncio
import base64
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import audio
import config
import hub
import visits
from faces.routes import decode_jpeg

router = APIRouter()


async def _broadcast_all(events: list[dict]):
    for e in events:
        await hub.broadcast(e)


@router.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    hub.clients.add(ws)
    latest = {"jpeg": None}
    have_frame = asyncio.Event()

    async def frame_worker():
        # Always process the newest frame; older frames are dropped so the loop never falls behind.
        while True:
            await have_frame.wait()
            have_frame.clear()
            jpeg, latest["jpeg"] = latest["jpeg"], None
            if jpeg is None:
                continue
            try:
                img = decode_jpeg(jpeg)
                result = await asyncio.to_thread(hub.engine.process, img)
                await ws.send_json({"type": "faces", "faces": result.faces})
                for pid in result.new_people:
                    await hub.broadcast({"type": "memory_updated", "person_id": pid})
                if config.FEATURES["visits"]:
                    await _broadcast_all(await asyncio.to_thread(visits.update, result.present_person_ids))
            except Exception as e:
                print(f"[ws] frame error: {e!r}")

    worker = asyncio.create_task(frame_worker())
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("text") is not None:
                data = json.loads(msg["text"])
                if data.get("type") == "frame":
                    b64 = data["jpeg"].split(",", 1)[-1]  # tolerate data: URLs
                    latest["jpeg"] = base64.b64decode(b64)
                    have_frame.set()
                elif data.get("type") == "replay_brief" and config.FEATURES["visits"]:
                    await _broadcast_all(await asyncio.to_thread(visits.replay_brief))
            elif msg.get("bytes") is not None and config.FEATURES["audio"]:
                audio.feed(msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        worker.cancel()
        hub.clients.discard(ws)
