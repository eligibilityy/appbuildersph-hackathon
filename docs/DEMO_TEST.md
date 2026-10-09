# Demo laptop: pull + test (rdean123)

Step by step for the demo laptop: update, check the models, go offline, run the full demo loop, then the Tagalog/Taglish test. Run everything in **PowerShell**, in the `appbuildersph-demo` folder (the copy that stays on main).
Close any other copy of the server first: only one program can use port 8000.

## A. Update (Wi-Fi ON)
```powershell
cd appbuildersph-demo
git checkout main
git pull                                    # should show the latest "Merge pull request #..."
cd server
.\.venv\Scripts\pip install -r requirements.txt
cd ..\web
npm install
npm run build                               # must finish without errors
cd ..
```

## B. Check the models (Wi-Fi ON)
```powershell
ollama list                                 # needs qwen3:4b (and qwen3:1.7b as fallback)
dir models                                  # needs en_US-lessac-medium.onnx + .onnx.json
cd server
# Whisper base (the app's default). Prints "whisper base cached"; quick if it's already downloaded:
.\.venv\Scripts\python -c "import os; os.environ['HF_HUB_OFFLINE']='0'; from faster_whisper import WhisperModel; WhisperModel('base', device='cpu', compute_type='int8'); print('whisper base cached')"
.\.venv\Scripts\python tools\try_loop.py    # whole loop with real models, no camera/mic
ollama ps                                   # PROCESSOR column: is it 100% GPU?
```
- `try_loop.py` must end with **`[loop] PASS`**. Copy its output into the chat (the timings are real measurements).
- A missing model? Download it now, while there's internet (README > Models).
- `ollama ps` shows less than 100% GPU? Close Chrome tabs and other GPU apps, then run `ollama stop qwen3:4b` and run `try_loop.py` again. Still not 100%? Use the smaller model from now on: before step D, run `$env:OLLAMA_MODEL = "qwen3:1.7b"`.

## C. Go offline
1. Plug in the charger. Set Windows power mode to **Best performance**.
2. **Turn Wi-Fi OFF and restart the laptop** (this checks it works offline from a cold start).
3. After logging in, check that Ollama is running: `ollama list` should print the models. If it errors, open Ollama from the Start menu.

