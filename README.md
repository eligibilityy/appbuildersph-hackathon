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
| faster-whisper `base` | Speech-to-text | ~150 MB (approx.) | `~/.cache/huggingface/hub` | Milestone 2 |
| Ollama `qwen3:4b` | Summaries, facts, names from conversations | ~2.5 GB (approx.) | `~/.ollama/models` | Milestone 3 |
| Ollama app | Runs the LLM on the GPU | ~1 GB+ (approx.) | installed program | Milestone 3 |

**Higher-accuracy option** for faster laptops with more disk space:

| Instead of | Use | Size (approx.) | Trade-off |
|---|---|---|---|
| Whisper `base` | Whisper `small` | ~0.5 GB | More accurate, especially Taglish |
| `qwen3:4b` | `qwen3:1.7b` | ~1.4 GB | Weaker at pulling out names and facts |

*(Approximate sizes will be replaced with measured ones once downloaded.)*

### Which laptop needs what

| Laptop / role | Faces | Piper voice | Whisper | Ollama + LLM | Total (approx.) |
|---|---|---|---|---|---|
| **Frontend / UI work** (pages, dashboard) | ✅ | — | — | — | ~160 MB |
| **Audio work** (mic, transcripts, voice) | ✅ | ✅ | ✅ `base` | — | ~0.4 GB |
| **LLM / memory work** | ✅ | — | — | ✅ `qwen3:1.7b` is fine for development | ~2.5 GB |
| **🎤 Demo laptop** | ✅ | ✅ | ✅ `base` | ✅ `qwen3:4b` **and** `qwen3:1.7b` as backup | ~4.7 GB |

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
The application defaults to `base`. Set `WHISPER_MODEL=small` for better accuracy if the laptop has extra disk space.

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
| Whisper | `C:\Users\<you>\.cache\huggingface\hub\models--Systran--faster-whisper-base\` | `~/.cache/huggingface/hub/models--Systran--faster-whisper-base/` |
| Piper voice | `<repo>\models\en_US-lessac-medium.onnx` + `.onnx.json` | `<repo>/models/` (same files) |
| Ollama LLMs | `C:\Users\<you>\.ollama\models\` (copy the whole folder: `blobs` + `manifests`) | `~/.ollama/models/` |

Notes:
- **Ollama:** the receiving laptop still needs the Ollama app installed (~1 GB installer, which can also go on the USB). Quit Ollama before copying the `models` folder in. Then check that `ollama list` shows the models.
- **Whisper `small`:** the folder is `models--Systran--faster-whisper-small`.
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
| Enroll | http://localhost:3000/enroll | Add a person: name, relationship, optional description, then an automatic guided face scan (no photo button) |
| Patient view | http://localhost:3000/ | Full-screen camera, floating name tags (tap one for a profile card), big name card, "Who's this?" button (or spacebar) |
| Caregiver | http://localhost:3000/caregiver | List of people, name the "Unknown #N" faces, delete people |

Stop either one with **Ctrl+C**. Stage demo:
```powershell
start chrome --app=http://localhost:3000 --autoplay-policy=no-user-gesture-required
```
(add `--kiosk` for full screen). Without the autoplay flag, Chrome stays silent until someone clicks or presses a key on the page once. The patient view shows **Tap to turn on sound** when that happens, and the first tap plays the brief that was blocked.

### Quick test

1. Enroll yourself at `/enroll`: type your name, press **Start face scan**, and follow the prompts (look straight, turn slightly left, then right, then smile). Photos are taken by themselves, and it saves when done.
2. Open `/`: a cyan scan appears on your face, then your **name tag** above your head. Tap it to see your profile card.
3. Have someone who isn't enrolled step in: a brief scan, then only a faint outline. No name is shown; they're saved as "Unknown #1" on `/caregiver`.
4. Open `/caregiver` and name them; their name tag then appears on the patient view.

To start from a clean slate, stop the server and delete the `server/data/` folder.

### Face enrollment and name tags: how they work

- **Automatic enrollment.** Nothing runs until the caregiver presses **Start face scan**, and the camera turns off again when the scan ends or is cancelled. About 5 times a second the page sends one frame to `/enroll/check` (local InsightFace). A photo is taken only when all of these hold:
  - exactly one face is in view, big enough and centred;
  - it passes the quality gate (light, blur, size);
  - the **head pose from the face landmarks** matches the current step;
  - the face has been steady for 3 checks in a row;
  - it isn't a near-copy of a photo already taken.

  The accepted photo is the exact frame the server checked. Steps: straight → slightly left → back to centre → slightly right → straight and smile (plus 2 with glasses switched, if ticked). Then it saves automatically. If the face or name is already saved, it asks the caregiver what to do instead of creating a second person.
- **Head pose** is a 2-D estimate from 5 landmarks (where the nose sits between the eyes), not from the face box. Checked on the real model: mirroring a photo flips its sign, and a face turned to its own right reads negative. How well it follows real head turns on a webcam still needs testing with people.
- **Near-copy check:** a 16×16 grey thumbnail of the face, compared in the browser. Measured on the detector's crops: re-encoded, shifted or brighter copies differ by 0.03–0.06; a 6° head tilt by 0.22; glasses by 0.31. Threshold: 0.12.
- **Patient view.** A face the server hasn't confirmed yet gets a slow cyan scan, with no name. A face saved as Unknown gets only a faint outline. A confirmed person gets a name tag. Tapping it (or Tab, then Enter) opens a profile card with their saved name, relationship, description ("No description added yet." if empty), last finished visit and remembered facts. No boxes are drawn. With the OS "reduce motion" setting, the scans don't move.
- **Description** is optional everywhere: at enrollment, on the completion screen, from the profile card, and in the caregiver's Edit dialog. It's stored in the existing `people.notes` column (no database migration), and editing it never touches face data.

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
    quality.py         is this face good enough to trust? size, light, blur, head pose from landmarks
    routes.py          /enroll, /enroll/check (live guidance), /people/{id}/photos, /people/{id}/merge
  tests/             face unit tests (fake detector) + real-model tests (synthetic glasses)
  visits.py          visit start/end, "last seen", spoken brief text (stub)
  tts.py             Piper text-to-speech (stub)
  audio.py           mic audio -> Whisper transcripts (stub)
  memory.py          Ollama summaries + facts (stub)
  tools/
    smoke_test.py      end-to-end test on a throwaway server (run before every push)
    test_appearances.py  focused registration, hourly upsert, coverage, and merge tests
    eval_faces.py      measures same-person vs different-person scores, to pick MATCH_THRESHOLD
  requirements.txt   Pinned Python dependencies
  data/              (gitignored, auto-created) app.db, thumbs/, tts/, eval/

web/
  fonts/open-runde/            Open Runde font files + licence (loaded with next/font/local)
  components.json              shadcn/ui config
web/src/
  app/globals.css              Design tokens: colours, radius, iOS-style type scale (text-large-title, ...)
  app/page.tsx                 Patient view (/)
  app/enroll/page.tsx          Enrollment (/enroll)
  app/caregiver/page.tsx       Caregiver dashboard (/caregiver)
  components/ui/               shadcn/ui components (button, card, dialog, select, ...), tuned for 44px targets
  components/app/              AppHeader (top nav), ConnectionStatus (server online chip)
  components/CameraCapture.tsx Manual guided photo capture, used by "Add photos"
  components/AutoEnrollCamera.tsx  Hands-free enrollment camera + holographic scan overlay
  components/FaceOverlay.tsx   Video + scan visuals + clickable name tags (no boxes)
  components/patient/          SpeechBubble (spoken brief beside the visitor's face), DateClock, WhoButton,
                               CameraErrorCard, PersonProfileCard (opened from a name tag)
  components/caregiver/        PersonCard, MergeControl, AddPhotosDialog, EditPersonDialog
  lib/api.ts                   Typed REST calls (people, enroll, addPhotos, merge, ...)
  lib/server.ts                Server URL, WebSocket hook with auto-reconnect, shared types
  lib/camera.ts                Webcam hook (on/off) + frame grabbing + face thumbnail for the near-copy check
  lib/autoCapture.ts           Auto-enrollment state machine (pure, unit-tested); tunables in RULES
  lib/nameTags.ts              Name tag + scan layout and animation (pure, unit-tested)
  lib/holo.ts                  Holographic canvas drawing (scan line, oval, progress, turn arrows)
  lib/profile.ts               What the profile card shows (only saved data)
  lib/audio.ts                 Plays the spoken brief (with autoplay-blocked handling) + mic PCM capture
  lib/bubble.ts                Where the speech bubble goes so it never covers the face (pure, unit-tested)
  lib/useWakeLock.ts           Keeps the screen on while the patient view is open
  lib/format.ts                "5 min ago", initials

models/              Piper voice files go here
```

