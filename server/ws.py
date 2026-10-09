"""/ws: the live connection. Routes each incoming message to the feature that handles it.

  text  {"type": "frame", "jpeg": ...}  -> faces -> visits (-> tts)
  bytes  PCM16 audio chunk              -> audio
  text  {"type": "replay_brief"}        -> visits
"""
import asyncio
import base64
import json
import time

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

import audio
import config
import db
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
    monitoring_session_id = None
    last_monitor_frame_at = None
    last_monitor_frame_mono = None

    async def frame_worker():
        nonlocal monitoring_session_id, last_monitor_frame_at, last_monitor_frame_mono
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
                frame_at = db.now()
                frame_mono = time.monotonic()
                if (
                    monitoring_session_id is None
                    or last_monitor_frame_mono is None
                    or frame_mono - last_monitor_frame_mono > config.MONITORING_GAP_SECONDS
                ):
                    if monitoring_session_id is not None:
                        await asyncio.to_thread(
                            visits.end_monitoring_session, monitoring_session_id, last_monitor_frame_at
                        )
                    monitoring_session_id = await asyncio.to_thread(
                        visits.start_monitoring_session, frame_at
                    )
                else:
                    await asyncio.to_thread(visits.note_monitoring_frame, monitoring_session_id, frame_at)
                last_monitor_frame_at, last_monitor_frame_mono = frame_at, frame_mono
                changed_ids = await asyncio.to_thread(
                    visits.record_confirmed_appearances, result.present_person_ids, frame_at
                )
                for pid in changed_ids:
                    await hub.broadcast({"type": "appearance_updated", "person_id": pid})
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
                try:
                    data = json.loads(msg["text"])
                    if data.get("type") == "frame":
                        b64 = data["jpeg"].split(",", 1)[-1]  # tolerate data: URLs
                        latest["jpeg"] = base64.b64decode(b64)
                        have_frame.set()
                        continue
                except (ValueError, KeyError, TypeError, AttributeError) as e:
                    print(f"[ws] ignored malformed message: {e!r}")  # don't drop the whole connection
                    continue
                if isinstance(data, dict) and data.get("type") == "replay_brief" and config.FEATURES["visits"]:
                    await _broadcast_all(await asyncio.to_thread(visits.replay_brief))
            elif msg.get("bytes") is not None and config.FEATURES["audio"]:
                audio.feed(msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        worker.cancel()
        if monitoring_session_id is not None:
            await asyncio.to_thread(
                visits.end_monitoring_session, monitoring_session_id, last_monitor_frame_at
            )
        hub.clients.discard(ws)
