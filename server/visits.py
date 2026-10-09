"""Visit lifecycle + spoken brief text. Owner: lead.

STUB — the signatures are final; fill in the bodies. Block 1 task:
  update(): open a visit when a person is confirmed in view; close it after they've been
            absent VISIT_END_SECONDS. On open: speak the brief (brief_text -> tts.speak).
            On close: memory.enqueue(visit_id).
  brief_text(): add "You last saw {name} {humanized time}. {last summary}" once visits exist.
Unknown people: never speak to the patient (caregiver view only).
"""
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter

import db
import config
import memory
import people
import tts

router = APIRouter()
_visit_lock = threading.RLock()
_last_present_at: dict[int, float] = {}
_present_person_ids: set[int] = set()
_appearance_lock = threading.Lock()
_last_appearance_write: dict[tuple[int, str], float] = {}
_monitor_lock = threading.Lock()
_active_monitoring: dict[int, str] = {}
_APPEARANCE_WRITE_INTERVAL = 10.0
_MONITORING_HEARTBEAT_SECONDS = 15.0
_last_monitoring_heartbeat: dict[int, float] = {}


def update(present_ids: set[int]) -> list[dict]:
    """Called after every frame with the confirmed people in view (runs in a worker thread).

    Returns events to broadcast, e.g.
      {"type": "visit_start", "visit_id": 1, "person_id": 2}
      {"type": "speak", "text": "...", "audio_url": "/tts/abc.wav", "person_id": 2}
      {"type": "visit_end", "visit_id": 1, "person_id": 2}
    """
    now_mono = time.monotonic()
    started: list[tuple[int, int]] = []
    ended: list[tuple[int, int]] = []

    with _visit_lock:
        _present_person_ids.clear()
        _present_person_ids.update(present_ids)
        with db.connect() as c:
            open_rows = c.execute(
                "SELECT id, person_id FROM visits WHERE ended_at IS NULL"
            ).fetchall()
            open_by_person = {row["person_id"]: row["id"] for row in open_rows}

            for person_id in present_ids:
                if person_id in open_by_person:
                    _last_present_at[person_id] = now_mono
                    continue
                person = c.execute("SELECT id FROM people WHERE id = ?", (person_id,)).fetchone()
                if not person:
                    continue
                started_at = db.now()
                cursor = c.execute(
                    "INSERT INTO visits (person_id, started_at) VALUES (?, ?)",
                    (person_id, started_at),
                )
                visit_id = cursor.lastrowid
                open_by_person[person_id] = visit_id
                _last_present_at[person_id] = now_mono
                started.append((visit_id, person_id))

            for person_id, visit_id in open_by_person.items():
                if person_id in present_ids:
                    continue
                last_present = _last_present_at.setdefault(person_id, now_mono)
                if now_mono - last_present < config.VISIT_END_SECONDS:
                    continue
                ended_at = db.now()
                cursor = c.execute(
                    "UPDATE visits SET ended_at = ? WHERE id = ? AND ended_at IS NULL",
                    (ended_at, visit_id),
                )
                if cursor.rowcount == 1:
                    ended.append((visit_id, person_id))
                _last_present_at.pop(person_id, None)

    events = []
    for visit_id, person_id in started:
        events.append({"type": "visit_start", "visit_id": visit_id, "person_id": person_id})
        text = brief_text(person_id)
        if text is not None:
            try:
                audio_url = tts.speak(text) if config.FEATURES["tts"] else None
            except Exception as exc:
                print(f"[visits] speech synthesis failed: {exc!r}")
                audio_url = None
            events.append({"type": "speak", "text": text, "audio_url": audio_url, "person_id": person_id})

    for visit_id, person_id in ended:
        events.append({"type": "visit_end", "visit_id": visit_id, "person_id": person_id})
        try:
            memory.enqueue(visit_id)
        except Exception as exc:
            print(f"[visits] memory enqueue failed for visit {visit_id}: {exc!r}")
    return events


