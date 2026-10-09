# Memory Aid — on-device face memory for people with dementia

A camera recognizes the people who visit a patient with dementia, listens to the conversation, remembers who they are and what they talked about, and **speaks a short reminder out loud** the next time that person appears:

> "This is Miguel, your grandson. You last saw Miguel a few minutes ago. Miguel just started a new job in BGC."

**Everything runs on the laptop. The app works with Wi-Fi off.** Built for the AppBuildersPH Hackathon 2026 (theme: Local AI).

> **Teammates:** the full spec (architecture, protocol, schema, rules) is in [`CLAUDE.md`](CLAUDE.md). This README is the "how do I run and work on it" guide.

---

## Status

| # | Milestone | State |
|---|---|---|
| 1 | Webcam → server → face recognition → names on screen; enrollment; SQLite | ✅ done, server tested end to end |
| 2 | Mic → Whisper transcripts per visit; Piper speaks the name on arrival | ⏳ next |
| 3 | Ollama memory extraction; "last seen"; full spoken brief; offline test | ⏳ |
| 4 | Caregiver dashboard (timeline, facts, live captions), replay button polish | ⏳ |
| 5 | README final (measured performance, disclosures), demo video | ⏳ |

---

## How it works (short version)

```
 Chrome (localhost:3000)                     Python server (localhost:8000)
 ┌──────────────────────┐   webcam frames    ┌───────────────────────────┐
 │ Next.js web app      │ ─────────────────▶ │ FastAPI                   │
 │  /          patient  │   ~5 per second    │  faces.py  → who is this? │
 │  /enroll    add face │ ◀───────────────── │  db.py     → SQLite file  │
 │  /caregiver  people  │   boxes + names    │  (later: Whisper, Ollama, │
 └──────────────────────┘                    │   Piper)                  │
                                             └───────────────────────────┘
```

- The **web app** (`web/`) is just the screen: it uses the camera, draws boxes and names over the video, and has the buttons. No AI runs in the browser.
- The **server** (`server/`) does all the AI and remembers people in `server/data/app.db`.
- For each frame the server **detects faces**, turns each face into a **512-number "embedding"** (photos of the same person give similar numbers), and compares it with everyone it knows using **cosine similarity**. A score of ≥ 0.45 counts as a match.
- A face must match the same person for **5 frames in a row** before a name is shown, which avoids flicker and mistakes.
- A face that matches no one for 5 frames is saved as **"Unknown #N"**, so a returning stranger is recognized as the same unknown. A caregiver can name them later.
- **Only the LLM uses the GPU.** Faces, speech-to-text, and text-to-speech run on the CPU.

---

## Setup (one time per laptop, needs internet)

### Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Python | **3.11** | `python --version` |
| Node.js | 20+ (we use 22) | `node --version` |
| Git | any | |
| Google Chrome | any | the camera page is built for Chrome |
| Ollama | latest | needed from Milestone 3 — https://ollama.com/download |

You **don't** need Microsoft C++ Build Tools: `insightface` 2.1 installs as a pure-Python wheel.

### 1. Clone

```powershell
git clone <repo-url> appbuildersph
cd appbuildersph
```

### 2. Server (Python)

**Windows (PowerShell):**
```powershell
cd server
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
```

**macOS / Linux:**
```bash
cd server
python3.11 -m venv .venv
.venv/bin/python -m pip install --upgrade pip
.venv/bin/python -m pip install -r requirements.txt
```

The first time the server starts, it downloads the InsightFace `buffalo_s` face model (~120 MB) to `~/.insightface/models/buffalo_s`. After that it loads offline in a second or two.

### 3. Web (Next.js)

```powershell
cd web
npm install
npx next telemetry disable   # Next.js sends usage data by default; we must not
```

### 4. Ollama models (from Milestone 3)

```powershell
ollama pull qwen3:4b      # default, runs on the GPU
ollama pull qwen3:1.7b    # fallback for weaker laptops
```

---

## Running it

Use **two terminals** and leave both open.

