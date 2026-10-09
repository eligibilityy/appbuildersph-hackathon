# CLAUDE.md — Face memory aid for dementia patients (AppBuildersPH Hackathon 2026)

## What we're building

A local-AI memory aid for people with dementia. A camera recognizes the people who visit the patient, listens to the conversation, remembers who they are and what they talked about, and **speaks a short reminder out loud** the next time that person appears:

> "This is Miguel, your grandson. You saw him on Tuesday. He told you about his new job in BGC."

**Everything runs on-device. The app must work fully with Wi-Fi off** — this is demonstrated live on stage.

## Hackathon constraints (non-negotiable)

- Theme is **Local AI**: meaningful inference must run locally. **Do not add any cloud API, CDN, analytics, telemetry, or remote font.**
- **Code freeze: 10:00 AM, Oct 10, 2026 (Asia/Manila).** Judges review the repo as of that time. Repo must be public. Commit early and often.
- Project must be substantially built during the hackathon (started Oct 9, 2:30 PM).
- **Never fabricate benchmarks or performance numbers.** Only report numbers we actually measured.
- README must let judges recreate the app (deployment not required).
- Submission must disclose models, frameworks, APIs, existing code, and AI dev tools (Claude is one of them).
- **Never commit `server/data/`** (face embeddings, thumbnails, transcripts of real people). It must be in `.gitignore`.

## Target hardware (design for this)

- 16 GB RAM, **NVIDIA GTX 1650 (4 GB VRAM)**, likely Windows (confirm with the team).
- Rule: **only the LLM uses the GPU** (via Ollama, which bundles CUDA). Faces, Whisper, and TTS run on **CPU**. Do not set up CUDA/cuDNN for onnxruntime or CTranslate2 unless explicitly asked.
- Must also work CPU-only (fallback config below). "Runs on a budget laptop" is a pitch point.

## Stack

### Frontend — `/web`
- Next.js (App Router) + TypeScript + Tailwind (+ shadcn/ui optional)
- **Fonts: `next/font/local` or system fonts only.** No `next/font/google`, no CDN links of any kind.
- Camera: `getUserMedia`, send ~5 fps JPEG frames (quality ~0.7, max 640px wide) over WebSocket
- Mic: `AudioWorklet`, `AudioContext({ sampleRate: 16000 })`, PCM16 mono chunks (~100 ms) over the same WebSocket. Use `echoCancellation: true, noiseSuppression: true`.
- Overlay: `<canvas>` over `<video>` drawing boxes + names from server events
- Audio out: `<audio>` playing WAVs from the server
- Demo launch: `next build && next start`, then `chrome --app=http://localhost:3000` (`--kiosk` on stage)

### Backend — `/server`
- Python 3.11, FastAPI + uvicorn
- One WebSocket `/ws` for live data; REST for dashboard + enrollment
- SQLite (`server/data/app.db`)
- Face matching: numpy cosine similarity in memory over all stored embeddings (few dozen people max — no vector DB)
- A background worker thread + queue for Whisper and LLM jobs so the face loop never blocks

### Models

| Job | Default (target hardware) | CPU-only fallback | Notes |
|---|---|---|---|
| Faces | InsightFace `buffalo_s`, `det_size=(320,320)`, CPU (`CPUExecutionProvider`) | same | ArcFace 512-d embeddings, L2-normalized. Non-commercial model license — disclose. |
| STT | faster-whisper `small`, `device="cpu"`, `compute_type="int8"`, `vad_filter=True` | `base` | Multilingual model (not distil) so Taglish works. Try `language=None` first; pin to `"en"` if detection flips around. |
| LLM | Ollama `qwen3:4b` on GPU | `qwen3:1.7b` or `llama3.2:3b` | Options: `num_ctx=4096`, `keep_alive=-1`, thinking OFF (`think=False`), structured output via `format=<JSON schema>`. |
| TTS | Piper `en_US-lessac-medium` (.onnx + .json in `/models`) | same | Check the installed `piper-tts` version's API (it changed between versions). |

All model choices live in `server/config.py` so they can be swapped in one place.

## Architecture

```
Next.js (localhost:3000)                    FastAPI (localhost:8000)
 ├─ webcam frames (JSON) ───────────────▶   faces.py: detect → embed → match → track
 ├─ mic PCM16 (binary) ─────────────────▶   audio.py: buffer per open visit
 ├─ overlay / name card  ◀── events ────    visits.py: visit start/end, brief trigger
 ├─ <audio> ◀── /tts/{id}.wav ──────────    tts.py: Piper
 └─ /caregiver ◀── REST ────────────────    memory.py: Whisper + Ollama jobs (worker thread)
                                             db.py: SQLite
                                             Ollama on localhost:11434
```

## WebSocket protocol (`/ws`)

**Client → server**
- Text JSON: `{ "type": "frame", "ts": <ms>, "jpeg": "<base64>" }`
- Binary: raw PCM16 LE mono 16 kHz audio chunk
- Text JSON: `{ "type": "replay_brief" }` — "Who's this?" button / spacebar