def record_confirmed_appearances(person_ids: set[int], observed_at: str | None = None) -> list[int]:
    """Atomically record confirmed IDs, throttling repeat writes while a face stays present."""
    if not person_ids:
        return []
    observed_at = db.as_utc(observed_at or db.now())
    bucket = db.hour_bucket(observed_at)
    mono = time.monotonic()
    persisted_ids = []
    with _appearance_lock:
        eligible = [
            pid for pid in person_ids
            if mono - _last_appearance_write.get((pid, bucket), float("-inf")) >= _APPEARANCE_WRITE_INTERVAL
        ]
        if not eligible:
            return []
        with db.connect() as c:
            placeholders = ",".join("?" for _ in eligible)
            valid_ids = {
                row["id"]
                for row in c.execute(
                    f"SELECT id FROM people WHERE id IN ({placeholders})", eligible
                )
            }
            for person_id in eligible:
                if person_id not in valid_ids:
                    continue
                c.execute(
                    """INSERT INTO appearances
                       (person_id, hour_bucket, first_seen_at, last_seen_at, source)
                       VALUES (?, ?, ?, ?, 'automatic')
                       ON CONFLICT(person_id, hour_bucket) DO UPDATE SET
                         first_seen_at = MIN(appearances.first_seen_at, excluded.first_seen_at),
                         last_seen_at = MAX(appearances.last_seen_at, excluded.last_seen_at)""",
                    (person_id, bucket, observed_at, observed_at),
                )
                c.execute(
                    """UPDATE people SET
                         first_seen_at = CASE
                           WHEN first_seen_at IS NULL THEN ? ELSE MIN(first_seen_at, ?) END,
                         last_seen_at = CASE
                           WHEN last_seen_at IS NULL THEN ? ELSE MAX(last_seen_at, ?) END
                       WHERE id = ?""",
                    (observed_at, observed_at, observed_at, observed_at, person_id),
                )
                persisted_ids.append(person_id)
        for person_id in persisted_ids:
            _last_appearance_write[(person_id, bucket)] = mono
    return persisted_ids


def start_monitoring_session(observed_at: str | None = None) -> int:
    observed_at = db.as_utc(observed_at or db.now())
    with db.connect() as c:
        cursor = c.execute(
            "INSERT INTO monitoring_sessions (started_at, last_frame_at) VALUES (?, ?)",
            (observed_at, observed_at),
        )
        session_id = cursor.lastrowid
    with _monitor_lock:
        _active_monitoring[session_id] = observed_at
        _last_monitoring_heartbeat[session_id] = time.monotonic()
    return session_id


def note_monitoring_frame(session_id: int, observed_at: str | None = None):
    observed_at = db.as_utc(observed_at or db.now())
    mono = time.monotonic()
    with _monitor_lock:
        _active_monitoring[session_id] = observed_at
        last_write = _last_monitoring_heartbeat.get(session_id, 0.0)
        if mono - last_write < _MONITORING_HEARTBEAT_SECONDS:
            return
        _last_monitoring_heartbeat[session_id] = mono
    with db.connect() as c:
        c.execute(
            "UPDATE monitoring_sessions SET last_frame_at = ? WHERE id = ? AND ended_at IS NULL",
            (observed_at, session_id),
        )


def end_monitoring_session(session_id: int, observed_at: str | None = None):
    with _monitor_lock:
        last_frame = _active_monitoring.pop(session_id, None)
        _last_monitoring_heartbeat.pop(session_id, None)
    ended_at = db.as_utc(observed_at or last_frame or db.now())
    with db.connect() as c:
        c.execute(
            "UPDATE monitoring_sessions SET last_frame_at = ?, ended_at = ? WHERE id = ?",
            (ended_at, ended_at, session_id),
        )


def appearance_history(person_id: int, at: datetime | None = None):
    now = (at or datetime.now(timezone.utc)).astimezone(timezone.utc)
    current_bucket = db.hour_bucket(now)
    current_start = datetime.fromisoformat(current_bucket)
    with db.connect() as c:
        appearances = [dict(r) for r in c.execute(
            "SELECT * FROM appearances WHERE person_id = ? ORDER BY hour_bucket DESC",
            (person_id,),
        )]
        sessions = [dict(r) for r in c.execute(
            "SELECT id, started_at, last_frame_at, ended_at FROM monitoring_sessions"
        )]
    with _monitor_lock:
        active_frames = dict(_active_monitoring)

    def fully_covered(start: datetime, end: datetime) -> bool:
        for session in sessions:
            session_start = datetime.fromisoformat(session["started_at"])
            active_end = active_frames.get(session.get("id"))
            raw_end = active_end or session["ended_at"] or session["last_frame_at"]
            session_end = datetime.fromisoformat(raw_end)
            if session_start <= start and session_end >= end:
                return True
        return False

    by_bucket = {row["hour_bucket"]: row for row in appearances}
    hourly = []
    for offset in range(24):
        start = current_start - timedelta(hours=offset)
        bucket = start.isoformat(timespec="seconds")
        row = by_bucket.get(bucket)
        in_progress = bucket == current_bucket
        if row:
            status = "seen"
        elif not in_progress and fully_covered(start, start + timedelta(hours=1)):
            status = "not_seen"
        else:
            status = "monitoring_unavailable"
        hourly.append({"hour_bucket": bucket, "status": status, "in_progress": in_progress})
    return appearances, hourly