### Feature switches

Turn off features a laptop doesn't need. A disabled feature never loads its model. Faces are always on.

```powershell
$env:FEATURE_AUDIO = "0"; $env:FEATURE_MEMORY = "0"   # also FEATURE_TTS, FEATURE_VISITS
.\.venv\Scripts\python main.py
```
`GET /health` lists which features are on.

### Registration and appearance history

New person records store `registered_at` in UTC ISO 8601 form. Confirmed recognition updates `first_seen_at` and `last_seen_at`; `appearances` stores one row per person and UTC hour, with `first_seen_at` and `last_seen_at` for that hour. A SQLite unique constraint on `(person_id, hour_bucket)` and an atomic upsert prevent frame-level duplicates. Repeated writes are throttled to once per person per hour every 10 seconds while the person remains in view.

On existing databases, initialization backfills `registered_at` from `created_at` and first/last appearance timestamps from available visit start times. Historical timezone-naive values are interpreted in the server machine's local timezone and normalized to UTC. Missing source timestamps stay `NULL` and are shown as `Not available`.

The existing `GET /people/{id}` response now also includes:

- `registered_at`, `first_seen_at`, and `last_seen_at` on the person.
- `appearances`: newest-first hourly records with `hour_bucket`, first/last detection times, and source.
- `hourly_status`: the latest 24 hour buckets with `seen`, `not_seen`, or `monitoring_unavailable`, plus `in_progress` for the current hour.

