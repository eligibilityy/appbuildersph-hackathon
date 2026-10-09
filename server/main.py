"""FastAPI app: /ws for live frames + audio, REST for dashboard + enrollment."""
import asyncio
import base64
import json
from contextlib import asynccontextmanager

import config  # noqa: F401  (sets offline env vars before model libs load)
import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

import db
from faces import FaceEngine

engine: FaceEngine | None = None
clients: set[WebSocket] = set()


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    db.init()
    engine = FaceEngine()
    yield


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


async def broadcast(event: dict):
    dead = []
    for ws in list(clients):
        try:
            await ws.send_json(event)
        except Exception:
            dead.append(ws)
    for ws in dead:
        clients.discard(ws)


def decode_jpeg(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


# --- live websocket ---

@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    clients.add(ws)
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
                faces, present, new_people = await asyncio.to_thread(engine.process, img)
            except Exception as e:
                print(f"[ws] frame error: {e}")
                continue
            await ws.send_json({"type": "faces", "faces": faces})
            for pid in new_people:
                await broadcast({"type": "memory_updated", "person_id": pid})

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
                elif data.get("type") == "replay_brief":
                    pass  # milestone 3
            elif msg.get("bytes") is not None:
                pass  # PCM16 audio — milestone 2
    except WebSocketDisconnect:
        pass
    finally:
        worker.cancel()
        clients.discard(ws)


# --- REST ---

@app.get("/health")
def health():
    return {
        "ok": True,
        "people": len(engine.people),
        "embeddings": int(len(engine.gallery_ids)),
        "face_model": config.FACE_MODEL,
    }


@app.post("/enroll")
async def enroll(
    name: str = Form(...),
    relationship: str = Form(""),
    images: list[UploadFile] = File(...),
):
    name = name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    if not 3 <= len(images) <= 5:
        raise HTTPException(400, f"send 3 to 5 images (got {len(images)})")
    try:
        imgs = [decode_jpeg(await f.read()) for f in images]
        pid = await asyncio.to_thread(engine.enroll, name, relationship.strip() or None, imgs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await broadcast({"type": "memory_updated", "person_id": pid})
    return db.get_person(pid)


@app.get("/people")
def people():
    return db.list_people()


@app.get("/people/{person_id}")
def person(person_id: int):
    p = db.get_person(person_id)
    if not p:
        raise HTTPException(404, "not found")
    p["visits"] = db.list_visits(person_id)
    p["facts"] = db.list_facts(person_id)
    p["embedding_count"] = db.count_embeddings(person_id)
    return p


@app.patch("/people/{person_id}")
async def patch_person(person_id: int, body: dict):
    if not db.get_person(person_id):
        raise HTTPException(404, "not found")
    fields = {k: body[k] for k in ("name", "relationship", "notes") if k in body}
    if fields.get("name"):
        # A caregiver typing/confirming a name makes this a known, trusted person.
        fields["is_unknown"] = 0
        fields["name_source"] = "enrolled"
    db.update_person(person_id, fields)
    engine.reload()
    await broadcast({"type": "memory_updated", "person_id": person_id})
    return db.get_person(person_id)


@app.delete("/people/{person_id}")
async def remove_person(person_id: int):
    db.delete_person(person_id)
    (config.THUMBS_DIR / f"{person_id}.jpg").unlink(missing_ok=True)
    engine.reload()
    await broadcast({"type": "memory_updated", "person_id": person_id})
    return {"ok": True}


@app.get("/visits")
def visits(person_id: int | None = None):
    return db.list_visits(person_id)


@app.get("/thumbs/{person_id}.jpg")
def thumb(person_id: int):
    path = config.THUMBS_DIR / f"{person_id}.jpg"
    if not path.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