**Terminal 1 — server** (run from the `server` folder):
```powershell
cd server
.\.venv\Scripts\python main.py          # macOS/Linux: .venv/bin/python main.py
```
It's ready when you see `[faces] loaded buffalo_s` and `Uvicorn running on http://127.0.0.1:8000`.
Health check: http://localhost:8000/health

**Terminal 2 — web:**
```powershell
cd web
npm run dev                     # while coding (hot reload)
# or, for demos:
npm run build
npm start
```

Then open Chrome:

| Page | URL | What it's for |
|---|---|---|
| Enroll | http://localhost:3000/enroll | Add a person: name + relationship + 5 guided photos |
| Patient view | http://localhost:3000/ | Full-screen camera, boxes + names, big name card, "Who's this?" button (or spacebar) |
| Caregiver | http://localhost:3000/caregiver | List of people, name the "Unknown #N" faces, delete people |

Stop either one with **Ctrl+C**. Stage demo: `chrome --app=http://localhost:3000` (or `--kiosk`).

### Quick test

1. Enroll yourself at `/enroll`.
2. Open `/`: a **green** box with your name should appear within about a second.
3. Have someone who isn't enrolled step in: grey "…" first, then **amber** "Unknown #1".
4. Open `/caregiver`, type their name, Save, and they turn green on the patient view.

To start from a clean slate, stop the server and delete the `server/data/` folder.

---

## Project layout

```
CLAUDE.md          Full spec: architecture, WebSocket protocol, DB schema, rules
README.md          This file
.gitignore         Keeps server/data/, .venv/, node_modules/ out of git

server/
  main.py          FastAPI app: /ws (live frames) + REST routes
  config.py        ALL tunable constants and model names (edit here, restart)
  faces.py         Face detection/embedding, matching, tracking, unknown-person logic
  db.py            SQLite schema + queries
  requirements.txt Pinned Python dependencies
  data/            (gitignored, auto-created) app.db, thumbs/, tts/
  # coming next: audio.py (Whisper), memory.py (Ollama), visits.py, tts.py (Piper)

web/
  src/app/page.tsx            Patient view (/)
  src/app/enroll/page.tsx     Enrollment (/enroll)
  src/app/caregiver/page.tsx  Caregiver dashboard (/caregiver)
  src/lib/server.ts           Server URL, WebSocket hook with auto-reconnect, shared types
  src/lib/camera.ts           Webcam hook + frame grabbing

models/            Piper voice files go here (Milestone 2)
```

### Server API (so far)

| Method | Path | Purpose |
|---|---|---|
| WS | `/ws` | Browser sends `{type:"frame", jpeg}`; server replies `{type:"faces", faces:[...]}` and broadcasts `memory_updated` |
| GET | `/health` | Server status, number of people and embeddings |
| POST | `/enroll` | multipart: `name`, `relationship`, 3–5 `images` (each must contain exactly one face) |
| GET | `/people` · `/people/{id}` | List people / one person with visits + facts |
| PATCH | `/people/{id}` | JSON `{name, relationship, notes}`; naming an unknown makes them known |
| DELETE | `/people/{id}` | Delete a person and everything about them |
| GET | `/visits?person_id=` | Visit history |
| GET | `/thumbs/{id}.jpg` | Face thumbnail |

The full message protocol for upcoming milestones is in `CLAUDE.md`.

### Tuning (`server/config.py`)

| Setting | Default | Change it if… |
|---|---|---|
| `MATCH_THRESHOLD` | 0.45 | People get mixed up → raise it. Known people show as unknown → lower it. |
| `CONFIRM_FRAMES` | 5 | Names take too long to appear → lower it. |
| `UNKNOWN_MIN_FACE_PX` | 60 | Strangers far from the camera never get saved → lower it. |
| `VISIT_END_SECONDS` | 30 | For the stage demo, set the env var `VISIT_END_SECONDS=10`. |

---

## Team rules (please read)

