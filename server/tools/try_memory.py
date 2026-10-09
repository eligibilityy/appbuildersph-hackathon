"""Try memory extraction without a mic or camera: insert one finished visit and run the LLM on it.

    cd server
    .venv/Scripts/python tools/try_memory.py                       (macOS/Linux: .venv/bin/python ...)
    .venv/Scripts/python tools/try_memory.py --transcript "..."    try your own conversation
    .venv/Scripts/python tools/try_memory.py --known               visitor already enrolled as "Miguel"

Uses a throwaway database (your real server/data is untouched) and Ollama on localhost.
The visitor starts as an "Unknown #1" face, like a stranger who just walked in, so you can see
auto-naming from the introduction. Prints the saved summary + facts, how long the LLM took, and
how much of the model is on the GPU (what `ollama ps` shows).
"""
import argparse
import os
import sys
import tempfile
from pathlib import Path

DEMO = "Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--transcript", default=DEMO)
    ap.add_argument("--known", action="store_true", help="visitor is already enrolled as Miguel (grandson)")
    args = ap.parse_args()

    os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="memoryaid-try-")
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    import config
    import db
    import memory
    import people

    db.init()
    if args.known:
        pid = people.create_person("Miguel", "grandson", is_unknown=False, name_source="enrolled")
    else:
        pid = people.create_person(people.next_unknown_label(), None, is_unknown=True)
    now = db.now()
    with db.connect() as c:
        vid = c.execute(
            "INSERT INTO visits (person_id, started_at, ended_at, transcript, processed) VALUES (?,?,?,?,0)",
            (pid, now, now, args.transcript),
        ).lastrowid

    print(f"Model: {config.OLLAMA_MODEL} at {config.OLLAMA_HOST}")
    print(f"Transcript: {args.transcript!r}\n")
    try:
        saved = memory.process_visit(vid)
    except Exception as e:
        print(f"\nFAILED: {e!r}\nIs Ollama running?  ollama pull {config.OLLAMA_MODEL}")
        sys.exit(1)

    with db.connect() as c:
        visit = c.execute("SELECT summary, processed FROM visits WHERE id = ?", (vid,)).fetchone()
        facts = [r[0] for r in c.execute("SELECT fact FROM facts WHERE visit_id = ?", (vid,))]
    p = people.get_person(pid)
    print(f"\nSaved summary : {visit['summary']!r}  (processed={visit['processed']})")
    print(f"Saved facts   : {facts}")
    print(f"Person        : name={p['name']!r} relationship={p['relationship']!r} "
          f"is_unknown={p['is_unknown']} name_source={p['name_source']!r}")
    if saved:
        print(f"LLM time      : {saved['llm_seconds']:.1f} s (includes model load if it wasn't loaded yet)")

    try:
        for m in memory._ollama().ps().models:
            gpu = 100 * (m.size_vram or 0) / m.size if m.size else 0
            print(f"ollama ps     : {m.model}  {gpu:.0f}% GPU  ({(m.size_vram or 0) / 2**30:.1f} of {m.size / 2**30:.1f} GiB in VRAM)")
    except Exception as e:
        print(f"ollama ps     : couldn't read ({e!r})")


if __name__ == "__main__":
    main()