def open_visit_ids() -> list[int]:
    """Visits currently open. audio.py appends transcribed text to all of them."""
    with db.connect() as c:
        rows = c.execute("SELECT id FROM visits WHERE ended_at IS NULL ORDER BY id").fetchall()
    return [row["id"] for row in rows]


def append_transcript(visit_ids: set[int], text: str) -> list[int]:
    """Append recognized speech to targeted visits that are still open; return IDs updated."""
    if not visit_ids or not text.strip():
        return []
    updated = []
    with db.connect() as c:
        for visit_id in visit_ids:
            row = c.execute("SELECT transcript FROM visits WHERE id = ? AND ended_at IS NULL", (visit_id,)).fetchone()
            if row is None:
                continue
            transcript = " ".join(part for part in (row["transcript"], text.strip()) if part)
            c.execute("UPDATE visits SET transcript = ? WHERE id = ? AND ended_at IS NULL", (transcript, visit_id))
            updated.append(visit_id)
    return updated


def replay_brief() -> list[dict]:
    """'Who's this?' button / spacebar: repeat the brief for whoever is in view."""
    events = []
    with _visit_lock:
        person_ids = sorted(_present_person_ids)
    for person_id in person_ids:
        text = brief_text(person_id)
        if text is None:
            continue
        try:
            audio_url = tts.speak(text) if config.FEATURES["tts"] else None
        except Exception as exc:
            print(f"[visits] speech synthesis failed: {exc!r}")
            audio_url = None
        events.append({"type": "speak", "text": text, "audio_url": audio_url, "person_id": person_id})
    return events


def brief_text(person_id: int) -> str | None:
    """Template brief from SQLite (never LLM-generated at speak time, so it's instant)."""
    p = people.get_person(person_id)
    if not p or p["is_unknown"]:
        return None
    name = p["name"] or "someone you know"
    text = f"This is {name}."
    if p["relationship"]:
        text = f"This is {name}, your {p['relationship']}."
    with db.connect() as c:
        previous = c.execute(
            """SELECT ended_at FROM visits
               WHERE person_id = ? AND ended_at IS NOT NULL
               ORDER BY ended_at DESC LIMIT 1""",
            (person_id,),
        ).fetchone()
        current = c.execute(
            "SELECT MIN(started_at) AS started_at FROM visits WHERE person_id = ? AND ended_at IS NULL",
            (person_id,),
        ).fetchone()
    last_seen = previous["ended_at"] if previous else p.get("last_seen_at")
    # last_seen_at keeps updating while they're in view; only a sighting before this visit counts.
    if not previous and last_seen and current["started_at"] and _parse(last_seen) >= _parse(current["started_at"]):
        last_seen = None
    if last_seen:
        text += f" You last saw {name} {humanized_elapsed(last_seen)} ago."
    return text


def _parse(timestamp: str) -> datetime:
    t = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    return t if t.tzinfo else t.astimezone()


def humanized_elapsed(timestamp: str, now: datetime | None = None) -> str:
    """Format elapsed time without referring to a person by pronoun."""
    seen_at = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if seen_at.tzinfo is None:
        seen_at = seen_at.astimezone()
    current = now or datetime.now(timezone.utc)
    if current.tzinfo is None:
        current = current.astimezone()
    seconds = max(0, int((current.astimezone(timezone.utc) - seen_at.astimezone(timezone.utc)).total_seconds()))
    if seconds < 60:
        return "less than a minute"
    minutes = seconds // 60
    if minutes < 60:
        return f"{minutes} minute{'s' if minutes != 1 else ''}"
    hours = minutes // 60
    if hours < 24:
        return f"{hours} hour{'s' if hours != 1 else ''}"
    days = hours // 24
    return f"{days} day{'s' if days != 1 else ''}"


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
