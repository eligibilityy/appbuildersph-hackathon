"""Shared SQLite schema + connection. Each feature keeps its own queries in its own module.

One short-lived connection per call keeps it thread-safe.
"""
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT,
  relationship TEXT,
  notes TEXT,
  is_unknown INTEGER DEFAULT 0,
  name_source TEXT,
  created_at TEXT
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
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


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
