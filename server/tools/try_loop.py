"""Run the whole memory loop with the real models but no camera or mic:
Piper says the demo line -> mic path (audio.feed) -> Whisper -> visit closes -> last words flushed ->
Ollama summary + auto-name -> the visitor "returns" -> the spoken brief.

    cd server
    .venv/Scripts/python tools/try_loop.py
    .venv/Scripts/python tools/try_loop.py --say "Hi Lolo, ako si Ana, your granddaughter. Galing ako sa Baguio."

Uses a throwaway database (your real server/data is untouched). Needs the Piper voice, the Whisper
model and Ollama (see README > Models). Prints each step with how long it took.
"""
import argparse
import os
import sys
import tempfile
import time
import wave
from pathlib import Path

DEMO = "Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--say", default=DEMO, help="what the visitor says")
    args = ap.parse_args()

    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="memoryaid-loop-")
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import numpy as np

    import audio
    import config
    import db
    import memory
    import people
    import tts
    import visits

    db.init()
    pid = people.create_person("Unknown #1", is_unknown=True)  # a stranger walks in

    # 1. The visitor's voice: Piper reads the line, resampled to the mic format (16 kHz PCM16 mono).
    t = time.perf_counter()
    clip = config.TTS_DIR / tts.speak(args.say).rsplit("/", 1)[-1]
    with wave.open(str(clip), "rb") as w:
        rate = w.getframerate()
        voice = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
    clip.unlink(missing_ok=True)
    n = int(len(voice) * 16_000 / rate)
    pcm = np.interp(np.linspace(0, len(voice) - 1, n), np.arange(len(voice)), voice).astype("<i2").tobytes()
    print(f"[loop] visitor says ({n / 16_000:.1f}s of audio, made in {time.perf_counter() - t:.1f}s): {args.say!r}")

    memory.start()
    events = visits.update({pid})
    print("[loop] arrives        :", [e["type"] for e in events], "(Unknown: nothing is spoken)")

    chunk = 3_200  # 100 ms, like the browser
    for i in range(0, len(pcm), chunk):
        audio.feed(pcm[i : i + chunk])
    audio.feed(b"\x00\x00" * 16_000)  # a second of quiet before leaving

    t = time.perf_counter()
    config.VISIT_END_SECONDS = 0  # leave now instead of waiting
    print("[loop] leaves         :", [e["type"] for e in visits.update(set())])
    vid = events[0]["visit_id"]
    while True:
        with db.connect() as c:
            row = c.execute("SELECT transcript, summary, processed FROM visits WHERE id = ?", (vid,)).fetchone()
        if row["processed"]:
            break
        if time.perf_counter() - t > 180:
            sys.exit("[loop] gave up: the visit wasn't processed within 3 minutes (is Ollama running?)")
        time.sleep(0.2)
    p = people.get_person(pid)
    print(f"[loop] transcript     : {row['transcript']!r}")
    print(f"[loop] summary        : {row['summary']!r}")
    print(f"[loop] person         : {p['name']!r}, {p['relationship']!r} (name_source={p['name_source']})")
    print(f"[loop] leave -> memory saved in {time.perf_counter() - t:.1f}s (Whisper flush + LLM)")

    config.VISIT_END_SECONDS = 30
    t = time.perf_counter()
    speak = [e for e in visits.update({pid}) if e["type"] == "speak"]
    print(f"[loop] returns, says  : {speak[0]['text'] if speak else None!r} "
          f"(audio {speak[0]['audio_url'] if speak else None}, {time.perf_counter() - t:.1f}s)")
    ok = bool(speak) and bool(row["summary"]) and row["summary"] in speak[0]["text"]
    print("[loop] PASS" if ok else "[loop] FAIL: the brief doesn't include the summary")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