`not_seen` is returned only when processed camera frames prove uninterrupted coverage of the complete hour. A frame gap longer than `MONITORING_GAP_SECONDS` (default 5 seconds), a disconnect, or a restart splits or closes the coverage interval; absence is otherwise reported as `monitoring_unavailable`. The current hour is always marked in progress. All logs remain in the local SQLite database; no scheduler or network service is used.

### Smoke test (run before every push)

```powershell
cd server
.\.venv\Scripts\python tools\smoke_test.py      # macOS/Linux: .venv/bin/python tools/smoke_test.py
```
It starts its own server on port 8765 with a throwaway data folder, so your real `server/data` is untouched. It uses InsightFace's bundled sample photos, so no real faces are involved. It checks enrollment, duplicate refusal, live recognition, Unknown creation, add photos, merge, edit, delete, and restart persistence. Expect `ALL PASSED`.

Face unit tests and web tests (also no real faces):
```powershell
cd server; .\.venv\Scripts\python -m unittest discover -s tests   # 43 tests
cd ..\web; npm test                                              # 32 tests: auto-capture, name tags, profile card
```

### Server API (so far)

| Method | Path | Purpose |
|---|---|---|
| WS | `/ws` | Browser sends `{type:"frame", jpeg}`; server replies `{type:"faces", faces:[...]}` and broadcasts `memory_updated` |
| GET | `/health` | Server status, number of people and embeddings |
| POST | `/enroll` | multipart: `name`, `relationship`, optional `notes` (description), 3–8 `images` (one good face each). Returns **409** with `candidates` if the face or name is already saved; resend with `force=true` only if it's really a different person |
| POST | `/enroll/check` | multipart: one `image`. Returns face count, box, quality reason, head pose (`yaw`, `pitch`) and "already saved as…". Saves nothing; drives auto-capture |
| POST | `/people/{id}/photos` | multipart: 1–8 `images`. Adds photos to someone already known (e.g. now wearing glasses) |
| POST | `/people/{id}/merge` | JSON `{into_person_id}`. "Unknown #3 is actually Miguel": moves their faces, visits and facts, then deletes the Unknown |
| GET | `/people` · `/people/{id}` | List people / one person with visits, facts, and hourly appearance history |
| PATCH | `/people/{id}` | JSON `{name, relationship, notes}`; `notes` is the optional description (`null` clears it). Naming an unknown makes them known |
| DELETE | `/people/{id}` | Delete a person and everything about them |
| GET | `/visits?person_id=` | Visit history |
| GET | `/thumbs/{id}.jpg` | Face thumbnail |

