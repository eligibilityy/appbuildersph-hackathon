# Team plan: who builds what, on which branch, by when

Code freeze: **Sat Oct 10, 10:00 AM (Manila)**. Feature freeze: **5:00 AM**. Judges see `main` as of 10:00.

## Where we are (Fri 11:30 PM)

| Done and on `main` | Still a placeholder ("stub") |
|---|---|
| Enrollment with automatic face scan, glasses photos, duplicate check | `server/visits.py`: visits + spoken brief |
| Live recognition, name tags, tap-a-tag profile card | `server/tts.py`: Piper voice |
| Caregiver page: merge Unknowns, add photos, edit, delete | `server/audio.py` + mic in the browser: transcripts |
| Hourly "seen" tracking + person detail page | `server/memory.py`: Ollama summaries + facts |

Each stub already has its **final function signature** and is wired into the pipeline. You fill in the body; don't change the signature without telling Elijah.

## Who does what

| Person | Role | Owns these files (only edit these) | Block A (now - 1:00 AM) | Block B (1:00 - 3:00 AM) |
|---|---|---|---|---|
| **Elijah** | UI + integrator | `web/src/app/*`, `web/src/components/*` (except `FaceOverlay`, `patient/PersonProfileCard`), `README.md`, `docs/` | **`ui-visit-timeline`**: visit list on the person detail page (date, duration, summary, transcript, facts) | **`ui-live-captions`**: live captions on the caregiver page + "speaking…" indicator on the patient view. Merge PRs at each checkpoint. |
| **ryuuu924** | Visits + brief | `server/visits.py`, visit tests | **`visits-brief`**: open/close visits, "last seen", brief text, `speak` on arrival | **`brief-replay`**: add last visit's summary to the brief; "Who's this?" replay |
| **rdean123** | Memory + faces | `server/memory.py`, `server/faces/*`, `server/tools/eval_faces.py`, `web/src/components/FaceOverlay.tsx`, `web/src/components/patient/PersonProfileCard.tsx`, `web/src/lib/autoCapture.ts` | **`memory-ollama`**: Ollama extraction, tested with a typed-in sample transcript | **`faces-tuning`**: team photos → `eval_faces.py` → set `MATCH_THRESHOLD` from real numbers; fix recognition bugs found in testing |
| **Member 4** | Voice in + out | `server/tts.py`, `server/audio.py`, `web/src/lib/audio.ts` | **`tts-piper`**: Piper turns brief text into a `.wav` | **`mic-whisper`**: browser mic → server → Whisper → transcript per visit |

**Shared files** (`server/ws.py`, `server/config.py`, `server/db.py`, `web/src/lib/api.ts`, `web/src/lib/server.ts`): keep changes small. In `config.py`, add your settings only inside your own section. Say in your PR description that you touched a shared file.

### What each feature must do ("done when")

**`visits-brief` (ryuuu924), in `server/visits.py`**
- `update(present_ids)`, called after every frame:
  - when a **known** person is confirmed, open a visit (`visits` table) and return `visit_start`, plus a `speak` event (`brief_text` → `tts.speak`)
  - when they've been gone `VISIT_END_SECONDS` (30 s; demo `VISIT_END_SECONDS=10`), close it, return `visit_end` and call `memory.enqueue(visit_id)`
  - Unknowns get visits too, but **never** a `speak` event
- `open_visit_ids()` returns open visit ids, which audio uses.
- `brief_text(pid)`: "This is Miguel, your grandson. You last saw Miguel 5 minutes ago." Use the person's name, never "him/her". Use `people.last_seen_at` / the last closed visit.
- `replay_brief()`: the brief for whoever is in view now.
- If `tts.speak()` returns `None` (Piper not ready), still send `speak` with `audio_url: null`, so the UI can show the text.
- **Done when:** walking in prints `visit_start` + the brief in the server log, and walking out for 10 s gives `visit_end`. Add unit tests next to the existing ones in `server/tests/`.

