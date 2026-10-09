"""Deterministic tests for confirmed-person visit lifecycle and spoken briefs."""
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import db
import people
import visits


class VisitLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.original_db_path = db.DB_PATH
        self.temp_dir = tempfile.TemporaryDirectory()
        db.DB_PATH = Path(self.temp_dir.name) / "visits.db"
        db.init()
        visits._last_present_at.clear()
        visits._present_person_ids.clear()
        visits._last_appearance_write.clear()

    def tearDown(self):
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def test_known_person_starts_and_closes_after_absence_timeout(self):
        person_id = people.create_person("Miguel", "grandson")
        with (
            patch.object(visits.config, "VISIT_END_SECONDS", 10),
            patch.object(db, "now", side_effect=[
                "2026-10-09T10:00:00+00:00",
                "2026-10-09T10:00:11+00:00",
            ]),
            patch.object(visits.time, "monotonic", side_effect=[1.0, 10.0, 11.0, 12.0]),
            patch.object(visits.tts, "speak", return_value=None) as speak,
            patch.object(visits.memory, "enqueue") as enqueue,
        ):
            started = visits.update({person_id})
            self.assertEqual([event["type"] for event in started], ["visit_start", "speak"])
            self.assertEqual(started[0]["person_id"], person_id)
            self.assertEqual(started[1]["text"], "This is Miguel, your grandson.")
            self.assertIsNone(started[1]["audio_url"])
            speak.assert_called_once_with("This is Miguel, your grandson.")
            visit_id = started[0]["visit_id"]
            self.assertEqual(visits.open_visit_ids(), [visit_id])

            self.assertEqual(visits.update(set()), [])  # nine seconds absent
            ended = visits.update(set())
            self.assertEqual(ended, [{"type": "visit_end", "visit_id": visit_id, "person_id": person_id}])
            self.assertEqual(visits.update(set()), [])
            enqueue.assert_called_once_with(visit_id)

        visit = visits.list_visits(person_id)[0]
        self.assertEqual(visit["started_at"], "2026-10-09T10:00:00+00:00")
        self.assertEqual(visit["ended_at"], "2026-10-09T10:00:11+00:00")

    def test_unknown_gets_visit_but_is_never_spoken(self):
        unknown_id = people.create_person("Unknown #1", is_unknown=True)
        with patch.object(visits.tts, "speak") as speak:
            events = visits.update({unknown_id})
            self.assertEqual(events[0]["type"], "visit_start")
            self.assertEqual(events[0]["person_id"], unknown_id)
            self.assertEqual(len(events), 1)
            speak.assert_not_called()
            self.assertEqual(visits.open_visit_ids(), [events[0]["visit_id"]])

    def test_replay_speaks_only_known_people_currently_in_view(self):
        known_id = people.create_person("Miguel", "grandson")
        unknown_id = people.create_person("Unknown #1", is_unknown=True)
        with patch.object(visits.tts, "speak", return_value="/tts/1.wav"):
            visits.update({known_id, unknown_id})
            events = visits.replay_brief()
        self.assertEqual(events, [{
            "type": "speak",
            "text": "This is Miguel, your grandson.",
            "audio_url": "/tts/1.wav",
            "person_id": known_id,
        }])

    def test_returning_brief_uses_name_and_previous_closed_visit_time(self):
        person_id = people.create_person("Miguel", "grandson")
        with db.connect() as c:
            c.execute(
                "INSERT INTO visits (person_id, started_at, ended_at) VALUES (?, ?, ?)",
                (person_id, "2026-10-09T09:00:00+00:00", "2026-10-09T09:30:00+00:00"),
            )
        with patch.object(visits, "humanized_elapsed", return_value="5 minutes") as elapsed:
            text = visits.brief_text(person_id)
        self.assertEqual(text, "This is Miguel, your grandson. You last saw Miguel 5 minutes ago.")
        elapsed.assert_called_once_with("2026-10-09T09:30:00+00:00")
        self.assertNotIn("he", text.lower())
        self.assertNotIn("she", text.lower())

    def test_replay_during_first_visit_doesnt_count_the_current_sighting(self):
        person_id = people.create_person("Miguel", "grandson")
        with db.connect() as c:
            c.execute("INSERT INTO visits (person_id, started_at) VALUES (?, ?)", (person_id, "2026-10-09T10:00:00+00:00"))
            c.execute("UPDATE people SET last_seen_at = ? WHERE id = ?", ("2026-10-09T10:00:05+00:00", person_id))
        self.assertEqual(visits.brief_text(person_id), "This is Miguel, your grandson.")
        with db.connect() as c:  # seen before this visit began (e.g. appearance history): that one counts
            c.execute("UPDATE people SET last_seen_at = ? WHERE id = ?", ("2026-10-09T09:00:00+00:00", person_id))
        with patch.object(visits, "humanized_elapsed", return_value="1 hour"):
            self.assertEqual(visits.brief_text(person_id), "This is Miguel, your grandson. You last saw Miguel 1 hour ago.")

    def test_elapsed_time_formatting(self):
        now = visits.datetime(2026, 10, 9, 10, 5, tzinfo=visits.timezone.utc)
        self.assertEqual(visits.humanized_elapsed("2026-10-09T10:00:00+00:00", now), "5 minutes")
        self.assertEqual(visits.humanized_elapsed("2026-10-09T09:05:00+00:00", now), "1 hour")


if __name__ == "__main__":
    unittest.main()