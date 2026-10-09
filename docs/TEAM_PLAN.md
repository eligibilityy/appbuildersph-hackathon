# Team plan: features, timetable, who does what

Code freeze: **Sat Oct 10, 10:00 AM (Manila)**. We build **one feature at a time, core first**. Each member owns their own files, so we rarely edit the same file.

## Features in priority order

| Tier | Feature | Why |
|---|---|---|
| **Core** | **Face recognition, made robust:** quality gate, track-averaged matching + margin check, keep the name through look changes (glasses, hair), threshold measured on our faces | Everything else depends on knowing who's there |
| **Core** | **Fixing mistakes:** add photos to an existing person; merge "Unknown #N" into a person | How the app copes with new glasses / haircuts |
| **Core** | **Visits + "last seen"** | Needed by the brief, transcripts, and memory |
| **Core** | **Speak the name on arrival** (Piper) | Cheap, and the biggest demo moment |
| Next | Mic → Whisper transcripts per visit | Input for memories |
| Next | Full spoken brief + "Who's this?" replay | The demo line |
| Next | Caregiver timeline | Shows the memory to judges |
| Later | Ollama / Qwen memory extraction (summary, facts, auto-name) | "He just started a new job in BGC" |
| Later | Live captions, polish | Nice to have |

## Who does what

Assign a name to each role.

| Member | Role | Owns these files | Block 1 — core (8:30–11:30 PM) | Block 2+ |
|---|---|---|---|---|
| **1 — Lead / integrator** | wiring, merges, visits | `server/main.py`, `ws.py`, `hub.py`, `db.py`, `config.py`, `visits.py`, `people.py` | Visits + "last seen" in `visits.py`; brief template | Full brief + replay; Ollama in `memory.py`; Wi-Fi-off test; final integration |
| **2 — Face recognition** | the core | `server/faces/*`, `server/tools/eval_faces.py` | `quality.py` (blur/pose/size); track-averaged matching + margin check; continuity learning in `tracker.py` | Collect team photos → run `eval_faces.py` → set `MATCH_THRESHOLD` from real numbers; try `buffalo_l` only if the numbers justify it |
| **3 — Voice & audio** | speech in and out | `server/tts.py`, `server/audio.py`, `web/src/lib/audio.ts` | Piper in `tts.py` (download the voice, `speak()` returns a URL); playback already wired in the patient view | Mic AudioWorklet in `audio.ts`; Whisper in `audio.py`; `transcript` events |
| **4 — Frontend / UX** | screens + docs | `web/src/components/*`, `web/src/app/*`, `web/src/lib/api.ts` | Caregiver: "This is…" merge for Unknowns + "Add photos" (`api.merge`, `api.addPhotos` already exist); enroll quality feedback; patient view polish | Caregiver timeline, facts, live captions; README final, measured numbers, demo video |

**Already done:** Milestone 1 (live recognition, enrollment, SQLite) and the feature-by-feature refactor. The `/people/{id}/photos` and `/people/{id}/merge` endpoints also exist and are tested, so Member 4 can build the UI right away and Member 2 can focus on matching quality.

### Where each feature plugs in (these contracts are fixed)

```
browser frame ─▶ ws.py ─▶ faces.engine.process(img) ─▶ FrameResult(faces, present_person_ids, new_people)
                                      │
                                      └─▶ visits.update(present_ids) ─▶ events: visit_start / speak / visit_end
                                                 │ on arrival: brief_text(pid) ─▶ tts.speak(text) ─▶ "/tts/<id>.wav"
                                                 └ on end:     memory.enqueue(visit_id)
browser mic (binary) ─▶ ws.py ─▶ audio.feed(pcm) ─▶ appends text to visits.open_visit_ids()
"Who's this?"        ─▶ ws.py ─▶ visits.replay_brief()
worker threads ─▶ hub.broadcast_threadsafe(event)      async code ─▶ await hub.broadcast(event)
```

Each stub (`visits.py`, `tts.py`, `audio.py`, `memory.py`, `faces/quality.py`) already has its final function signature and a docstring saying what to build. Fill in the body; don't change the signature without telling the lead.

## Timetable (Manila time)

| Time | What | Done when |
|---|---|---|
| ✅ 7:45 – 8:30 PM | Refactor (Member 1). Others: laptop setup, models for their role, Member 2 collects eval photos | Smoke test passes; pushed to `main` |
| 8:30 – 11:30 PM | **Block 1 — core** (see table) | An enrolled teammate is recognized with and without glasses; the app says "This is Miguel, your grandson" on arrival |
| 11:30 PM – 12:00 AM | **Checkpoint 1:** merge everything, full run on the demo laptop | Core demo loop works |
| 12:00 – 2:30 AM | **Block 2:** Whisper (3), full brief + replay (1), threshold tuning (2), caregiver timeline (4) | Transcripts saved per visit; spoken brief includes "last seen" |
| 2:30 – 3:00 AM | **Checkpoint 2 + first Wi-Fi-OFF test** | Full loop runs offline |
| 3:00 – 5:00 AM | **Block 3:** Ollama/Qwen memory (1 + 3), captions + polish (4), bug fixes (2) | Brief includes "Miguel just started a new job in BGC" |
| **5:00 AM** | **Feature freeze** | Bug fixes only after this |
| 5:00 – 8:00 AM | README final (measured numbers, disclosures), demo video, rehearsal with Wi-Fi off | Video recorded; README lets a stranger rebuild the app |
| 8:00 – 9:30 AM | Buffer, make the repo public, submit | Submitted |
| **before 10:00 AM** | Final commit | — |

**If we fall behind:** drop the `buffalo_l` test and live captions first. Never drop the Wi-Fi-off test.

## Git rules

1. One branch per task: `faces-quality`, `visits`, `tts-piper`, `caregiver-merge`, ...
2. Before every push, run the smoke test from `server/`:
   ```powershell
   .\.venv\Scripts\python tools\smoke_test.py
   ```
   For web changes, also run `npm run build` in `web/`.
3. Small PRs into `main`. The lead merges. Pull `main` at every checkpoint.
4. Only edit files you own. If you need a change in someone else's file, tell them, or make it tiny and say so in the PR.
5. Never commit `server/data/` (real faces). Eval photos go in `server/data/eval/`, which is gitignored.

## Working on just your feature

Turn off features you don't need, so your laptop doesn't need their models:

```powershell
$env:FEATURE_AUDIO = "0"; $env:FEATURE_MEMORY = "0"; $env:FEATURE_TTS = "0"
.\.venv\Scripts\python main.py
```
Faces are always on. `GET /health` shows which features are on.
