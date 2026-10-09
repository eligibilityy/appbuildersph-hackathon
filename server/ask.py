"""Ask about your people + add a conversation by typing it. Both run on the local LLM (Ollama). Owner: lead.

  POST /people/{id}/conversations  {"transcript": "..."}  -> remember a typed/pasted conversation as a visit
                                    (summary + facts + auto-name, via memory.process_visit)
  POST /ask                         {"question": "..."}    -> answer from saved memories only, spoken by Piper

Typed conversations are a backup for the live mic -> Whisper path (audio.py), e.g. in a noisy room.
"""
import json
import re
import time
from datetime import datetime, timedelta

from fastapi import APIRouter, HTTPException

import config
import db
import memory
import people
import tts
import visits

router = APIRouter()

MAX_TRANSCRIPT_CHARS = 2000
MAX_QUESTION_CHARS = 300
MAX_CONTEXT_CHARS = 6000
DONT_KNOW = "I don't remember that."
NOBODY = "I don't have anyone saved yet."

ANSWER_SCHEMA = {
    "type": "object",
    "properties": {
        "answer": {"type": "string"},
        "person_ids": {"type": "array", "items": {"type": "integer"}},
    },
    "required": ["answer", "person_ids"],
}

ASK_PROMPT = f"""You help a person with dementia, and their caregiver, remember the people who visit.
Answer the question using ONLY the memory notes below. The question can be in English, Tagalog or Taglish.
Tagalog question words: "sino" = who, "ano"/"ano'ng balita" = what / what's new, "kailan" = when, "saan" = where,
"bakit" = why, "bumisita"/"dumalaw" = visited, "ngayon" = today/now, "kahapon" = yesterday, "kay"/"si" = about (a name).
Answer in 1-2 short, warm, simple English sentences. Use people's names; never "he", "she", "him", "her" or "they".
Say only what the notes say. Don't combine facts into new claims (a job in BGC does not mean living in BGC).
When the notes don't contain the answer, answer exactly "{DONT_KNOW}".
person_ids: the [id N] numbers of the people your answer is about ([] if none)."""
ASK_OPTIONS = {**config.OLLAMA_OPTIONS, "num_predict": 160}  # answers are 1-2 sentences


def _need_memory():
    if not config.FEATURES["memory"]:
        raise HTTPException(503, "The memory feature is off on this laptop (FEATURE_MEMORY=0).")


