"""Memory extraction with Ollama (GPU) on a worker thread. Owner: lead (block 3).

  start()            background worker reading a queue (and re-queues finished visits never processed)
  enqueue(visit_id)  called by visits.py when a visit ends
  process_visit(id)  the actual work, synchronous (also used by tools/try_memory.py):
                     transcript -> Ollama (JSON schema, thinking off) -> visits.summary + facts,
                     auto-name an Unknown visitor who said their name, broadcast memory_updated.
Ollama is only ever called on localhost.
"""
import difflib
import json
import queue
import re
import threading
import time

import audio
import config
import db
import hub

# Name first (it's what the summary should start with). Plain strings, "" when unknown: a simpler
# grammar than string-or-null, and qwen3 stopped "thinking out loud" inside the name field with it.
SCHEMA = {
    "type": "object",
    "properties": {
        "visitor_name": {"type": "string"},
        "relationship": {"type": "string"},
        "summary": {"type": "string"},
        "facts": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["visitor_name", "relationship", "summary", "facts"],
}

SYSTEM_PROMPT = """You help a person with dementia remember their visitors.
You get the transcript of one visit (speech-to-text, may contain errors). It can be in English, Tagalog/Filipino,
or Taglish (a mix of both); understand all three. Always write summary and facts in simple English: translate what
was said, and keep names and places exactly as they were said.
Tagalog help: "po"/"opo" only show respect. "ko", "ako", "akin" = the visitor (I, me, my). "mo", "niyo", "ninyo",
"kayo" = the patient (you, your): "apo ninyo si Bea" = the patient's grandchild Bea. "uuwi" = will come home,
"galing sa" = coming from, "pupunta sa" = going to, "ikakasal" = getting married, "lumipat" = moved, "trabaho" = work,
"nagpa-check up" = had a check-up, "kahapon" = yesterday, "bukas" = tomorrow, "mamaya" = later today,
"sa susunod na linggo" = next week. Lola, Lolo, Nanay, Tatay, Tita, Tito are what the visitor calls the PATIENT,
never the visitor's name.
Return JSON with:
- visitor_name: just the visitor's first name, ONLY if it is stated in the transcript ("it's Miguel", "ako si Ana",
  "si Carlo po ito", "I'm Carla"). Otherwise "". Never a sentence, never an explanation.
- relationship: the visitor's relationship TO THE PATIENT, one or two words (e.g. "grandson", "daughter", "neighbor"),
  or "" if unsure. Hints: a visitor who calls the patient "Lola" or "Lolo" is likely a grandchild; "Nanay", "Mama",
  "Tatay", "Papa" -> a child; "Tita" or "Tito" -> a niece or nephew. Tagalog words: "apo" = grandchild,
  "anak" = child, "pamangkin" = niece or nephew, "kapatid" = sibling, "kapitbahay" = neighbor, "kaibigan" = friend.
  Say "grandson"/"granddaughter" only when the gender is clear from what was said, otherwise "grandchild" or "child".
- summary: 1-2 short, simple sentences for the patient about what the visitor said.
  Write it like "<name> just <what happened>." using only the news from this transcript.
  Start with the visitor's name when it is known (given above the transcript) or stated. Only when there is no name
  at all, start with "Your visitor".
  NEVER use "he", "she", "him", "her", "his", "hers" or "they" for the visitor; repeat the name instead.
  If the visitor shares any news (work, school, a trip, plans, an event, health, family), the summary must mention it.
  Only leave it "" when nothing worth remembering was said.
- facts: short, concrete facts the visitor stated (new job, a trip, an upcoming event), in English. [] if none.
Rules: only use what was said in the transcript. Never invent names, places, dates or events.
A question is not a fact ("Have you eaten?" does not mean the patient ate). Use "" when unsure."""

# Words a visitor uses for the PATIENT (or generic words) - never accept them as the visitor's name.
NOT_A_NAME = {
    "lola", "lolo", "nanay", "mama", "tatay", "papa", "tita", "tito", "ate", "kuya", "inay", "itay",
    "grandma", "grandpa", "grandmother", "grandfather", "mom", "dad", "mother", "father", "auntie", "uncle",
    "unknown", "visitor", "patient", "null", "none",
}

_queue: "queue.Queue[int]" = queue.Queue()
_worker: threading.Thread | None = None
_client = None


def start() -> None:
    """Start the background worker. Called once at server startup if FEATURES['memory']."""
    global _worker
    if _worker is not None:
        return
    _worker = threading.Thread(target=_run, name="memory-worker", daemon=True)
    _worker.start()
    with db.connect() as c:  # visits that ended while the server was down / Ollama was unavailable
        pending = [r[0] for r in c.execute(
            "SELECT id FROM visits WHERE ended_at IS NOT NULL AND processed = 0 ORDER BY id").fetchall()]
    for vid in pending:
        _queue.put(vid)
    print(f"[memory] worker started ({config.OLLAMA_MODEL}); {len(pending)} unprocessed visit(s) queued")


def warm_up() -> None:
    """Load the model into VRAM at startup (keep_alive=-1 keeps it there), so the first visit's
    summary doesn't wait for the model load. Run off the main thread."""
    started = time.perf_counter()
    _ollama().generate(model=config.OLLAMA_MODEL, prompt="", keep_alive=config.OLLAMA_KEEP_ALIVE)
    print(f"[memory] {config.OLLAMA_MODEL} loaded in {time.perf_counter() - started:.2f}s", flush=True)


def enqueue(visit_id: int) -> None:
    """Queue a finished visit for summary + fact extraction."""
    if _worker is None:
        return  # memory feature is off
    _queue.put(visit_id)


def _run():
    while True:
        vid = _queue.get()
        try:
            audio.finish_visit(vid)  # transcribe the visit's last words first
            process_visit(vid)
        except Exception as e:  # keep the worker alive; the visit stays processed=0 for a later retry
            print(f"[memory] visit {vid}: failed: {e!r}")


def _ollama():
    global _client
    if _client is None:
        import ollama

        _client = ollama.Client(host=config.OLLAMA_HOST)
    return _client


def is_trivial(transcript: str | None) -> bool:
    return len(re.findall(r"\w+", transcript or "")) < config.MEMORY_MIN_WORDS


def call_llm(transcript: str, known_name: str | None, known_relationship: str | None) -> tuple[dict, float]:
    """Returns (parsed JSON, seconds the LLM took)."""
    who = (f"The visitor is already known as {known_name}"
           + (f", the patient's {known_relationship}" if known_relationship else "")
           + f". Use the name {known_name} in the summary."
           if known_name else "Take the visitor's name from the transcript, if they say it.")
    t = time.perf_counter()
    resp = _ollama().chat(
        model=config.OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": f"{who}\n\nTranscript:\n{transcript.strip()}"},
        ],
        format=SCHEMA,
        think=False,
        keep_alive=config.OLLAMA_KEEP_ALIVE,
        options=config.OLLAMA_OPTIONS,
    )
    took = time.perf_counter() - t
    return json.loads(resp.message.content), took


