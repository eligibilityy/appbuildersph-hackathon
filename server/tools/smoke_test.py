"""End-to-end smoke test for the server. Run before every push:

    cd server
    .venv/Scripts/python tools/smoke_test.py        (macOS/Linux: .venv/bin/python tools/smoke_test.py)

Starts its own server on port 8765 with a throwaway data folder (your real server/data is untouched),
and uses InsightFace's bundled sample photos (no real people). Exit code 0 = all passed.
"""
import asyncio
import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import cv2
import httpx
import insightface
import websockets

SERVER_DIR = Path(__file__).resolve().parent.parent
PORT = 8765
BASE = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}/ws"
IMAGES = Path(insightface.__file__).parent / "data" / "images"

failures = []


def check(name, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"  ({detail})" if detail and not ok else ""))
    if not ok:
        failures.append(name)


def jpeg(img, q=80):
    return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, q])[1].tobytes()


def start_server(data_dir, log):
    env = {**os.environ, "DATA_DIR": str(data_dir), "PYTHONWARNINGS": "ignore"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--host", "127.0.0.1", "--port", str(PORT)],
        cwd=SERVER_DIR, env=env, stdout=log, stderr=subprocess.STDOUT,
    )
    deadline = time.time() + 180
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError("server exited during startup - see the log printed below")
        try:
            if httpx.get(f"{BASE}/health", timeout=1).status_code == 200:
                return proc
        except httpx.HTTPError:
            pass
        time.sleep(0.5)
    raise RuntimeError("server did not start within 180 s")


def stop_server(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


async def send_frames(ws, data: bytes, n: int):
    """Send n frames, return the last 'faces' payload (other broadcast events are skipped)."""
    faces = None
    b64 = base64.b64encode(data).decode()
    for _ in range(n):
        await ws.send(json.dumps({"type": "frame", "ts": 0, "jpeg": b64}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=30))
            if msg["type"] == "faces":
                faces = msg["faces"]
                break
    return faces


def main():
    tom = cv2.imread(str(IMAGES / "Tom_Hanks_54745.png"))
    tom_big = cv2.copyMakeBorder(cv2.resize(tom, (224, 224)), 128, 128, 208, 208, cv2.BORDER_CONSTANT)
    group = cv2.imread(str(IMAGES / "t1.jpg"))  # 6 faces, each ~100 px
    blank = tom_big * 0
    tom_jpg, group_jpg, blank_jpg = jpeg(tom_big), jpeg(group), jpeg(blank)

    data_dir = Path(tempfile.mkdtemp(prefix="memoryaid-smoke-"))
    log_path = data_dir / "server.log"
    log = open(log_path, "w")
    proc = None
    try:
        print("Starting server (first run may take a moment to load the face model)...")
        proc = start_server(data_dir, log)

        print("REST")
        h = httpx.get(f"{BASE}/health").json()
        check("health ok, empty database", h["ok"] and h["people"] == 0)

        files = [("images", (f"s{i}.jpg", tom_jpg, "image/jpeg")) for i in range(3)]
        r = httpx.post(f"{BASE}/enroll", data={"name": "Tom", "relationship": "friend"}, files=files, timeout=60)
        check("enroll with 3 single-face photos", r.status_code == 200, r.text)
        tom_id = r.json().get("id")

        r = httpx.post(f"{BASE}/enroll", data={"name": "X"}, files=files[:2], timeout=60)
        check("enroll rejects 2 photos", r.status_code == 400, r.text)

        gfiles = [("images", (f"g{i}.jpg", group_jpg, "image/jpeg")) for i in range(3)]
        r = httpx.post(f"{BASE}/enroll", data={"name": "Group"}, files=gfiles, timeout=60)
        check("enroll rejects a photo with 6 faces", r.status_code == 400 and "found 6" in r.text, r.text)

        check("thumbnail saved", httpx.get(f"{BASE}/thumbs/{tom_id}.jpg").status_code == 200)

        print("Live recognition (/ws)")

        async def live():
            async with websockets.connect(WS, max_size=None) as ws:
                faces = await send_frames(ws, tom_jpg, 7)
                check("enrolled face recognized", len(faces) == 1 and faces[0]["name"] == "Tom", faces)

                await send_frames(ws, blank_jpg, 12)  # Tom leaves; tracks expire
                faces = await send_frames(ws, group_jpg, 7)
                unknown = [f for f in faces if f["is_unknown"]]
                check("6 strangers saved as Unknown", len(unknown) == 6, faces)

                await send_frames(ws, blank_jpg, 12)  # they leave...
                faces = await send_frames(ws, group_jpg, 7)  # ...and come back
                n_people = len(httpx.get(f"{BASE}/people").json())
                check("returning strangers re-recognized, not duplicated",
                      n_people == 7 and all(f["is_unknown"] for f in faces), f"{n_people} people")

                await ws.send(b"\x00\x00" * 1600)  # audio chunk: accepted
                await ws.send(json.dumps({"type": "replay_brief"}))
                await send_frames(ws, blank_jpg, 1)  # connection still alive

        asyncio.run(live())

        print("Corrections")
        r = httpx.post(f"{BASE}/people/{tom_id}/photos",
                       files=[("images", ("p.jpg", tom_jpg, "image/jpeg"))] * 2, timeout=60)
        check("add 2 photos to an existing person", r.status_code == 200 and r.json()["added"] == 2, r.text)
        check("embedding count is now 5", httpx.get(f"{BASE}/people/{tom_id}").json()["embedding_count"] == 5)

        unknown = next(p for p in httpx.get(f"{BASE}/people").json() if p["is_unknown"])
        r = httpx.post(f"{BASE}/people/{unknown['id']}/merge", json={"into_person_id": tom_id})
        tom_after = httpx.get(f"{BASE}/people/{tom_id}").json()
        check("merge Unknown into Tom moves their faces",
              r.status_code == 200 and tom_after["embedding_count"] == 10, r.text)
        check("merged Unknown is gone", httpx.get(f"{BASE}/people/{unknown['id']}").status_code == 404)

        r = httpx.patch(f"{BASE}/people/{tom_id}", json={"relationship": "old friend"})
        check("edit relationship", r.status_code == 200 and r.json()["relationship"] == "old friend", r.text)

        print("Persistence")
        stop_server(proc)
        proc = start_server(data_dir, log)
        h = httpx.get(f"{BASE}/health").json()
        check("data survives a restart", h["people"] == 6 and h["embeddings"] == 35, h)

        r = httpx.delete(f"{BASE}/people/{tom_id}")
        check("delete person", r.status_code == 200 and httpx.get(f"{BASE}/people/{tom_id}").status_code == 404)
        check("thumbnail deleted too", httpx.get(f"{BASE}/thumbs/{tom_id}.jpg").status_code == 404)
    except Exception as e:
        failures.append(f"crashed: {e!r}")
        print(f"  FAIL  crashed: {e!r}")
    finally:
        if proc:
            stop_server(proc)
        log.close()
        if failures:
            print("\n--- server log ---")
            print(log_path.read_text(errors="replace")[-4000:])
        shutil.rmtree(data_dir, ignore_errors=True)

    print(f"\n{'ALL PASSED' if not failures else f'{len(failures)} FAILED: ' + ', '.join(failures)}")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
