# Memory Aid — on-device face memory for people with dementia

A camera recognizes the people who visit a patient with dementia, listens to the conversation, remembers who they are and what they talked about, and **speaks a short reminder out loud** the next time that person appears:

> "This is Miguel, your grandson. You last saw Miguel a few minutes ago. Miguel just started a new job in BGC."

**Everything runs on the laptop. The app works with Wi-Fi off.** Built for the AppBuildersPH Hackathon 2026 (theme: Local AI).

> **Teammates:** who does what, the feature order and the timetable are in [`docs/TEAM_PLAN.md`](docs/TEAM_PLAN.md). The full spec (architecture, protocol, schema, rules) is in [`CLAUDE.md`](CLAUDE.md). This README is the "how do I run and work on it" guide.

---

## Status

| Feature | State |
|---|---|
| Live face recognition, enrollment, SQLite (Milestone 1) | ✅ done, tested end to end |
| Code split by feature, with feature switches + smoke test | ✅ done |
| Add photos to a person / merge Unknown into a person (server) | ✅ done (UI in progress) |
| **Core:** robust recognition (quality gate, glasses/hair), visits + "last seen", speak name on arrival | ⏳ block 1 |
| Whisper transcripts, full spoken brief, caregiver timeline | ⏳ block 2 |
| Ollama/Qwen memory extraction, live captions | ⏳ block 3 |
| README final (measured performance, disclosures), demo video | ⏳ |

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