PRONOUNS = re.compile(r"\b(he|she|him|his|her|hers)\b", re.IGNORECASE)


def depronoun(summary: str | None, name: str | None) -> str | None:
    """Safety net for the "use the name, never he/she" rule if the model slips."""
    if not summary or not name or not PRONOUNS.search(summary):
        return summary

    def sub(m):
        w = m.group(1).lower()
        out = name if w in ("he", "she", "him") else f"{name}'s"  # his/her/hers -> Name's
        return out
    return PRONOUNS.sub(sub, summary)


FIRST_PERSON = re.compile(r"^(I|I'm|I've|We|We're|Ako|Kami)\b")


def repair(text: str | None, transcript: str, name: str | None) -> str | None:
    """qwen3:4b (Ollama 0.40.2, Q4_K_M) sometimes corrupts a word with a colon: "Bagu:io", or cuts the
    name and quotes the visitor ("Mig: I just started..."). It happened on GPU and on CPU, with and
    without the JSON schema, so it's repaired here using only words from the transcript."""
    if not text:
        return text
    text = re.sub(r"(?<=[A-Za-z]):(?=[A-Za-z])", "", text)  # "Bagu:io" -> "Baguio"
    words = {w.lower(): w for w in re.findall(r"[A-Za-z][A-Za-z'-]+", transcript)}

    def complete(fragment: str) -> str | None:
        """The transcript word (or the visitor's name) this cut-off fragment is the start of."""
        frag = fragment.lower()
        if name and name.lower().startswith(frag):
            return name
        hits = [w for k, w in words.items() if k.startswith(frag) and k != frag]
        return hits[0] if len(hits) == 1 else None

    m = re.match(r"^([A-Z][a-z]{1,}):\s*(.+)$", text)
    if m and (full := complete(m.group(1))):
        rest = m.group(2).strip()
        return f'{full} said, "{rest}"' if FIRST_PERSON.match(rest) else f"{full} {rest}"
    # a cut-off word + colon mid-sentence: "a new job in BG: next week"
    text = re.sub(r"\b([A-Za-z]{2,}):(?=\s)", lambda mm: complete(mm.group(1)) or mm.group(0), text)
    # a cut-off word + colon + digits: "came from Bagu:100" (times like "3:00" start with a digit, so they're safe)
    text = re.sub(r"\b([A-Za-z]{2,}):\d+", lambda mm: complete(mm.group(1)) or mm.group(0), text)
    # a word or short phrase doubled by the slip: "in Tagaytay Tagaytay", "church in Tagaytay church in Tagaytay"
    return re.sub(r"\b(\w+(?:\s+\w+){0,4})(?:\s+\1\b)+", r"\1", text, flags=re.IGNORECASE)