## D. Start the app (3 PowerShell windows)
**Window 1: server** (fresh demo database, so test people don't show up on stage):
```powershell
cd appbuildersph-demo\server
$env:DATA_DIR = "C:\memaid-demo"
$env:VISIT_END_SECONDS = "5"
$env:PYTHONUNBUFFERED = "1"
.\.venv\Scripts\python main.py 2>&1 | Tee-Object -FilePath C:\memaid-demo-log.txt
```
Wait until these 3 lines have appeared (about 30 s):
```
[tts] voice ready in ...
[audio] Whisper base ready in ...
[memory] qwen3:4b loaded in ...
```

**Window 2: web**
```powershell
cd appbuildersph-demo\web
npm start
```

**Window 3: open the app**
```powershell
start chrome --app=http://localhost:3000 --autoplay-policy=no-user-gesture-required
start chrome --app=http://localhost:3000/caregiver
```
Allow the camera and microphone when asked. The patient view must say **Connected**, with no "Mic off" or "Voice off" chips.

**Optional:** enroll one known person (for example a teammate as "Ana, daughter") at `http://localhost:3000/enroll`, so the caregiver page isn't empty. **Don't enroll the person playing Miguel.**

## E. Run the test (2–3 times)
| # | Do | Pass if |
|---|---|---|
| 1 | "Miguel" (not enrolled) walks in and faces the laptop from about 1 m | A neutral scan appears and **nothing is spoken** |
| 2 | He says, loudly and slowly: *"Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."* | Caregiver window: captions appear about every 5 s while he talks |
| 3 | He walks out of view and waits | ~5 s later the visit closes and the log shows `[audio] transcribed` and then `[memory] visit N: LLM … Unknown -> Miguel (auto)`. The caregiver page shows **Miguel** with the summary |
| 4 | Once the summary shows, he walks back in | The app **says** "This is Miguel, your grandson. You last saw Miguel … ago. Miguel just started a new job in BGC.", and the bubble sits **beside** his face |
| 5 | Press **Who's this?** (or the spacebar) | It says the brief again |

**Keep his face in view while he talks.** The visit ends 5 s after the camera loses him. If he turns away for longer, it counts as a new visit and the brief plays again.

**Between runs:** a second run needs a new stranger. Either:
- delete Miguel on the caregiver page (⋯ → Delete) and use the same person again, or
- stop the server (Ctrl+C) and delete `C:\memaid-demo` for a clean start.

## E2. Tagalog and Taglish test
Visitors can speak English, Taglish or Tagalog; the spoken reminder stays in English (README > Languages).

**Quick check, no mic** (server window can stay closed):
```powershell
cd appbuildersph-demo\server
.\.venv\Scripts\python tools	ry_memory.py --transcript "Magandang hapon po, Lola. Ako po si Ana, apo ninyo. Galing po ako sa Baguio kahapon."
.\.venv\Scripts\python tools	ry_memory.py --transcript "Hi Lola! Si Miguel po ito, apo niyo. Lumipat na po ako ng trabaho, sa BGC na po ako nagwo-work ngayon."
```
Pass if: the first prints `name='Ana'` and an **English** summary about Baguio; the second prints `name='Miguel'`, `grandson` and a summary about the job in BGC.

**Real voice** (app running as in step D): three different strangers, one visit each (delete the auto-named person between visits, or use another teammate):

| Visitor says | Captions (caregiver window) | After they leave (log + caregiver page) |
|---|---|---|
| *"Magandang hapon po, Lola. Ako po si Ana, apo ninyo. Galing po ako sa Baguio kahapon."* | Proper Tagalog words, not English-sounding gibberish | `Unknown -> Ana (auto)`, English summary about Baguio |
| *"Hi Lola! Si Miguel po ito. Lumipat na po ako ng trabaho, sa BGC na po ako ngayon."* | Taglish, as spoken | Miguel, summary about the new job |
| *"Hi Lola, it's Carlo, your grandson. I'm getting married in December."* | English, word for word | Carlo, summary about the wedding |

When each walks back in, the app speaks **in English** with their summary (e.g. "This is Ana, your grandchild. … Ana just came from Baguio yesterday.").

**Only if the Tagalog captions are poor**, try Whisper `small`:
```powershell
# Wi-Fi ON, once:
.\.venv\Scripts\python -c "import os; os.environ['HF_HUB_OFFLINE']='0'; from faster_whisper import WhisperModel; WhisperModel('small', device='cpu', compute_type='int8')"
# then restart the server (step D) with this line added before main.py:
$env:WHISPER_MODEL = "small"
```
Repeat the Tagalog visit. Keep `small` only if the captions are clearly better and `[audio] transcribed ... in Xs` stays under ~5 s.

## F. Send these back
From `C:\memaid-demo-log.txt`, copy the lines that start with:
- `[faces] detect+embed`
- `[audio] transcribed`
- `[memory] visit`
- `[tts] synthesized`
- the three warm-up lines

Also copy the `ollama ps` output and the laptop's **CPU and RAM** (Settings > System > About). These go in the README as our measured numbers.

From E2: the caption text of each visit (copy it from the caregiver page), and whether `small` was needed.

## If something goes wrong
| Problem | Fix |
|---|---|
| No sound, and a "Tap to turn on sound" chip shows | Tap the screen once (or relaunch Chrome with the `--autoplay-policy` flag) |
| "Voice off" chip | The Piper files are missing from `appbuildersph-demo\models` (copy them from the other folder) |
| "Mic off" chip | Allow the microphone (lock icon in the address bar), then reload |
| No captions or transcript | Speak closer and louder; check the log for `[audio] transcription failed` |
| `[memory] … failed` | Ollama isn't running (start it from the Start menu); the visit is retried when the server restarts |
| LLM takes more than 10 s | Run `ollama ps`; if it isn't 100% GPU, restart the server with `$env:OLLAMA_MODEL = "qwen3:1.7b"` |
| The name tag says the wrong person / an Unknown | Improve the lighting and face the camera; look at the `[faces]` lines in the log |
| Port 8000 already in use | Another server is running: close its window or press Ctrl+C there |