The first time the server starts, it downloads the InsightFace `buffalo_s` face model to `~/.insightface/models/buffalo_s`. After that it loads offline in a second or two. For the other models, see [Models](#models-what-each-laptop-needs) below.

### 3. Web (Next.js)

```powershell
cd web
npm install
npx next telemetry disable   # Next.js sends usage data by default; we must not
```

### 4. Models

Download only the models for the part you're working on. See the next section.

---

## Models: what each laptop needs

Everything runs locally, so the AI model files have to be on the laptop. Each is a **one-time download**. After that, the app works with Wi-Fi off.

### The models

| Model | Job | Size on disk | Where it's stored | Needed from |
|---|---|---|---|---|
| InsightFace `buffalo_s` | Face detection + recognition | ~160 MB (measured) | `~/.insightface/models/buffalo_s` | Milestone 1 (now) |
| Piper `en_US-lessac-medium` | Text-to-speech (the voice) | ~60 MB (approx.) | repo `models/` folder | Milestone 2 |
| faster-whisper `small` | Speech-to-text | ~0.5 GB (approx.) | `~/.cache/huggingface/hub` | Milestone 2 |
| Ollama `qwen3:4b` | Summaries, facts, names from conversations | ~2.5 GB (approx.) | `~/.ollama/models` | Milestone 3 |
| Ollama app | Runs the LLM on the GPU | ~1 GB+ (approx.) | installed program | Milestone 3 |

**Smaller fallbacks** for weaker laptops or slow internet:

| Instead of | Use | Size (approx.) | Trade-off |
|---|---|---|---|
| Whisper `small` | Whisper `base` | ~150 MB | Less accurate, especially Taglish |
| `qwen3:4b` | `qwen3:1.7b` | ~1.4 GB | Weaker at pulling out names and facts |

*(Approximate sizes will be replaced with measured ones once downloaded.)*

### Which laptop needs what

| Laptop / role | Faces | Piper voice | Whisper | Ollama + LLM | Total (approx.) |
|---|---|---|---|---|---|
| **Frontend / UI work** (pages, dashboard) | ✅ | — | — | — | ~160 MB |
| **Audio work** (mic, transcripts, voice) | ✅ | ✅ | ✅ `small` (or `base`) | — | ~0.7 GB |
| **LLM / memory work** | ✅ | — | — | ✅ `qwen3:1.7b` is fine for development | ~2.5 GB |
| **🎤 Demo laptop** | ✅ | ✅ | ✅ `small` | ✅ `qwen3:4b` **and** `qwen3:1.7b` as backup | ~5 GB |

The server only loads a model when the feature that needs it runs. For example, if you're working on the UI, the server runs without the Whisper or LLM models downloaded.

### How to download each one

Run these from the `server` folder with internet on. macOS/Linux: use `.venv/bin/python` instead of `.\.venv\Scripts\python`.

**Faces** (automatic): start the server once with `.\.venv\Scripts\python main.py`.

**Piper voice:**
```powershell
.\.venv\Scripts\python -m piper.download_voices en_US-lessac-medium --data-dir ..\models
```
This saves `en_US-lessac-medium.onnx` and `en_US-lessac-medium.onnx.json` into `models/`.

**Whisper:** the server runs in offline mode, so download ahead of time:
```powershell
.\.venv\Scripts\python -c "import os; os.environ['HF_HUB_OFFLINE']='0'; from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
```
Replace `'small'` with `'base'` for the smaller model.

**Ollama + LLM:** install Ollama from https://ollama.com/download, then:
```powershell
ollama pull qwen3:4b      # default (demo laptop)
ollama pull qwen3:1.7b    # fallback / development
ollama list               # confirm they're there
```

### Using the smaller models

Model names are in `server/config.py`. Override them per laptop with environment variables, so nobody has to edit the code:

```powershell
# PowerShell, in the terminal where you start the server
$env:WHISPER_MODEL = "base"
$env:OLLAMA_MODEL = "qwen3:1.7b"
.\.venv\Scripts\python main.py
```
```bash
# macOS / Linux
WHISPER_MODEL=base OLLAMA_MODEL=qwen3:1.7b .venv/bin/python main.py
```

### Copy models by USB instead of downloading

Model files are just files. Once one person has them, copy these folders to the same place on another laptop. This helps when venue Wi-Fi is slow.

| Model | Windows | macOS / Linux |
|---|---|---|
| Faces | `C:\Users\<you>\.insightface\models\buffalo_s\` | `~/.insightface/models/buffalo_s/` |
| Whisper | `C:\Users\<you>\.cache\huggingface\hub\models--Systran--faster-whisper-small\` | `~/.cache/huggingface/hub/models--Systran--faster-whisper-small/` |
| Piper voice | `<repo>\models\en_US-lessac-medium.onnx` + `.onnx.json` | `<repo>/models/` (same files) |
| Ollama LLMs | `C:\Users\<you>\.ollama\models\` (copy the whole folder: `blobs` + `manifests`) | `~/.ollama/models/` |

Notes:
- **Ollama:** the receiving laptop still needs the Ollama app installed (~1 GB installer, which can also go on the USB). Quit Ollama before copying the `models` folder in. Then check that `ollama list` shows the models.
- **Whisper `base`:** the folder is `models--Systran--faster-whisper-base`.
- **Disk space:** `buffalo_s.zip` in `~/.insightface/models/` can be deleted after the first run.

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

The code is split **one module per feature**, so each teammate works in their own files. Features marked *stub* already have their final function signatures, and each one's docstring says what to build.

```
CLAUDE.md            Full spec: architecture, WebSocket protocol, DB schema, rules
README.md            This file
docs/TEAM_PLAN.md    Feature order, timetable, who owns which files, git rules
.gitignore           Keeps server/data/, .venv/, node_modules/ out of git

server/
  main.py            Wires the features together (thin)
  config.py          ALL tunable constants, model names, feature switches
  db.py              Shared SQLite schema + connection
  hub.py             Connected pages + broadcast(event) to all of them
  ws.py              /ws: frames -> faces -> visits, mic audio -> audio, "Who's this?" -> visits
  people.py          /people CRUD + thumbnails
  faces/             CORE: face recognition
    engine.py          model load, detect/embed, gallery + matching, enroll / add photos / merge
    tracker.py         follows faces across frames, confirms identity, creates "Unknown #N"
    quality.py         is this face good enough to trust? (stub)
    routes.py          /enroll, /people/{id}/photos, /people/{id}/merge
  visits.py          visit start/end, "last seen", spoken brief text (stub)
  tts.py             Piper text-to-speech (stub)
  audio.py           mic audio -> Whisper transcripts (stub)
  memory.py          Ollama summaries + facts (stub)
  tools/
    smoke_test.py      end-to-end test on a throwaway server (run before every push)
    eval_faces.py      measures same-person vs different-person scores, to pick MATCH_THRESHOLD
  requirements.txt   Pinned Python dependencies
  data/              (gitignored, auto-created) app.db, thumbs/, tts/, eval/

web/src/
  app/page.tsx                 Patient view (/)
  app/enroll/page.tsx          Enrollment (/enroll)
  app/caregiver/page.tsx       Caregiver dashboard (/caregiver)
  components/FaceOverlay.tsx   Video + face boxes and names
  components/NameCard.tsx      Big name card
  components/caregiver/PersonCard.tsx   One person on the caregiver page
  lib/api.ts                   Typed REST calls (people, enroll, addPhotos, merge, ...)
  lib/server.ts                Server URL, WebSocket hook with auto-reconnect, shared types
  lib/camera.ts                Webcam hook + frame grabbing
  lib/audio.ts                 Plays the spoken brief; mic capture goes here later

models/              Piper voice files go here
```

### Feature switches

Turn off features a laptop doesn't need. A disabled feature never loads its model. Faces are always on.

```powershell
$env:FEATURE_AUDIO = "0"; $env:FEATURE_MEMORY = "0"   # also FEATURE_TTS, FEATURE_VISITS
.\.venv\Scripts\python main.py
```
`GET /health` lists which features are on.

### Smoke test (run before every push)

```powershell
cd server
.\.venv\Scripts\python tools\smoke_test.py      # macOS/Linux: .venv/bin/python tools/smoke_test.py
```
It starts its own server on port 8765 with a throwaway data folder, so your real `server/data` is untouched. It uses InsightFace's bundled sample photos, so no real faces are involved. It checks enrollment, live recognition, Unknown creation, add photos, merge, edit, delete, and restart persistence. Expect `ALL PASSED`.

### Server API (so far)

| Method | Path | Purpose |
|---|---|---|
| WS | `/ws` | Browser sends `{type:"frame", jpeg}`; server replies `{type:"faces", faces:[...]}` and broadcasts `memory_updated` |
| GET | `/health` | Server status, number of people and embeddings |
| POST | `/enroll` | multipart: `name`, `relationship`, 3–5 `images` (each must contain exactly one face) |
| POST | `/people/{id}/photos` | multipart: 1–5 `images`. Adds photos to someone already known (e.g. now wearing glasses) |
| POST | `/people/{id}/merge` | JSON `{into_person_id}`. "Unknown #3 is actually Miguel": moves their faces, visits and facts, then deletes the Unknown |
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
# ...work in the files you own (see docs/TEAM_PLAN.md)...
cd server && .venv/Scripts/python tools/smoke_test.py   # must say ALL PASSED
cd ../web && npm run build                               # if you touched the web app
git add <files>
git commit -m "Add Whisper transcription per visit"
git push -u origin your-feature  # then open a PR; the lead merges into main
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Red dot in the top-right of the patient view | The server isn't running, or isn't on port 8000. Start Terminal 1. |
| No face boxes; server log shows `431 Request Header Fields Too Large` | Big cookies from other `localhost` projects were being sent to the server. Fixed: the web app now talks to `127.0.0.1:8000`. Rebuild (`npm run build`, restart `npm start`) or use `npm run dev`. |
| Changes in `web/` don't show up | `npm start` serves the last build. Run `npm run build` again and restart it, or use `npm run dev` while coding. |
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
- [ ] Ollama `qwen3:4b` + backup `qwen3:1.7b` pulled; `ollama ps` shows 100% GPU (Milestone 3)
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
