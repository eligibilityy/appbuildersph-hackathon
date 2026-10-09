"""FastAPI app: wires the features together. Each feature lives in its own module.

Run from this folder:  .venv/Scripts/python main.py   (or: python -m uvicorn main:app --port 8000)
"""
import asyncio
from contextlib import asynccontextmanager

import config  # noqa: F401  (sets offline env vars before model libs load)
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

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
    enabled = [name for name, on in config.FEATURES.items() if on]
    print(f"[server] features: faces, {', '.join(enabled) or '(none else)'}")
    yield


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
        "features": {"faces": True, **config.FEATURES},
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