**Server → client**
- `{ "type": "faces", "faces": [{ "box": [x1,y1,x2,y2], "person_id": int|null, "name": str|null, "relationship": str|null, "score": float }] }`
- `{ "type": "visit_start", "visit_id": int, "person_id": int }`
- `{ "type": "visit_end", "visit_id": int, "person_id": int }`
- `{ "type": "speak", "text": str, "audio_url": "/tts/<id>.wav" }`
- `{ "type": "transcript", "visit_id": int, "text": str }` (live captions on caregiver view)
- `{ "type": "memory_updated", "person_id": int }`

## REST API

- `GET /people` · `GET /people/{id}` (with visits + facts) · `PATCH /people/{id}` · `DELETE /people/{id}`
- `POST /enroll` — multipart: `name`, `relationship`, 3–5 images. Reject images with 0 or >1 faces. Save a thumbnail.
- `GET /visits?person_id=` · `GET /tts/{id}.wav` · `GET /thumbs/{person_id}.jpg` · `GET /health`

## Database schema

```sql
CREATE TABLE people (
  id INTEGER PRIMARY KEY,
  name TEXT,                       -- null or "Unknown #N" for unlabeled
  relationship TEXT,               -- relative to the patient: "grandson", "daughter", "caregiver"
  notes TEXT,
  is_unknown INTEGER DEFAULT 0,
  name_source TEXT,                -- 'enrolled' | 'auto' (LLM-extracted, caregiver should confirm)
  created_at TEXT
);
CREATE TABLE face_embeddings (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  embedding BLOB,                  -- float32[512], L2-normalized
  created_at TEXT
);
CREATE TABLE visits (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  started_at TEXT, ended_at TEXT,
  transcript TEXT,
  summary TEXT,                    -- 1–2 sentences, addressed to the patient
  processed INTEGER DEFAULT 0
);
CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  fact TEXT,
  created_at TEXT
);
```

## Core logic (tunable constants in `config.py`)

- `MATCH_THRESHOLD = 0.45` (cosine similarity; tune with real faces)
- `CONFIRM_FRAMES = 5` — a track must agree on identity for 5 frames before it counts
- `VISIT_END_SECONDS = 30` — visit ends after the person is out of frame this long
- `MAX_EMBEDDINGS_PER_PERSON = 20` — add new embeddings from confident matches occasionally (different angles), cap the count

**Recognition:** match each detected face against all embeddings; best person's max similarity ≥ threshold → match. Unmatched for `CONFIRM_FRAMES` → create an `Unknown #N` person (is_unknown=1) with that embedding, so returning strangers are recognized as the same unknown.

**Visits:** open a visit per person on confirmed arrival; close after `VISIT_END_SECONDS` absent. Audio chunks are appended to **all currently open visits** (no speaker diarization — deliberately out of scope).

**Transcription:** while any visit is open, transcribe buffered audio every ~10–15 s in the worker thread; append to the visit transcript; emit `transcript` events. **Ignore mic audio while our own TTS is playing** (+ ~500 ms) so the app doesn't transcribe itself. Never save raw audio to disk.

**Memory extraction:** on visit end, if transcript is non-trivial, call Ollama with this JSON schema:
```json
{
  "summary": "string — 1–2 short sentences addressed to the patient, e.g. 'He told you about his new job in BGC.'",
  "visitor_name": "string or null — only if the visitor clearly states it",
  "relationship": "string or null — visitor's relationship TO THE PATIENT",
  "facts": ["string — short, concrete facts stated in the conversation"]
}
```
Prompt rules: only use what was said; never invent; null when unsure. Hint for Filipino context: if the visitor calls the patient "Lola/Lolo" they are likely a grandchild; "Nanay/Mama/Tatay/Papa" → child; "Tita/Tito" → niece/nephew. If the person is unknown and a name was extracted, set it with `name_source='auto'` and `is_unknown=0`.