def fix_proper_nouns(text: str | None, transcript: str) -> str | None:
    """Same slip, other shape: a name or place comes out misspelled ("Bagungio", "C.ceb"). Swap a capitalized
    word that isn't in the transcript for the very close capitalized transcript word with the same first letter."""
    if not text:
        return text
    said = {w.lower(): w for w in re.findall(r"\b[A-Z][A-Za-z]{2,}\b", transcript)}

    def fix(m):
        word = m.group(0)
        core = re.sub(r"^[A-Za-z]\.", "", word)  # "C.ceb" -> "ceb"
        if core.lower() in said:
            return said[core.lower()] if core != word else word
        near = difflib.get_close_matches(core.lower(), [w for w in said if w[0] == core[0].lower()], n=1, cutoff=0.84)
        return said[near[0]] if near else word

    return re.sub(r"\b[A-Z](?:\.[a-z]{2,}|[a-z]{2,})\b", fix, text)


def clean_name(value, transcript: str) -> str | None:
    """The visitor's name, only if it's really a name and was really said in the transcript."""
    if not isinstance(value, str):
        return None
    name = value.split(":")[-1]  # e.g. "Mig: Miguel" -> "Miguel"
    name = re.sub(r"[^A-Za-zÀ-ÿ .'-]", "", name)  # letters incl. accented (n with tilde, etc.)
    name = re.sub(r"\s+", " ", name).strip(" .'-")[:40]
    if not name or name.lower() in NOT_A_NAME or len(name.split()) > 4:
        return None
    first = name.split()[0]
    if not re.search(rf"\b{re.escape(first)}\b", transcript, re.IGNORECASE):
        return None  # never invent a name that wasn't said
    return name


