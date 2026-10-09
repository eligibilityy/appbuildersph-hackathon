"""SQLite schema + queries. One short-lived connection per call keeps it thread-safe."""
import sqlite3
from contextlib import contextmanager
from datetime import datetime

import numpy as np

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


# --- people ---

def create_person(name, relationship=None, is_unknown=False, name_source=None) -> int:
    with connect() as c:
        cur = c.execute(
            "INSERT INTO people (name, relationship, is_unknown, name_source, created_at) VALUES (?,?,?,?,?)",
            (name, relationship, int(is_unknown), name_source, now()),
        )
        return cur.lastrowid


def next_unknown_label() -> str:
    with connect() as c:
        n = c.execute("SELECT COUNT(*) FROM people WHERE name LIKE 'Unknown #%'").fetchone()[0]
    return f"Unknown #{n + 1}"


def get_person(person_id: int):
    with connect() as c:
        row = c.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
    return dict(row) if row else None


def list_people():
    with connect() as c:
        rows = c.execute(
            """SELECT p.*,
                      (SELECT MAX(started_at) FROM visits v WHERE v.person_id = p.id) AS last_seen,
                      (SELECT COUNT(*) FROM visits v WHERE v.person_id = p.id) AS visit_count
               FROM people p ORDER BY p.is_unknown, p.name"""
        ).fetchall()
    return [dict(r) for r in rows]


def update_person(person_id: int, fields: dict):
    allowed = {"name", "relationship", "notes", "is_unknown", "name_source"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with connect() as c:
        c.execute(f"UPDATE people SET {sets} WHERE id = ?", (*fields.values(), person_id))


def delete_person(person_id: int):
    with connect() as c:
        c.execute("DELETE FROM people WHERE id = ?", (person_id,))


# --- embeddings ---

def add_embedding(person_id: int, emb: np.ndarray):
    with connect() as c:
        c.execute(
            "INSERT INTO face_embeddings (person_id, embedding, created_at) VALUES (?,?,?)",
            (person_id, emb.astype(np.float32).tobytes(), now()),
        )


def load_embeddings():
    """Returns (person_ids int array [N], embeddings float32 [N,512])."""
    with connect() as c:
        rows = c.execute("SELECT person_id, embedding FROM face_embeddings").fetchall()
    if not rows:
        return np.zeros((0,), dtype=np.int64), np.zeros((0, 512), dtype=np.float32)
    ids = np.array([r["person_id"] for r in rows], dtype=np.int64)
    embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    return ids, embs


def count_embeddings(person_id: int) -> int:
    with connect() as c:
        return c.execute("SELECT COUNT(*) FROM face_embeddings WHERE person_id = ?", (person_id,)).fetchone()[0]


# --- visits / facts (read side; write side lands in milestone 2) ---

def list_visits(person_id=None):
    with connect() as c:
        if person_id is None:
            rows = c.execute("SELECT * FROM visits ORDER BY started_at DESC").fetchall()
        else:
            rows = c.execute(
                "SELECT * FROM visits WHERE person_id = ? ORDER BY started_at DESC", (person_id,)
            ).fetchall()
    return [dict(r) for r in rows]


def list_facts(person_id: int):
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM facts WHERE person_id = ? ORDER BY created_at DESC", (person_id,)
        ).fetchall()
    return [dict(r) for r in rows]