**`tts-piper` (Member 4), in `server/tts.py`**
- Download the voice: `.\.venv\Scripts\python -m piper.download_voices en_US-lessac-medium --data-dir ..\models`. **Don't commit the `.onnx` files** (they're large); the README tells people how to download them.
- Load `PiperVoice` lazily on the first `speak()`, write `config.TTS_DIR/<id>.wav`, return `"/tts/<id>.wav"`. Use `length_scale=config.PIPER_LENGTH_SCALE` (slightly slow).
- Print how long synthesis takes; these are real numbers for the README.
- **Done when:** `python -c "import tts; print(tts.speak('This is Miguel, your grandson.'))"` (from `server/`) prints a URL, and opening `http://127.0.0.1:8000/tts/<id>.wav` plays it. Playback in the patient view is already wired (`lib/audio.ts` `playSpeech`).

**`memory-ollama` (rdean123), in `server/memory.py`**
- `start()` starts a worker thread. `enqueue(visit_id)` queues the visit.
- The worker reads the transcript. If it's very short, it skips. Otherwise it calls Ollama with `config.OLLAMA_MODEL`, `think=False`, `keep_alive=-1`, and `format=` the JSON schema in `CLAUDE.md` (summary, visitor_name, relationship, facts).
- Saves `visits.summary`, `processed=1` and the `facts` rows.
- If the person is **unknown** and a name was stated, set it with `name_source='auto'`, `is_unknown=0`. **Never** overwrite a name a caregiver entered (`name_source='enrolled'`).
- Tell the LLM to refer to the visitor by name, never "he/she". Include the Filipino hints from `CLAUDE.md` (Lola/Lolo → grandchild, etc.).
- Then `hub.broadcast_threadsafe({"type": "memory_updated", "person_id": ...})`. Print the LLM time.
- Develop without the mic: add `server/tools/try_memory.py`, which inserts a visit with a typed transcript ("Hi Lola, it's Miguel, your grandson. I just started a new job in BGC.") and runs extraction.
- **Done when:** that script saves the summary "Miguel just started a new job in BGC." and the matching facts.
- First: `ollama pull qwen3:4b` and `ollama pull qwen3:1.7b`. They're large, so start them now.

**`mic-whisper` (Member 4), in `web/src/lib/audio.ts` + `server/audio.py`**
- **Browser:**
  - `getUserMedia({audio: {echoCancellation: true, noiseSuppression: true}})`, `AudioContext({sampleRate: 16000})` + an AudioWorklet
  - send PCM16 mono chunks of about 100 ms as **binary** on the existing WebSocket
  - **skip sending while `isSpeaking()`**, so the app doesn't transcribe itself
- **Server:**
  - `feed()` buffers audio only while `visits.open_visit_ids()` isn't empty. Never write audio to disk.
  - every 10–15 s, transcribe in a worker thread with faster-whisper (`config.WHISPER_MODEL`, `int8`, `vad_filter=True`)
  - append the text to each open visit's `transcript`, then `hub.broadcast_threadsafe({"type": "transcript", ...})`
- **Done when:** talking during a visit produces `transcript` events and text saved on the visit.

**`ui-visit-timeline` / `ui-live-captions` (Elijah)**
- Person detail page: visits, newest first (start time, duration, summary, expandable transcript), plus facts. The data comes from `GET /people/{id}` → `visits`, `facts`.
- Caregiver page: live captions from `transcript` events while a visit is open.
- Patient view: show the brief text while it's spoken, even when `audio_url` is null.

## Timetable (Manila time)

