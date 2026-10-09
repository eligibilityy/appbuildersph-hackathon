"""Visit lifecycle + spoken brief text. Owner: lead.

STUB — the signatures are final; fill in the bodies. Block 1 task:
  update(): open a visit when a person is confirmed in view; close it after they've been
            absent VISIT_END_SECONDS. On open: speak the brief (brief_text -> tts.speak).
            On close: memory.enqueue(visit_id).
  brief_text(): add "You last saw {name} {humanized time}. {last summary}" once visits exist.
Unknown people: never speak to the patient (caregiver view only).
"""
from fastapi import APIRouter

import db
import people

router = APIRouter()


def update(present_ids: set[int]) -> list[dict]:
    """Called after every frame with the confirmed people in view (runs in a worker thread).

    Returns events to broadcast, e.g.
      {"type": "visit_start", "visit_id": 1, "person_id": 2}
      {"type": "speak", "text": "...", "audio_url": "/tts/abc.wav"}
      {"type": "visit_end", "visit_id": 1, "person_id": 2}
    """
    return []


def open_visit_ids() -> list[int]:
    """Visits currently open. audio.py appends transcribed text to all of them."""
    return []


def replay_brief() -> list[dict]:
    """'Who's this?' button / spacebar: repeat the brief for whoever is in view."""
    return []


def brief_text(person_id: int) -> str | None:
    """Template brief from SQLite (never LLM-generated at speak time, so it's instant)."""
    p = people.get_person(person_id)
    if not p or p["is_unknown"]:
        return None
    text = f"This is {p['name']}."
    if p["relationship"]:
        text = f"This is {p['name']}, your {p['relationship']}."
    return text


# --- queries ---

def list_visits(person_id=None):
    with db.connect() as c:
        if person_id is None:
            rows = c.execute("SELECT * FROM visits ORDER BY started_at DESC").fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM visits WHERE person_id = ? ORDER BY started_at DESC", (person_id,)
            ).fetchall()
    return [dict(r) for r in rows]


# --- routes ---

@router.get("/visits")
def visits(person_id: int | None = None):
    return list_visits(person_id)
