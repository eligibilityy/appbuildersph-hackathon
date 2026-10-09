"""Memory extraction with Ollama (GPU) on a worker thread. Owner: lead (block 3).

STUB — enqueue() does nothing yet. Later task:
  - start(): background thread reading a queue
  - enqueue(visit_id): on visit end, if the transcript is non-trivial, call Ollama
    (config.OLLAMA_MODEL, think=False, format=<JSON schema in CLAUDE.md>, keep_alive=-1)
  - save summary + facts; if the person is unknown and a name was stated, set it with
    name_source='auto'. Never overwrite a name a caregiver entered (name_source='enrolled').
  - hub.broadcast_threadsafe({"type": "memory_updated", "person_id": ...})
"""
import db


def start() -> None:
    """Start the background worker. Called once at server startup if FEATURES['memory']."""
    return None


def enqueue(visit_id: int) -> None:
    """Queue a finished visit for summary + fact extraction."""
    return None


# --- queries ---

def list_facts(person_id: int):
    with db.connect() as c:
        rows = c.execute(
            "SELECT * FROM facts WHERE person_id = ? ORDER BY created_at DESC", (person_id,)
        ).fetchall()
    return [dict(r) for r in rows]