**Spoken brief** (template, from SQLite — NOT generated by the LLM at speak time, so it's instant):
- Known with history: "This is {name}, your {relationship}. You last saw {pronoun-free phrasing} {humanized time}. {last summary}"
- Known, no history: "This is {name}, your {relationship}."
- Unknown: say nothing to the patient (show on caregiver view only).
- Speak once per visit on confirmed arrival; `replay_brief` repeats it. Short sentences, slightly slow voice (Piper `length_scale` ~1.15).

## Features (priority order — do not start a tier until the previous one works end to end)

**Must (the demo depends on these)**
1. Enrollment page: name + relationship + capture 5 face shots
2. Live recognition with boxes + names on the patient view
3. Visit tracking + "last seen"
4. Per-visit conversation transcription
5. Memory extraction (summary + facts + auto-name from introductions)
6. Spoken brief on arrival
7. Works fully offline (Wi-Fi off)

**Should**
8. "Who's this?" button + spacebar → replay brief
9. Caregiver dashboard: people list, visit timeline, facts, edit/confirm names, delete person
10. Unknown faces auto-saved for labeling; live captions on caregiver view

**Could**
11. Spoken daily recap ("Today you saw Ana and Miguel")
12. Ask-your-memories: patient asks a question → put all facts in the LLM prompt → spoken answer (no RAG needed at this scale)
13. Long-stay stranger alert on caregiver view

## UI principles

- **Patient view (`/`)**: voice-first, zero interaction required. Very large name + relationship card, high contrast, minimal text, no small controls. One big "Who's this?" button.
- **Caregiver view (`/caregiver`)**: normal dashboard density. Thumbnails, timelines, edit forms.
- **Enroll (`/enroll`)**: simple guided capture ("look straight", "turn slightly left"...).

## Repo layout

One module per feature, each with one owner (see `docs/TEAM_PLAN.md`). Keep new code inside the feature it belongs to, and don't change a stub's function signature without telling the lead.

```
/web/src
  app/            pages: / (patient), /enroll, /caregiver — keep thin
  components/     FaceOverlay, NameCard, caregiver/PersonCard
  lib/            api.ts (typed REST), server.ts (WS hook + types), camera.ts, audio.ts
/server
  main.py         wires features together (thin)
  config.py       all model names + constants + FEATURES switches (FEATURE_<NAME>=0)
  db.py           shared SQLite schema + connect(); queries live in each feature module
  hub.py          connected clients, broadcast() / broadcast_threadsafe(), shared FaceEngine
  ws.py           /ws dispatcher: frame → faces → visits; binary → audio; replay_brief → visits
  people.py       /people CRUD, /thumbs
  faces/          engine.py (model, gallery, enroll/add photos/merge), tracker.py, quality.py, routes.py
  visits.py       visit lifecycle, brief text
  audio.py        PCM buffering, Whisper transcription
  memory.py       Ollama extraction, worker queue
  tts.py          Piper synthesis → server/data/tts/*.wav
  tools/          smoke_test.py (run before every push), eval_faces.py (threshold tuning)
  data/           (gitignored) app.db, thumbs/, tts/, eval/
/models           Piper voice files (+ README notes on InsightFace/Whisper cache)
/docs/TEAM_PLAN.md  feature order, timetable, file ownership
README.md         setup, offline prep, hardware, disclosures
```

## Setup notes

- Python: venv, `pip install fastapi "uvicorn[standard]" python-multipart numpy opencv-python-headless insightface onnxruntime faster-whisper piper-tts ollama`
- Windows: `insightface` may need Microsoft C++ Build Tools to install.
- `ollama pull qwen3:4b` (and the fallback model).
- Pre-cache everything once with internet, then run with `HF_HUB_OFFLINE=1`.

## Offline checklist (verify before 2 AM, and again on the demo laptop after a reboot)

- [ ] InsightFace models cached (`~/.insightface`)
- [ ] faster-whisper model cached; `HF_HUB_OFFLINE=1` set
- [ ] Piper voice files in `/models`
- [ ] Ollama model pulled; `ollama ps` shows 100% GPU
- [ ] No `next/font/google`, no CDN `<script>`/`<link>`, no external URLs anywhere (`grep -r "https://" web/src`)
- [ ] No Web Speech API usage
- [ ] Full end-to-end run with Wi-Fi OFF

## Build order & milestones (Manila time, Oct 9–10)

1. **by 7 PM** — Webcam → `/ws` → InsightFace → names drawn on canvas; enrollment works; SQLite persists.
2. **by 10 PM** — Mic streaming → Whisper transcripts per visit; Piper speaks the name on arrival.
3. **by 2 AM** — Ollama extraction; "last seen"; full spoken brief; **offline test passes**.
4. **by 5 AM** — Caregiver dashboard, unknown-face labeling, replay button. Feature freeze.
5. **by 8 AM** — README (setup, hardware, measured performance, disclosures), ~1 min demo video.
6. **by 9:30 AM** — Submit. Repo public. Final commit before 10:00 AM.

## Demo script (Wi-Fi off on stage)

1. Turn off Wi-Fi visibly.
2. Teammate walks in → "Unknown" on screen.
3. They chat: "Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."
4. They leave (visit closes, memory extracted), then return.
5. App speaks: "This is Miguel, your grandson. You saw him a few minutes ago. He just started a new job in BGC."

For the demo, consider lowering `VISIT_END_SECONDS` (e.g. 10 s) via config so the loop fits the 5-minute pitch.

## Working conventions for Claude Code

- Prefer simple, working code over abstractions. This is an 18-hour build.
- Keep the face loop non-blocking; heavy work goes to the worker thread.
- Log timings (detect/embed, transcribe, LLM) to the console so we can report **real** measurements.
- After each milestone: run it, confirm it works, commit with a clear message.
- Never introduce a network dependency. If a library tries to download at runtime, cache it ahead of time and document it in the README.
