<img src="web/public/crouie.png" alt="Crouie Logo" width="150">

# Crouie

An AI-powered memory aid, mainly for patients with dementia. *Built for AppBuildersPH Hackathon 2026.*

A camera recognizes the people who visit a patient with dementia, listens to the conversation, remembers who they are and what they talked about, and **speaks a short reminder out loud** the next time that person appears:

> "This is Miguel, your grandson. You last saw Miguel a few minutes ago. Miguel just started a new job in BGC."

**Everything runs on the laptop: faces, speech-to-text, the LLM and the voice. It works with Wi-Fi off.** Hackathon theme: Local AI.

**Demo video:** *(link added at submission)*

---

## What it does

- **Recognizes visitors** from the webcam and shows a name tag above their head. Strangers are saved as "Unknown #N", so a returning stranger is recognized too.
- **Speaks a reminder** when a known person arrives: who they are, your relationship, when you last saw them, and what they told you last time. The **Who's this?** button (or spacebar) repeats it.
- **Listens and remembers.** While someone is in view, the mic is transcribed locally (live captions on the caregiver page). When they leave, the **local LLM** writes a one-line summary, pulls out facts, and **names an Unknown who introduced themselves** ("Hi Lola, it's Miguel…").
- **Understands English, Taglish and Tagalog.** See [Languages](#languages).
- **Caregiver dashboard:**
  - people, visit timeline with transcripts, facts, last-24-hours view
  - name or merge Unknowns, add photos, edit, delete
  - **Ask about your people:** the local LLM answers "What's new with Miguel?" / "Ano'ng balita kay Ana?" from saved memories, out loud
  - **Add a conversation:** a typed backup for the mic
- **Hands-free enrollment.** Type a name, then a guided face scan takes the photos by itself.

---

## Recreate it: step by step

We built and tested this on **Windows 11** (PowerShell). macOS/Linux commands are given where they differ, but we have not tested them.

### 0. What you need

| | |
|---|---|
| **Hardware** | Laptop with a webcam and a mic. An **NVIDIA GPU with 4 GB VRAM** is what we used (GTX 1650 and RTX 3050 Ti); only the LLM uses it. 16 GB RAM. About **5 GB free disk** for the models. |
| **Software** | [Python **3.11**](https://www.python.org/downloads/) (we used 3.11.5) · [Node.js **20+**](https://nodejs.org) (we used 22.19) · [Git](https://git-scm.com) · [Google Chrome](https://www.google.com/chrome/) · [Ollama](https://ollama.com/download) |
| **Internet** | Only for steps 1–4 (one-time downloads). After that, everything runs offline. |

You don't need the Microsoft C++ Build Tools: `insightface` 2.1 installs from a ready-made wheel.

### 1. Get the code

```powershell
git clone https://github.com/eligibilityy/appbuildersph-hackathon.git
cd appbuildersph-hackathon
```

### 2. Install the server (Python)

```powershell
cd server
python -m venv .venv
.\.venv\Scripts\python -m pip install --upgrade pip
.\.venv\Scripts\python -m pip install -r requirements.txt
```
macOS/Linux: `python3.11 -m venv .venv`, then use `.venv/bin/python` instead of `.\.venv\Scripts\python` in every command below.

### 3. Download the AI models (one time, still in `server/`)

```powershell
# Faces: InsightFace buffalo_s (159 MB) -> ~/.insightface/models/buffalo_s
.\.venv\Scripts\python -c "from insightface.app import FaceAnalysis; FaceAnalysis(name='buffalo_s', providers=['CPUExecutionProvider'], allowed_modules=['detection','recognition']).prepare(ctx_id=-1)"

# Voice: Piper en_US-lessac-medium (61 MB) -> repo models/ folder
.\.venv\Scripts\python -m piper.download_voices en_US-lessac-medium --data-dir ..\models

# Speech-to-text: faster-whisper base (142 MB) -> ~/.cache/huggingface/hub
.\.venv\Scripts\python -c "import os; os.environ['HF_HUB_OFFLINE']='0'; from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8')"

# LLM: Qwen3 4B (2.5 GB), plus the 1.7B fallback (1.4 GB). The Ollama app must be installed and running.
ollama pull qwen3:4b
ollama pull qwen3:1.7b
```

**Check:**
- `ollama list` shows both Qwen models.
- The `models` folder (in the repo root) has `en_US-lessac-medium.onnx` and `en_US-lessac-medium.onnx.json`.

### 4. Install and build the web app

```powershell
cd ..\web
npm install
npx next telemetry disable     # Next.js sends anonymous usage data by default; we turn it off
npm run build
```

### 5. Check that the models work (no camera or mic needed)

```powershell
cd ..\server
.\.venv\Scripts\python tools\try_loop.py
```
This runs the whole memory loop on a throwaway database:
1. Piper speaks a visitor's line.
2. Whisper transcribes it.
3. Qwen writes the summary and names the visitor.
4. The visitor "returns", and the brief is spoken.

It must end with **`[loop] PASS`**. Each step prints how long it took on your machine.

### 6. Turn Wi-Fi off (optional)
This proves it runs offline. The server already blocks model downloads (`HF_HUB_OFFLINE=1`) and calls Ollama only on `127.0.0.1`.

### 7. Start the app (two terminals)

**Terminal 1, the server** (from `server/`):
```powershell
$env:VISIT_END_SECONDS = "5"        # demo setting: a visit ends 5 s after the person leaves (default 30)
.\.venv\Scripts\python main.py
```
macOS/Linux: `VISIT_END_SECONDS=5 .venv/bin/python main.py`.

Wait until all of these have printed (about 30 s), so the first visitor doesn't wait for a model to load:
```
[faces] loaded buffalo_s in ...
[tts] voice ready in ...
[audio] Whisper base ready in ...
[memory] qwen3:4b loaded in ...
```

**Terminal 2, the web app** (from `web/`):
```powershell
npm start
```

**Open it in Chrome:**
```powershell
start chrome --app=http://localhost:3000 --autoplay-policy=no-user-gesture-required
start chrome --app=http://localhost:3000/caregiver
```
On macOS/Linux, open both URLs in Chrome.
- Allow the **camera and microphone** when asked.
- The autoplay flag lets the reminder play without a click first. Without it, tap the page once and the "Tap to turn on sound" chip goes away.

### 8. Try it (about 5 minutes, two people)

| # | Do | What you should see / hear |
|---|---|---|
| 1 | On the caregiver window, click **Add person**. Type your name and relationship (e.g. "Elijah", "son"), press **Start face scan**, and follow the prompts | Photos are taken by themselves (look straight, turn left, turn right, smile), then it saves |
| 2 | Go to the patient window (`localhost:3000`) and face the camera | A scan, then your **name tag**. The app **says** "This is Elijah, your son." in a speech bubble beside your face. The mic chip says **Listening** |
| 3 | Step out of view, and let a second person (not enrolled) step in | A faint outline and nothing spoken: they're a stranger. The caregiver page lists them under **Needs a name** |
| 4 | They say, clearly and facing the laptop: *"Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."* | Live captions appear on the caregiver page about every 5 s |
| 5 | They step out of view | About 5 s later the visit closes. A few seconds after that (depending on the GPU), the caregiver page shows **Miguel**, auto-named, with the summary "Miguel just started a new job in BGC." |
| 6 | They step back in | The app says: *"This is Miguel, your grandson. You last saw Miguel … ago. Miguel just started a new job in BGC."* |
| 7 | Press **Who's this?** or the spacebar | It says the brief again |
| 8 | On the caregiver page, tap **What's new with Miguel?** under **Ask about your people** | The local LLM answers out loud, and shows "Answered on this laptop in X s" |
| 9 | Optional, in Tagalog: a new stranger says *"Magandang hapon po, Lola. Ako po si Ana, apo ninyo. Galing po ako sa Baguio kahapon."* | Named **Ana**, with an English summary about Baguio. Or paste the line into **Add a conversation** on a person's page |

**Start over:** stop the server and delete `server/data/` (the database, face thumbnails and voice clips). To keep your data and use a separate demo database, start the server with `$env:DATA_DIR = "C:\memaid-demo"`.

### If your GPU is smaller or slower
- Restart the server with `$env:OLLAMA_MODEL = "qwen3:1.7b"`. It's faster and fits fully in 4 GB of VRAM, but it's weaker on Tagalog. Run `ollama ps` to see the CPU/GPU split.
- Close other apps. On a 16 GB laptop that's nearly full, the LLM slows down a lot.

---

## How it works

```
 Chrome (localhost:3000)                        Python server (127.0.0.1:8000)
 ┌────────────────────────┐  webcam frames ~5/s ┌──────────────────────────────────────────┐
 │ Next.js web app        │ ──────────────────▶ │ faces/   InsightFace (CPU): who is this?  │
 │  /           patient   │  mic PCM16 16 kHz   │ visits   visit start/end, spoken brief    │
 │  /enroll     add face  │ ──────────────────▶ │ audio    faster-whisper (CPU): transcripts │
 │  /caregiver  dashboard │ ◀────────────────── │ memory   Qwen3 via Ollama (GPU): summary,  │
 │                        │  names, captions,   │          facts, auto-name; Ask answers     │
 │                        │  spoken brief (WAV) │ tts      Piper (CPU): the voice            │
 └────────────────────────┘                     │ SQLite   server/data/app.db                │
                                                └──────────────────────────────────────────┘
```

- **No AI runs in the browser.** The web app is the screen: camera, mic, name tags, buttons. The server does all the AI and keeps everything in a local SQLite file.
- **Faces:** each frame, faces are detected and turned into 512-number embeddings, then compared with everyone saved (cosine similarity ≥ 0.45, with a margin over the runner-up).
  - A name appears only after the same person matches for 5 frames in a row.
  - Someone who matches nobody for 5 frames becomes "Unknown #N".
- **Visits:** a visit opens when a person is confirmed in view and closes `VISIT_END_SECONDS` after they leave.
  - On arrival, a known person gets a **template brief built from the database**. It's instant: the LLM is never waited on at speak time. Unknowns are never spoken to the patient.
- **Listening:**
  - The server keeps mic audio **only while a visit is open**, and never saves audio to disk.
  - Whisper transcribes it every 5 s, cutting at a pause so words stay whole. Silent parts are skipped by voice-activity detection.
  - The app ignores the mic while its own voice is playing.
  - When the visit ends, its last words are transcribed before the LLM reads the transcript.
- **Remembering:** when a visit ends, Qwen3 gets the transcript with a JSON schema: summary, visitor name, relationship, facts.
  - Rules: only what was said, never invent.
  - Names are accepted only if they were actually said, and "Lola/Tita" are never taken as names.
  - A caregiver-entered name is never overwritten.
- **Only the LLM uses the GPU.** Faces, Whisper and Piper run on the CPU, so the app fits a 4 GB-VRAM laptop.

## Languages

Visitors can talk in **English, Taglish or Tagalog**. The spoken reminder is in **English**.

- **Hearing (Whisper):** set to Tagalog (`WHISPER_LANGUAGE=tl`, the default).
  - On our test sentences, auto-detect misheard Tagalog as Latin, English or Indonesian.
  - With `tl`, Tagalog was transcribed properly and English sentences still came out word-for-word.
  - `WHISPER_LANGUAGE=auto` turns auto-detect back on.
- **Understanding (Qwen3 4B):**
  - The prompt has a short Tagalog word guide (who "ko"/"niyo" refer to; "apo", "uuwi", "ikakasal"…). It writes summaries and facts in simple English, keeping names and places as said.
  - `memory.clean()` fixes the model's known slips: misspelled places, "Tita" taken as a name, doubled words.
  - On our Tagalog/Taglish test conversations it got the names, relationships and news right. The wording is sometimes clumsy (a name repeated).
- **Speaking (Piper):** there is **no offline Tagalog voice**. None of Piper's 177 voices is Tagalog or Filipino, so the brief is spoken in English.

---

## Models

| Model | Job | Runs on | Size (measured) | Stored in |
|---|---|---|---|---|
| InsightFace `buffalo_s` (SCRFD + ArcFace) | Face detection + recognition | CPU | 159 MB | `~/.insightface/models/buffalo_s` |
| faster-whisper `base` (int8) | Speech-to-text | CPU | 142 MB | `~/.cache/huggingface/hub` |
| Qwen3 4B via Ollama | Summaries, facts, names, Ask answers | GPU | 2.5 GB | `~/.ollama/models` |
| Qwen3 1.7B via Ollama | Fallback LLM for smaller GPUs | GPU | 1.4 GB | `~/.ollama/models` |
| Piper `en_US-lessac-medium` | Text-to-speech | CPU | 61 MB | repo `models/` |
| *Optional:* faster-whisper `small` | More accurate speech-to-text, slower | CPU | 464 MB | `~/.cache/huggingface/hub` |

Model names live in `server/config.py`. Override them per laptop without editing code, e.g. `$env:OLLAMA_MODEL = "qwen3:1.7b"` or `$env:WHISPER_MODEL = "small"`.

**Copy by USB instead of downloading:** copy the folders above to the same place on the other laptop.
- For Ollama, install the app, quit it, copy the whole `models` folder (`blobs` + `manifests`), then check with `ollama list`.
- Whisper's folders are `models--Systran--faster-whisper-base` (and `-small`).

---

## Hardware and measured performance

| Machine | CPU / RAM | GPU | Role |
|---|---|---|---|
| **Demo laptop** (rdean123) | *(added from the final demo run)* | NVIDIA RTX 3050 Ti Laptop GPU, 4 GB VRAM | Stage demo |
| Development laptop | Intel Core i5-12450H, 16 GB RAM | NVIDIA GTX 1650, 4 GB VRAM | Development, backup demo machine |

**Only numbers we actually measured**, with where and how. They come from the server's console log lines (`[faces]`, `[audio]`, `[memory]`, `[ask]`, `[tts]`) and our test tools.

| What | Result | Machine and conditions |
|---|---|---|
| Face detect + embed, 1 face | 40–60 ms per frame | Dev laptop, CPU, det size 320, 640×480 test image |
| Face detect + embed, during full-app tests | 183–306 ms mean per frame | Dev laptop, det size 480, while also running the web app, a test browser and the LLM (RAM ~96% used) |
| Model warm-up at server start | Piper 7.4–8.9 s · Whisper `base` 2.1–5.0 s · Qwen3 4B 10.6–14.1 s | Dev laptop |
| Model warm-up at server start | Faces 0.7 s · Piper 3.13 s · Whisper `base` 0.71 s | **Demo laptop** (one startup). Qwen3 4B reported 0.11 s there because Ollama already had it in memory, so that's not a load time |
| Piper: speak one brief | 0.2–1.0 s | Dev laptop, CPU, after warm-up |
| Whisper `base`: 5 s of speech | 0.8–1.7 s | Dev laptop, CPU, int8 |
| Live captions: first caption after speech starts | 7.0 s (was 14.6 s with 12 s chunks) | Dev laptop, 25.6 s of speech fed in real time |
| Qwen3 4B: summary + facts for one visit | 13.7–18 s | Dev laptop. `ollama ps`: 67% GPU / 33% CPU (the model doesn't fully fit next to Windows) |
| Qwen3 1.7B: same task | 9.4–9.5 s | Dev laptop, 100% GPU, same summary for the demo line |
| Qwen3 4B: summary + facts, warm | 2.6–3.0 s (first call ~8 s) | rdean123's RTX 3050 Ti laptop, measured by him (`ollama ps`: 67% GPU) |
| Ask about your people (Qwen3 4B) | 13–24 s if the question names someone, ~40 s otherwise | Dev laptop, 67% GPU |
| Visitor leaves → memory saved | ~20–22 s (Whisper flush + LLM) | Dev laptop, `tools/try_loop.py`, model warm |

*(Final demo-laptop numbers are added from the stage-run logs.)*

---

## Configuration

All settings are in `server/config.py`. The ones you might change can be set as environment variables when starting the server.

| Setting | Default | What it does |
|---|---|---|
| `VISIT_END_SECONDS` | 30 | Seconds after a person leaves before their visit closes and the summary starts. Demo: 5. Too short and a face that drops out briefly starts a new visit. |
| `TRANSCRIBE_EVERY_SECONDS` | 5 | How often live captions update while a visit is open. |
| `WHISPER_MODEL` / `WHISPER_LANGUAGE` | `base` / `tl` | Speech-to-text model; `tl` handles Tagalog, Taglish and English (`auto` = detect). |
| `OLLAMA_MODEL` | `qwen3:4b` | LLM; `qwen3:1.7b` for smaller GPUs. |
| `OLLAMA_TIMEOUT_SECONDS` | 120 | Give up on an LLM request after this long instead of waiting forever. |
| `DATA_DIR` | `server/data` | Where the database, thumbnails and voice clips go. |
| `FEATURE_AUDIO`, `FEATURE_MEMORY`, `FEATURE_TTS`, `FEATURE_VISITS` | `1` | Set to `0` to switch a feature off (its model is never loaded). Faces are always on. `GET /health` lists what's on. |
| `MATCH_THRESHOLD` / `MATCH_MARGIN` | 0.45 / 0.08 | Face match strictness (code constants; measure with `tools/eval_faces.py` before changing). |
| `CONFIRM_FRAMES` | 5 | Frames a face must agree before a name shows (code constant). |

---

## Tests

From `server/` (no real faces are used; the tests use InsightFace's bundled sample photos and synthetic data):
```powershell
.\.venv\Scripts\python -m unittest discover -s tests   # faces, memory, audio, ask (LLM mocked)
.\.venv\Scripts\python tools\test_visits.py             # visit lifecycle + brief text
.\.venv\Scripts\python tools\test_appearances.py        # registration + hourly appearance history
.\.venv\Scripts\python tools\smoke_test.py              # end-to-end on a throwaway server: expect ALL PASSED
.\.venv\Scripts\python tools\try_loop.py                # real models, no camera/mic: expect [loop] PASS
.\.venv\Scripts\python tools\try_memory.py --transcript "Hi Lola, si Miguel po ito, apo niyo."   # LLM only
```
From `web/`:
```powershell
npm test          # name tags, speech-bubble placement, auto-capture, profile card
npx tsc --noEmit
npx eslint src
```

---

## Server API

| Method | Path | Purpose |
|---|---|---|
| WS | `/ws` | Browser → server: `{type:"frame", jpeg}`, binary PCM16 mic audio, `{type:"replay_brief"}`. Server → browser: `faces`, `visit_start`, `visit_end`, `speak` (text + WAV URL), `transcript`, `memory_updated` |
| GET | `/health` | Status, people/embedding counts, which features are on, whether the voice is available |
| POST | `/enroll` | multipart: `name`, `relationship`, optional `notes`, 3–8 `images` (one good face each). **409** with `candidates` if the face or name is already saved; resend with `force=true` only if it's really a different person |
| POST | `/enroll/check` | multipart: one `image`. Face count, box, quality, head pose, "already saved as…". Saves nothing; drives the guided scan |
| GET | `/people` · `/people/{id}` | List people / one person with visits, facts and hourly appearance history |
| PATCH | `/people/{id}` | JSON `{name, relationship, notes}`. Naming an Unknown makes them known |
| DELETE | `/people/{id}` | Delete a person and everything about them |
| POST | `/people/{id}/photos` | multipart: 1–8 `images`. More photos for someone already known (e.g. now wearing glasses) |
| POST | `/people/{id}/merge` | JSON `{into_person_id}`. "Unknown #3 is actually Miguel": moves faces, visits and facts |
| POST | `/people/{id}/conversations` | JSON `{transcript}`. Remember a typed conversation as a visit (summary, facts, auto-name); returns what the app will say next time |
| POST | `/ask` | JSON `{question}`. The local LLM answers from saved memories only ("I don't remember that." otherwise), with a spoken WAV |
| GET | `/visits?person_id=` · `/tts/{id}.wav` · `/thumbs/{id}.jpg` | Visit history · a spoken clip · a face thumbnail |

The full protocol and database schema are in [`CLAUDE.md`](CLAUDE.md).

---

## Project layout

```
README.md, CLAUDE.md         This guide; the full spec (architecture, protocol, schema, rules)
models/                      Piper voice files (downloaded in step 3; not in git)

server/                      Python 3.11, FastAPI
  main.py                    wires the features together; warms up the models at startup
  config.py                  every setting, model name and feature switch
  db.py, hub.py, ws.py       SQLite schema · broadcast to open pages · the /ws dispatcher
  people.py                  /people CRUD + thumbnails
  faces/                     engine.py (models, matching, enroll/merge), tracker.py (identity across frames,
                             Unknowns), quality.py (light, blur, size, head pose), routes.py
  visits.py                  visit lifecycle, appearance history, the spoken brief
  audio.py                   mic buffering + faster-whisper transcription
  memory.py                  Qwen3 summaries, facts, auto-naming (worker thread) + cleanup of model slips
  ask.py                     Ask about your people + Add a conversation
  tts.py                     Piper voice
  tests/, tools/             unit tests; smoke test, try_loop, try_memory, eval_faces
  data/                      (not in git) app.db, thumbs/, tts/

web/                         Next.js 15, React 19, Tailwind 4, shadcn/ui
  src/app/                   / (patient), /enroll, /caregiver
  src/components/            FaceOverlay (video + name tags), patient/ (SpeechBubble, MicMeter, WhoButton,
                             DateClock, PersonProfileCard), caregiver/ (PersonCard, VisitTimeline, LiveCaptions,
                             AskPanel, ConversationCard, dialogs), AutoEnrollCamera, ui/ (shadcn)
  src/lib/                   server.ts (WebSocket), api.ts (REST), camera.ts, audio.ts, nameTags.ts, bubble.ts,
                             autoCapture.ts (pure logic, unit-tested)
  public/pcm-capture-worklet.js   mic → PCM16 chunks
  fonts/open-runde/          bundled typeface (no Google Fonts)
```

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Patient view says **Server offline** | The server isn't running on port 8000. Start terminal 1. |
| "Camera unavailable" | Allow the camera (lock icon in Chrome's address bar) and close other apps using the webcam. Open the app on the same laptop as the server (`localhost`), not by IP. |
| No sound; a **Tap to turn on sound** chip shows | Tap the page once, or launch Chrome with `--autoplay-policy=no-user-gesture-required`. |
| **Voice off** chip | The Piper files are missing from `models/` (step 3). |
| **Mic off** chip | Allow the microphone (lock icon), then reload. |
| Mic chip says **waiting for a face** | Normal: speech is only transcribed while someone is in view. |
| Error mentioning `HF_HUB_OFFLINE` or "Whisper … isn't downloaded" | The Whisper model named in `WHISPER_MODEL` isn't downloaded. Run its step 3 command with internet on. |
| `[memory] … failed` or Ask says Ollama isn't responding | Start Ollama (Start menu / menu bar). Unprocessed visits are retried when the server restarts. |
| Summaries take long | `ollama ps`: if it isn't mostly GPU, close other apps or use `qwen3:1.7b`. |
| No summaries at all and Ask never answers (log: `[memory] … ReadTimeout`) | Ollama can't load the model the server asks for. Usually another model is already loaded and there isn't room for both. Stop the server, run `ollama ps` and then `ollama stop <model>`, and start the server again with `$env:OLLAMA_MODEL` set to a model that fits (`qwen3:1.7b` on a 4 GB GPU with little free RAM). |
| Web changes don't show | `npm start` serves the last build: run `npm run build` again. |
| `431 Request Header Fields Too Large` | Already handled: the app talks to `127.0.0.1:8000`, not `localhost`, so other projects' cookies aren't sent. Rebuild if you see it. |
| Port 8000 already in use | Another server is running. Close it, or `netstat -ano \| findstr :8000` and stop that PID. |

---

## Privacy

- Faces, voice transcripts and memories stay in `server/data/` on the laptop. It's excluded from git.
- Raw audio is never written to disk.
- No cloud APIs, CDNs, analytics or remote fonts are used at runtime. The links in this README are for readers only.

---

## Team

| GitHub | Built |
|---|---|
| [eligibilityy](https://github.com/eligibilityy) | Web app and UI, integration, Ask panel, README |
| [rdean123](https://github.com/rdean123) | Face recognition and enrollment, memory extraction (Ollama), demo laptop |
| [ryuuu924](https://github.com/ryuuu924) | Visits and the spoken brief |
| [ranzxgit](https://github.com/ranzxgit) | Piper voice, mic capture and Whisper transcription |

Everything was built during the hackathon (from Oct 9, 2:30 PM).

---

## Disclosures

**Models, frameworks, and tools:**

| Item | Use | License / note |
|---|---|---|
| [InsightFace](https://github.com/deepinsight/insightface) `buffalo_s` (SCRFD detector + ArcFace recognizer) | Face detection + embeddings | Code MIT; the pretrained model weights are for **non-commercial research use only** |
| [ONNX Runtime](https://onnxruntime.ai) | Runs the face models on CPU | MIT |
| [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (CTranslate2) + OpenAI Whisper `base` weights | Speech-to-text | MIT |
| [Ollama](https://ollama.com) + [Qwen3](https://github.com/QwenLM/Qwen3) 4B / 1.7B | Summaries, facts, names, Ask answers | Ollama MIT; Qwen3 Apache 2.0 |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) (`piper-tts`) + `en_US-lessac-medium` voice | Text-to-speech | `piper-tts` GPL-3.0; voice: see its model card |
| FastAPI, Uvicorn, NumPy, OpenCV, SQLite, Hugging Face Hub (model download only) | Backend | Open source (MIT / BSD / Apache 2.0 / public domain) |
| Next.js, React, Tailwind CSS | Frontend | MIT |
| [shadcn/ui](https://ui.shadcn.com) + Radix UI, lucide-react, sonner, cn, class-variance-authority, tw-animate-css, next-themes | UI components (generated into `web/src/components/ui`), icons, toasts, styling | MIT / ISC |
| [Open Runde](https://github.com/lauridskern/open-runde) | Typeface, bundled in `web/fonts` | SIL OFL 1.1 |

**Existing code:** none apart from the open-source libraries above and the shadcn/ui components generated by its CLI.

**AI development tools:** **Claude Code (Anthropic)** was used as a coding assistant during development.