1. **Never commit `server/data/`.** It holds real faces and conversations. It's in `.gitignore`. Don't force-add it.
2. **No internet at runtime.** No cloud APIs, CDNs, Google Fonts (`next/font/google`), analytics, or Web Speech API. Before pushing, check that this prints nothing:
   ```bash
   grep -rn "https://" web/src
   ```
3. **Never make up performance numbers.** Only report what we measured. The server logs real timings (`[faces] detect+embed ... mean X ms`).
4. **Commit early and often.** Pull before you start, use small commits with clear messages. **Code freeze: 10:00 AM, Oct 10 (Manila).**
5. **Keep the face loop fast.** Slow work (Whisper, LLM) goes to a background worker thread, never in the frame loop.
6. **Settings go in `config.py`**, not hard-coded in other files.
7. Ship the simplest thing that works: this is an 18-hour build.

### Suggested workflow

```bash
git pull
git checkout -b your-feature     # e.g. audio-whisper, caregiver-timeline
# ...work, test...
git add <files>
git commit -m "Add Whisper transcription per visit"
git push -u origin your-feature  # then open a PR, or merge to main after a quick check
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Red dot in the top-right of the patient view | The server isn't running, or isn't on port 8000. Start Terminal 1. |
| "Camera unavailable" | Allow camera access in Chrome (lock icon → Camera), and close other apps using the webcam (Zoom, Teams, OBS). |
| Camera doesn't work when opening the app from another device by IP | Browsers only allow the camera on `localhost` or HTTPS. Run the browser on the same laptop as the server. |
| `[Errno 10048]` / address already in use | Something is already on port 8000. Close the old server terminal, or find it with `netstat -ano \| findstr :8000` and stop that PID. |
| Server's first start is slow or fails offline | The face model must be downloaded once with internet (see Setup step 2). |
| Enrollment says "expected exactly 1 face, found 0" | Better lighting, face the camera, and make sure only one person is in frame. |

---

## Offline checklist (before the demo, on the demo laptop, after a reboot)

- [ ] InsightFace model cached (`~/.insightface/models/buffalo_s`)
- [ ] faster-whisper model cached (Milestone 2)
- [ ] Piper voice files in `models/` (Milestone 2)
- [ ] Ollama models pulled; `ollama ps` shows 100% GPU (Milestone 3)
- [ ] `npx next telemetry disable` done on this laptop
- [ ] `grep -rn "https://" web/src` prints nothing
- [ ] Full end-to-end run with **Wi-Fi OFF**

---

## Hardware

Development/demo laptop: Intel Core i5-12450H, 16 GB RAM, NVIDIA GTX 1650 (4 GB VRAM), Windows 11.

### Measured performance

Only numbers we actually measured. More will be added as we test.

| What | Result | Conditions |
|---|---|---|
| Face detect + embed, 1 face | ~40–60 ms per frame | 640×480 test image, CPU (`buffalo_s`, det size 320), i5-12450H |
| Face model load (cached) | ~1–2 s | same laptop |

---

## Disclosures

Models, frameworks, and tools used. This list will be finalized before submission.

| Item | Use | License / note |
|---|---|---|
| [InsightFace](https://github.com/deepinsight/insightface) `buffalo_s` (SCRFD detector + ArcFace recognizer) | Face detection + embeddings | Model weights are licensed for **non-commercial research use only** |
| ONNX Runtime | Runs the face models on CPU | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) `small` (planned) | Speech-to-text | MIT (Whisper weights: MIT) |
| [Ollama](https://ollama.com) + Qwen3 4B (planned) | Memory extraction from transcripts | Qwen3: Apache 2.0 |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) `en_US-lessac-medium` (planned) | Text-to-speech | `piper-tts` library: GPL-3.0; voice: see its model card |
| FastAPI, Uvicorn, NumPy, OpenCV, SQLite | Backend | open source |
| Next.js, React, Tailwind CSS | Frontend | open source |
| **Claude Code (Anthropic)** | AI coding assistant used during development | — |

No cloud APIs are called at runtime. The links above are documentation for readers, not used by the app.