| Time | What | Checkpoint test |
|---|---|---|
| 11:30 PM - 1:00 AM | **Block A** (see table) | — |
| **1:00 AM** | **Checkpoint 1:** Elijah merges `visits-brief` + `tts-piper` (+ whatever's ready) | Walk in → app **says** "This is Miguel, your grandson. You last saw Miguel…" |
| 1:00 - 3:00 AM | **Block B**; also connect `memory.enqueue` on visit end | — |
| **3:00 AM** | **Checkpoint 2 + Wi-Fi OFF test** | Full loop offline: visit → talk → leave → return → brief includes the summary |
| 3:00 - 5:00 AM | Bug fixes, polish, rehearse the demo script in `CLAUDE.md` | — |
| **5:00 AM** | **Feature freeze**: bug fixes only after this | — |
| 5:00 - 8:00 AM | README: measured numbers + disclosures (Elijah); demo video (everyone) | — |
| **9:30 AM** | Last merge into `main` | — |

**If we fall behind, cut in this order:** live captions → face threshold tuning → "Who's this?" replay. Never cut the Wi-Fi-off test.

## How to work on your branch (every feature, every time)

**1. Start from the latest `main`**
```powershell
git checkout main
git pull
```
**2. Make your branch** (names are in the table above)
```powershell
git checkout -b visits-brief
```
**3. Work only in your files. Commit small and often:**
```powershell
git status
git add server/visits.py server/tests/test_visits.py
git commit -m "Open and close visits on arrival/departure"
```
**4. Push often** (it's your backup):
```powershell
git push -u origin visits-brief    # first time
git push                           # after that
```
**5. Before asking to merge**, bring in everyone's latest work and test:
```powershell
git fetch origin
git merge origin/main              # fix conflicts if any, then: git add <files>; git commit
cd server
.\.venv\Scripts\python tools\smoke_test.py               # must say ALL PASSED
.\.venv\Scripts\python -m unittest discover -s tests     # must say OK
cd ..\web
npm install
npm run build
npm test                           # if you touched web/
```
**6. Open a pull request**
```powershell
gh pr create --base main --fill
```
Or on GitHub: **Compare & pull request**. In the description, say what it does and how you tested it.

**7. After Elijah merges it:** start the next feature from a fresh `main`:
```powershell
git checkout main
git pull
git branch -d visits-brief
git checkout -b brief-replay
```

**After every `git pull`:** restart the Python server (it only reads code at startup). Run `npm install` in `web/` if `package.json` changed.

## Rules

1. **Never commit to `main` directly.** Use a branch and a PR. Elijah merges.
2. **Never `git push --force`** on a branch someone else uses.
3. **Never commit `server/data/`** (real faces, transcripts) or model files (`models/*.onnx`).
4. **Only run `npm` inside `web/`.** Running it elsewhere creates stray `package-lock.json` files.
5. **No internet at runtime:** no cloud APIs, CDNs or Google Fonts. `grep -rn "https://" web/src` must print nothing.
6. **Never make up numbers.** Only report timings we measured (the server prints them).
7. **Stuck for more than 20 minutes?** Ask in the group chat.

## Where each feature plugs in

```
browser frame ─▶ ws.py ─▶ faces.engine.process(img) ─▶ FrameResult(faces, present_person_ids, new_people)
                       ├─▶ visits.record_confirmed_appearances(...)     (hourly "seen", already done)
                       └─▶ visits.update(present_ids) ─▶ events: visit_start / speak / visit_end
                                 │ on arrival: brief_text(pid) ─▶ tts.speak(text) ─▶ "/tts/<id>.wav"
                                 └ on end:     memory.enqueue(visit_id)
browser mic (binary) ─▶ ws.py ─▶ audio.feed(pcm) ─▶ transcript text on visits.open_visit_ids()
"Who's this?"        ─▶ ws.py ─▶ visits.replay_brief()
worker threads ─▶ hub.broadcast_threadsafe(event)      async code ─▶ await hub.broadcast(event)
```

To work on one feature without the others' models, turn the rest off:
```powershell
$env:FEATURE_AUDIO = "0"; $env:FEATURE_MEMORY = "0"
.\.venv\Scripts\python main.py
```
Faces are always on. `GET /health` shows which features are on.