def clean(result: dict, transcript: str = "", known_name: str | None = None) -> dict:
    """Defensive cleanup of the model's JSON: types, lengths, names that weren't said, pronouns."""
    def text(v, limit):
        return v.strip()[:limit] if isinstance(v, str) and v.strip() and v.strip().lower() != "null" else None

    name = clean_name(result.get("visitor_name"), transcript)
    who = known_name or name
    facts, seen = [], set()
    for f in result.get("facts") or []:
        f = depronoun(fix_proper_nouns(repair(text(f, 200), transcript, who), transcript), who)
        if f and f.lower() not in seen:
            seen.add(f.lower())
            facts.append(f)
    summary = fix_proper_nouns(repair(text(result.get("summary"), 400), transcript, who), transcript)
    if summary and who:  # the model fell back to "Your visitor" although the name is known
        summary = re.sub(r"\b[Yy]our visitor\b", who, summary)
    if summary:  # "Tita just enrolled..." - that's what the visitor calls the patient, not the visitor's name
        title = re.match(r"^([A-Za-z]+)\b", summary)
        if title and title.group(1).lower() in NOT_A_NAME and title.group(1).lower() not in ("visitor", "unknown"):
            summary = (who or "Your visitor") + summary[title.end():]
    return {
        "summary": depronoun(summary, who),
        "visitor_name": name,
        "relationship": text(result.get("relationship"), 40),
        "facts": facts[:10],
    }


def process_visit(visit_id: int) -> dict | None:
    """Extract + save memory for one finished visit. Returns what was saved (None if skipped)."""
    with db.connect() as c:
        row = c.execute(
            """SELECT v.id, v.person_id, v.transcript, p.name, p.relationship, p.is_unknown, p.name_source
               FROM visits v JOIN people p ON p.id = v.person_id WHERE v.id = ?""", (visit_id,)).fetchone()
    if row is None:
        print(f"[memory] visit {visit_id}: not found (person deleted?)")
        return None
    pid = row["person_id"]
    if is_trivial(row["transcript"]):
        with db.connect() as c:
            c.execute("UPDATE visits SET processed = 1 WHERE id = ?", (visit_id,))
        print(f"[memory] visit {visit_id}: transcript too short, skipped")
        return None

    unknown = bool(row["is_unknown"])
    raw, took = call_llm(row["transcript"], None if unknown else row["name"], row["relationship"])
    result = clean(raw, row["transcript"], None if unknown else row["name"])
    renamed = False
    with db.connect() as c:  # one transaction: summary, facts (replaced, so re-running is safe), auto-name
        c.execute("UPDATE visits SET summary = ?, processed = 1 WHERE id = ?", (result["summary"], visit_id))
        c.execute("DELETE FROM facts WHERE visit_id = ?", (visit_id,))
        now = db.now()
        c.executemany("INSERT INTO facts (person_id, visit_id, fact, created_at) VALUES (?,?,?,?)",
                      [(pid, visit_id, f, now) for f in result["facts"]])
        # Name an Unknown who introduced themselves. Never touch a caregiver-entered name.
        if unknown and result["visitor_name"] and row["name_source"] != "enrolled":
            cur = c.execute(
                """UPDATE people SET name = ?, relationship = COALESCE(relationship, ?), is_unknown = 0,
                   name_source = 'auto' WHERE id = ? AND is_unknown = 1 AND COALESCE(name_source, '') != 'enrolled'""",
                (result["visitor_name"], result["relationship"], pid))
            renamed = cur.rowcount > 0
    if renamed and hub.engine is not None:
        hub.engine.reload()  # the live name tags pick up the new name
    print(f"[memory] visit {visit_id}: LLM {took:.1f} s ({config.OLLAMA_MODEL}); "
          f"{len(result['facts'])} fact(s)" + (f"; Unknown -> {result['visitor_name']} (auto)" if renamed else ""))
    hub.broadcast_threadsafe({"type": "memory_updated", "person_id": pid})
    return {**result, "person_id": pid, "llm_seconds": took, "renamed": renamed}


# --- queries ---

def list_facts(person_id: int):
    with db.connect() as c:
        rows = c.execute(
            "SELECT * FROM facts WHERE person_id = ? ORDER BY created_at DESC", (person_id,)
        ).fetchall()
    return [dict(r) for r in rows]