The full message protocol for upcoming milestones is in `CLAUDE.md`.

### Tuning (`server/config.py`)

| Setting | Default | Change it if… |
|---|---|---|
| `MATCH_THRESHOLD` | 0.45 | People get mixed up → raise it. Known people show as unknown → lower it (measure with `tools/eval_faces.py` first). |
| `MATCH_MARGIN` | 0.08 | The best person must beat the 2nd-best by this much, otherwise no name is shown. |
| `FACE_DET_SIZE` | (480, 480) | Detection too slow on the demo laptop → (320, 320), but faces with glasses are missed more often. |
| `RULES` in `web/src/lib/autoCapture.ts` | — | Auto-capture: how steady (`STABLE_FRAMES`), how centred and large, how far to turn (`TURN_MIN_YAW`). |
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

| Machine | CPU / RAM | GPU | Role |
|---|---|---|---|
| **Demo laptop** | *(fill in)* | NVIDIA RTX 3050 Ti Laptop GPU (4 GB VRAM) | Stage demo, checkpoint tests, final measurements |
| Development laptop | Intel Core i5-12450H, 16 GB RAM | NVIDIA GTX 1650 (4 GB VRAM) | Development; backup demo machine |

Both have 4 GB of VRAM, so the same models run on both: the LLM on the GPU, everything else on the CPU. "Runs on a budget laptop" refers to this 4 GB-VRAM class.

### Measured performance

Only numbers we actually measured, with the machine they were measured on. Final numbers will come from the demo laptop.

| What | Result | Conditions |
|---|---|---|
| Face detect + embed, 1 face | ~40–60 ms per frame | Development laptop (i5-12450H), CPU, `buffalo_s`, det size 320, 640×480 test image |
| Face model load (cached) | ~1–2 s | Development laptop |

---

## Disclosures

Models, frameworks, and tools used. This list will be finalized before submission.

| Item | Use | License / note |
|---|---|---|
| [InsightFace](https://github.com/deepinsight/insightface) `buffalo_s` (SCRFD detector + ArcFace recognizer) | Face detection + embeddings | Model weights are licensed for **non-commercial research use only** |
| ONNX Runtime | Runs the face models on CPU | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) `base` | Speech-to-text | MIT (Whisper weights: MIT) |
| [Ollama](https://ollama.com) + Qwen3 4B (planned) | Memory extraction from transcripts | Qwen3: Apache 2.0 |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) `en_US-lessac-medium` (planned) | Text-to-speech | `piper-tts` library: GPL-3.0; voice: see its model card |
| FastAPI, Uvicorn, NumPy, OpenCV, SQLite | Backend | open source |
| Next.js, React, Tailwind CSS | Frontend | open source |
| [shadcn/ui](https://ui.shadcn.com) + Radix UI | UI components (copied into `web/src/components/ui`) | MIT |
| lucide-react · sonner, cn, tw-animate-css, next-themes · class-variance-authority | Icons, toasts, styling helpers | ISC · MIT · Apache-2.0 |
| [Open Runde](https://github.com/lauridskern/open-runde) | Typeface, bundled in `web/fonts` | SIL OFL 1.1 |
| **Claude Code (Anthropic)** | AI coding assistant used during development | — |

No cloud APIs are called at runtime. The links above are documentation for readers, not used by the app.
