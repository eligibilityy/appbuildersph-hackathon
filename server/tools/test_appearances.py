"""Focused tests for registration timestamps and hourly appearance persistence."""
import tempfile
import sqlite3
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import db
import people
import visits
from faces.engine import move_person_data


class AppearanceTests(unittest.TestCase):
    def setUp(self):
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(tempfile.mkdtemp()) / "test.db"
        db.init()
        visits._last_appearance_write.clear()
        visits._active_monitoring.clear()
        visits._last_monitoring_heartbeat.clear()

    def tearDown(self):
        db.DB_PATH = self.original_db_path

    def test_registration_and_hourly_upsert(self):
        person_id = people.create_person("Ana")
        registered_at = people.get_person(person_id)["registered_at"]
        self.assertTrue(registered_at.endswith("+00:00"))
        people.update_person(person_id, {"name": "Ana Reyes", "relationship": "daughter"})
        self.assertEqual(people.get_person(person_id)["registered_at"], registered_at)

        first = "2026-10-09T09:12:00+00:00"
        latest = "2026-10-09T09:48:00+00:00"
        for stamp in (first, latest):
            visits._last_appearance_write.clear()
            visits.record_confirmed_appearances({person_id}, stamp)
        visits._last_appearance_write.clear()
        for _ in range(50):
            visits.record_confirmed_appearances({person_id}, latest)

        with db.connect() as c:
            rows = c.execute("SELECT * FROM appearances WHERE person_id = ?", (person_id,)).fetchall()
            person = c.execute(
                "SELECT first_seen_at, last_seen_at FROM people WHERE id = ?", (person_id,)
            ).fetchone()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["first_seen_at"], first)
        self.assertEqual(rows[0]["last_seen_at"], latest)
        self.assertEqual(person["first_seen_at"], first)
        self.assertEqual(person["last_seen_at"], latest)

    def test_hour_bucket_uniqueness_and_distinct_people(self):
        first_id = people.create_person("Ana")
        second_id = people.create_person("Ben")
        bucket = db.hour_bucket("2026-10-09T09:12:00+00:00")
        with db.connect() as c:
            c.execute(
                "INSERT INTO appearances (person_id, hour_bucket, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
                (first_id, bucket, "2026-10-09T09:12:00+00:00", "2026-10-09T09:12:00+00:00"),
            )
            with self.assertRaises(db.sqlite3.IntegrityError):
                c.execute(
                    "INSERT INTO appearances (person_id, hour_bucket, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
                    (first_id, bucket, "2026-10-09T09:20:00+00:00", "2026-10-09T09:20:00+00:00"),
                )
            c.execute(
                "INSERT INTO appearances (person_id, hour_bucket, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)",
                (second_id, bucket, "2026-10-09T09:15:00+00:00", "2026-10-09T09:15:00+00:00"),
            )
        with db.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM appearances").fetchone()[0], 2)

    def test_later_hour_creates_a_second_persistent_record(self):
        person_id = people.create_person("Ana")
        visits.record_confirmed_appearances({person_id}, "2026-10-09T09:58:00+00:00")
        visits._last_appearance_write.clear()
        visits.record_confirmed_appearances({person_id}, "2026-10-09T10:02:00+00:00")
        db.init()
        with db.connect() as c:
            rows = c.execute(
                "SELECT hour_bucket FROM appearances WHERE person_id = ? ORDER BY hour_bucket",
                (person_id,),
            ).fetchall()
        self.assertEqual([row["hour_bucket"] for row in rows], [
            "2026-10-09T09:00:00+00:00", "2026-10-09T10:00:00+00:00"
        ])

    def test_legacy_timestamps_backfill_without_inventing_missing_values(self):
        legacy_path = Path(tempfile.mkdtemp()) / "legacy.db"
        db.DB_PATH = legacy_path
        connection = sqlite3.connect(legacy_path)
        connection.executescript(
            """CREATE TABLE people (
                 id INTEGER PRIMARY KEY, name TEXT, relationship TEXT, notes TEXT,
                 is_unknown INTEGER DEFAULT 0, name_source TEXT, created_at TEXT
               );
               CREATE TABLE face_embeddings (
                 id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES people(id),
                 embedding BLOB, created_at TEXT
               );
               CREATE TABLE visits (
                 id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES people(id),
                 started_at TEXT, ended_at TEXT, transcript TEXT, summary TEXT,
                 processed INTEGER DEFAULT 0
               );
               CREATE TABLE facts (
                 id INTEGER PRIMARY KEY, person_id INTEGER REFERENCES people(id),
                 visit_id INTEGER REFERENCES visits(id), fact TEXT, created_at TEXT
               );
               INSERT INTO people (id, name, created_at) VALUES (1, 'Legacy', '2026-10-09T15:42:00');
               INSERT INTO people (id, name, created_at) VALUES (2, 'No timestamp', NULL);
               INSERT INTO visits (id, person_id, started_at) VALUES (1, 1, '2026-10-08T09:10:00');"""
        )
        connection.close()
        db.init()
        with db.connect() as c:
            migrated = c.execute(
                "SELECT registered_at, first_seen_at, last_seen_at FROM people WHERE id = 1"
            ).fetchone()
            missing = c.execute("SELECT registered_at, first_seen_at FROM people WHERE id = 2").fetchone()
        self.assertTrue(migrated["registered_at"].endswith("+00:00"))
        self.assertEqual(migrated["first_seen_at"], migrated["last_seen_at"])
        self.assertIsNone(missing["registered_at"])
        self.assertIsNone(missing["first_seen_at"])

    def test_coverage_status_is_conservative(self):
        person_id = people.create_person("Ana")
        session_id = visits.start_monitoring_session("2026-10-09T08:00:00+00:00")
        visits.end_monitoring_session(session_id, "2026-10-09T10:00:00+00:00")
        _, hourly = visits.appearance_history(
            person_id, datetime(2026, 10, 9, 10, tzinfo=timezone.utc)
        )
        by_bucket = {item["hour_bucket"]: item for item in hourly}
        self.assertEqual(by_bucket["2026-10-09T09:00:00+00:00"]["status"], "not_seen")
        self.assertEqual(by_bucket["2026-10-09T10:00:00+00:00"]["status"], "monitoring_unavailable")
        self.assertTrue(by_bucket["2026-10-09T10:00:00+00:00"]["in_progress"])
        self.assertEqual(by_bucket["2026-10-09T07:00:00+00:00"]["status"], "monitoring_unavailable")

    def test_merge_consolidates_person_hour(self):
        source_id = people.create_person("Unknown #1", is_unknown=True)
        target_id = people.create_person("Miguel")
        visits.record_confirmed_appearances({source_id}, "2026-10-09T09:12:00+00:00")
        visits.record_confirmed_appearances({target_id}, "2026-10-09T09:45:00+00:00")
        move_person_data(source_id, target_id)
        with db.connect() as c:
            rows = c.execute("SELECT * FROM appearances WHERE person_id = ?", (target_id,)).fetchall()
            person = c.execute(
                "SELECT first_seen_at, last_seen_at FROM people WHERE id = ?", (target_id,)
            ).fetchone()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["first_seen_at"], "2026-10-09T09:12:00+00:00")
        self.assertEqual(rows[0]["last_seen_at"], "2026-10-09T09:45:00+00:00")
        self.assertEqual(person["first_seen_at"], "2026-10-09T09:12:00+00:00")
        self.assertEqual(person["last_seen_at"], "2026-10-09T09:45:00+00:00")


if __name__ == "__main__":
    unittest.main()