"""FastAPI app: wires the features together. Each feature lives in its own module.

Run from this folder:  .venv/Scripts/python main.py   (or: python -m uvicorn main:app --port 8000)
"""
import asyncio
import threading
from contextlib import asynccontextmanager

import config  # noqa: F401  (sets offline env vars before model libs load)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

import audio
import db
import hub
import memory
import people
import tts
import visits
import ws
from faces import routes as face_routes
from faces.engine import FaceEngine


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    hub.loop = asyncio.get_running_loop()
    hub.engine = FaceEngine()
    if config.FEATURES["memory"]:
        memory.start()
    if config.FEATURES["tts"] and not tts.available():
        print(f"[tts] voice missing: {config.PIPER_VOICE} (see README > Models). Briefs will be text only.")
    # Load the models in the background now, so the first visit doesn't wait for them.
    threading.Thread(target=_warm_models, name="model-warmup", daemon=True).start()
    enabled = [name for name, on in config.FEATURES.items() if on]
    print(f"[server] features: faces, {', '.join(enabled) or '(none else)'}")
    yield


def _warm_models():
    steps = []
    if config.FEATURES["tts"] and tts.available():
        steps.append(("tts", tts.warm_up))
    if config.FEATURES["audio"]:
        steps.append(("audio", audio.warm_up))
    if config.FEATURES["memory"]:
        steps.append(("memory", memory.warm_up))
    for name, warm in steps:  # one at a time: they compete for the same CPU
        try:
            warm()
        except Exception as e:
            print(f"[{name}] warm-up failed: {e!r}")


app = FastAPI(lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ws.router)
app.include_router(face_routes.router)
app.include_router(people.router)
app.include_router(visits.router)
if config.FEATURES["tts"]:
    app.include_router(tts.router)


@app.get("/health")
def health():
    return {
        "ok": True,
        "people": len(hub.engine.people),
        "embeddings": int(len(hub.engine.gallery_ids)),
        "face_model": config.FACE_MODEL,
        "voice": config.FEATURES["tts"] and tts.available(),
        "features": {"faces": True, **config.FEATURES},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
