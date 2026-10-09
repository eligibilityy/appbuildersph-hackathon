"""Shared SQLite schema + connection. Each feature keeps its own queries in its own module.

One short-lived connection per call keeps it thread-safe.
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT,
  relationship TEXT,
  notes TEXT,
  is_unknown INTEGER DEFAULT 0,
  name_source TEXT,
  created_at TEXT,
  registered_at TEXT,
  first_seen_at TEXT,
  last_seen_at TEXT
);
CREATE TABLE IF NOT EXISTS face_embeddings (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  embedding BLOB,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  started_at TEXT, ended_at TEXT,
  transcript TEXT,
  summary TEXT,
  processed INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE,
  visit_id INTEGER REFERENCES visits(id) ON DELETE CASCADE,
  fact TEXT,
  created_at TEXT
);
CREATE TABLE IF NOT EXISTS appearances (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  hour_bucket TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'automatic',
  UNIQUE (person_id, hour_bucket)
);
CREATE INDEX IF NOT EXISTS appearances_person_hour
  ON appearances (person_id, hour_bucket DESC);
CREATE TABLE IF NOT EXISTS monitoring_sessions (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
    last_frame_at TEXT NOT NULL,
  ended_at TEXT
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def as_utc(value: str | datetime) -> str:
    """Return a canonical, timezone-aware UTC ISO 8601 timestamp."""
    parsed = value if isinstance(value, datetime) else datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.astimezone()
    return parsed.astimezone(timezone.utc).isoformat(timespec="seconds")


def hour_bucket(value: str | datetime) -> str:
    parsed = datetime.fromisoformat(as_utc(value))
    return parsed.replace(minute=0, second=0, microsecond=0).isoformat(timespec="seconds")


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init():
    with connect() as c:
        c.execute("PRAGMA journal_mode = WAL")
        c.executescript(SCHEMA)
        columns = {row["name"] for row in c.execute("PRAGMA table_info(people)")}
        for column in ("registered_at", "first_seen_at", "last_seen_at"):
            if column not in columns:
                c.execute(f"ALTER TABLE people ADD COLUMN {column} TEXT")

        people_rows = c.execute(
            "SELECT id, created_at, registered_at FROM people"
        ).fetchall()
        for person in people_rows:
            if not person["registered_at"] and person["created_at"]:
                try:
                    registered_at = as_utc(person["created_at"])
                except (TypeError, ValueError):
                    registered_at = None
                if registered_at:
                    c.execute(
                        "UPDATE people SET registered_at = ? WHERE id = ?",
                        (registered_at, person["id"]),
                    )
            visit_times = [
                row["started_at"]
                for row in c.execute(
                    "SELECT started_at FROM visits WHERE person_id = ? AND started_at IS NOT NULL",
                    (person["id"],),
                )
            ]
            normalized = []
            for value in visit_times:
                try:
                    normalized.append(as_utc(value))
                except (TypeError, ValueError):
                    continue
            if normalized:
                normalized.sort()
                c.execute(
                    """UPDATE people
                       SET first_seen_at = COALESCE(first_seen_at, ?),
                           last_seen_at = COALESCE(last_seen_at, ?)
                       WHERE id = ?""",
                    (normalized[0], normalized[-1], person["id"]),
                )

        # A restart cannot prove coverage after the last frame written by the previous process.
        c.execute(
            "UPDATE monitoring_sessions SET ended_at = last_frame_at WHERE ended_at IS NULL"
        )