def _local_time(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return visits._parse(ts).astimezone()
    except ValueError:
        return None


def _fmt(dt: datetime) -> str:
    return f"{dt:%a} {dt.day} {dt:%b}, {dt:%I:%M %p}".replace(" 0", " ")


def known_people() -> dict[int, dict]:
    return {p["id"]: p for p in people.list_people() if not p["is_unknown"] and p["name"]}


def mentioned(question: str, known: dict[int, dict]) -> list[int]:
    """People the question names (full name or first name, any case): "Ano'ng balita kay Ana?" -> Ana."""
    q = question.lower()
    return [pid for pid, p in known.items()
            if _names_in(p["name"], q)]


def _names_in(name: str, text: str) -> bool:
    words = {name.lower(), name.split()[0].lower()}
    return any(re.search(r"\b" + re.escape(w) + r"\b", text) for w in words)


def build_context(now: datetime | None = None, only: list[int] | None = None) -> tuple[str, dict[int, dict]]:
    """Memory notes for the LLM: known people with their recent visits, summaries and facts.
    `only`: just these people (the question names them), which keeps the prompt short and the answer focused."""
    now = (now or datetime.now()).astimezone()
    known = known_people()
    lines = [f"Today is {now:%A}, {now:%B} {now.day}, {now.year}, {now:%I:%M %p}.".replace(" 0", " ")]
    # Worked out here rather than left to the model: who came today / yesterday (local time).
    for label, day in (("today", now.date()), ("yesterday", now.date() - timedelta(days=1))):
        names = [p["name"] for pid, p in known.items()
                 if any((t := _local_time(r["started_at"])) and t.date() == day for r in visits.list_visits(pid))]
        lines.append(f"Visited {label}: {', '.join(names) if names else 'nobody'}.")
    lines.append("")
    for pid, p in known.items():
        if only and pid not in only:
            continue
        head = f"[id {pid}] {p['name']}" + (f", the patient's {p['relationship']}" if p["relationship"] else "")
        rows = visits.list_visits(pid)  # newest first
        recent = [t for r in rows if (t := _local_time(r["started_at"])) and now - t <= timedelta(days=7)]
        block = [head]
        if p.get("notes"):
            block.append(f"  Notes: {p['notes'].strip()}")
        ended = next((r["ended_at"] for r in rows if r["ended_at"]), None)
        if rows:
            block.append(f"  Visits: {len(rows)} in total"
                         + (f"; last one ended {visits.humanized_elapsed(ended)} ago" if ended else "; visiting now")
                         + (f"; in the last 7 days: {'; '.join(_fmt(t) for t in recent[:6])}" if recent else "") + ".")
        else:
            block.append("  No visits recorded yet.")
        summaries = [r["summary"].strip() for r in rows if (r["summary"] or "").strip()][:3]
        if summaries:
            block.append("  What they talked about (newest first): " + " | ".join(summaries))
        facts = [f["fact"] for f in memory.list_facts(pid)][:8]
        if facts:
            block.append("  Facts: " + "; ".join(facts))
        lines.extend(block)
    text = "\n".join(lines)
    if len(text) > MAX_CONTEXT_CHARS:
        text = text[:MAX_CONTEXT_CHARS].rsplit("\n", 1)[0]
    return text, known


def call_llm(question: str, context: str) -> tuple[dict, float]:
    t = time.perf_counter()
    resp = memory._ollama().chat(
        model=config.OLLAMA_MODEL,
        messages=[
            {"role": "system", "content": ASK_PROMPT},
            {"role": "user", "content": f"Memory notes:\n{context}\n\nQuestion: {question}"},
        ],
        format=ANSWER_SCHEMA,
        think=False,
        keep_alive=config.OLLAMA_KEEP_ALIVE,
        options=ASK_OPTIONS,
    )
    return json.loads(resp.message.content), time.perf_counter() - t


def _speak(text: str) -> str | None:
    if not (config.FEATURES["tts"] and tts.available()):
        return None
    try:
        return tts.speak(text)
    except Exception as e:
        print(f"[ask] couldn't synthesize the answer: {e!r}")
        return None


@router.post("/ask")
def ask(body: dict):
    question = str(body.get("question") or "").strip()[:MAX_QUESTION_CHARS]
    if not question:
        raise HTTPException(400, "Type a question first.")
    _need_memory()
    named = mentioned(question, known_people())
    context, known = build_context(only=named or None)
    if not known:
        return {"answer": NOBODY, "person_ids": [], "llm_seconds": None, "model": None, "audio_url": _speak(NOBODY)}
    try:
        raw, took = call_llm(question, context)
    except Exception as e:
        print(f"[ask] LLM failed: {e!r}")
        raise HTTPException(503, "The AI on this laptop isn't responding. Make sure Ollama is running, then try again.")
    ids = [i for i in dict.fromkeys(raw.get("person_ids") or []) if isinstance(i, int) and i in known]
    answer = str(raw.get("answer") or "").strip() or DONT_KNOW
    answer = memory.fix_proper_nouns(answer, context)
    if len(ids) == 1:
        answer = memory.depronoun(answer, known[ids[0]]["name"])
    print(f"[ask] LLM {took:.1f} s ({config.OLLAMA_MODEL}); about {ids or 'nobody'}", flush=True)
    return {"answer": answer, "person_ids": ids, "llm_seconds": round(took, 2), "model": config.OLLAMA_MODEL,
            "audio_url": _speak(answer)}


@router.post("/people/{person_id}/conversations")
def add_conversation(person_id: int, body: dict):
    transcript = " ".join(str(body.get("transcript") or "").split())[:MAX_TRANSCRIPT_CHARS]
    if not people.get_person(person_id):
        raise HTTPException(404, "This person is no longer saved.")
    if memory.is_trivial(transcript):
        raise HTTPException(400, "Too short to remember anything. Type at least a full sentence.")
    _need_memory()
    now = db.now()
    with db.connect() as c:
        vid = c.execute(
            "INSERT INTO visits (person_id, started_at, ended_at, transcript, processed) VALUES (?, ?, ?, ?, 0)",
            (person_id, now, now, transcript),
        ).lastrowid
    try:
        result = memory.process_visit(vid)
    except Exception as e:
        print(f"[ask] conversation for person {person_id} failed: {e!r}")
        with db.connect() as c:  # don't leave a half-done visit behind
            c.execute("DELETE FROM visits WHERE id = ?", (vid,))
        raise HTTPException(503, "The AI on this laptop isn't responding. Make sure Ollama is running, then try again.")
    p = people.get_person(person_id)
    return {
        "visit_id": vid,
        "summary": (result or {}).get("summary"),
        "facts": (result or {}).get("facts", []),
        "visitor_name": (result or {}).get("visitor_name"),
        "renamed": bool((result or {}).get("renamed")),
        "llm_seconds": round((result or {}).get("llm_seconds") or 0, 2),
        "model": config.OLLAMA_MODEL,
        "person": {"id": p["id"], "name": p["name"], "relationship": p["relationship"], "is_unknown": p["is_unknown"]},
        "brief": visits.brief_text(person_id),
    }
