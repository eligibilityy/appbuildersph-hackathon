"""Audio buffering tests with Whisper mocked: a visit's last words are transcribed and saved before
memory reads the transcript.

    cd server
    .venv/Scripts/python -m unittest tests.test_audio -v
"""
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="memoryaid-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import audio  # noqa: E402
import db  # noqa: E402
import hub  # noqa: E402
import memory  # noqa: E402
import people  # noqa: E402

SECOND = b"\x00\x00" * 16_000  # one second of PCM16 silence at 16 kHz


class FakeWhisper:
    """Returns `text` for every call; optionally blocks until `release` is set."""

    def __init__(self, text, release=None):
        self.text, self.release, self.calls = text, release, []

    def transcribe(self, samples, **kwargs):
        self.calls.append(len(samples) / 16_000)
        if self.release is not None:
            self.release.wait(5)
        return [SimpleNamespace(text=self.text)], None


def transcript(visit_id):
    with db.connect() as c:
        return c.execute("SELECT transcript FROM visits WHERE id = ?", (visit_id,)).fetchone()["transcript"]


class AudioFlushTests(unittest.TestCase):
    def setUp(self):
        db.init()
        with db.connect() as c:
            c.execute("DELETE FROM visits")
        self.pid = people.create_person("Unknown #1", is_unknown=True)
        with db.connect() as c:
            self.vid = c.execute("INSERT INTO visits (person_id, started_at) VALUES (?, ?)", (self.pid, db.now())).lastrowid
        audio._buffer.clear()
        audio._buffer_visits.clear()
        audio._worker_active = False
        patches = [
            mock.patch.dict(audio.config.FEATURES, {"audio": True}),
            mock.patch.object(hub, "broadcast_threadsafe"),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def end_visit(self):
        with db.connect() as c:
            c.execute("UPDATE visits SET ended_at = ? WHERE id = ?", (db.now(), self.vid))

    def test_short_speech_before_leaving_is_transcribed_at_visit_end(self):
        whisper = FakeWhisper("Hi Lola, it's Miguel, your grandson.")
        with mock.patch.object(audio, "_get_model", return_value=whisper):
            for _ in range(4):  # 4 s: below the 12 s live-caption interval, so nothing ran yet
                audio.feed(SECOND)
            self.assertEqual(whisper.calls, [])
            self.end_visit()
            audio.feed(SECOND)  # after the visit closed: dropped, but the buffered 4 s are kept
            audio.finish_visit(self.vid)
        self.assertEqual(whisper.calls, [4.0])
        self.assertEqual(transcript(self.vid), "Hi Lola, it's Miguel, your grandson.")
        self.assertEqual(len(audio._buffer), 0)

    def test_finish_waits_for_a_transcription_already_running(self):
        release = threading.Event()
        whisper = FakeWhisper("I just started a new job in BGC.", release)
        with mock.patch.object(audio, "_get_model", return_value=whisper):
            for _ in range(12):  # reaches the interval: a live-caption job starts in the background
                audio.feed(SECOND)
            self.end_visit()
            done = threading.Event()
            t = threading.Thread(target=lambda: (audio.finish_visit(self.vid), done.set()))
            t.start()
            time.sleep(0.2)
            self.assertFalse(done.is_set(), "finish_visit returned while Whisper was still running")
            release.set()
            t.join(5)
        self.assertTrue(done.is_set())
        self.assertEqual(transcript(self.vid), "I just started a new job in BGC.")

    def test_no_text_is_added_once_memory_has_processed_the_visit(self):
        import visits

        self.end_visit()
        self.assertEqual(visits.append_transcript({self.vid}, "last words"), [self.vid])
        with db.connect() as c:
            c.execute("UPDATE visits SET processed = 1 WHERE id = ?", (self.vid,))
        self.assertEqual(visits.append_transcript({self.vid}, "too late"), [])
        self.assertEqual(transcript(self.vid), "last words")

    def test_memory_worker_flushes_audio_before_reading_the_transcript(self):
        order = []
        with (
            mock.patch.object(audio, "finish_visit", side_effect=lambda v: order.append(("audio", v))),
            mock.patch.object(memory, "process_visit", side_effect=lambda v: order.append(("memory", v))),
        ):
            memory._queue.put(self.vid)
            worker = threading.Thread(target=memory._run, daemon=True)
            worker.start()
            for _ in range(50):
                if len(order) == 2:
                    break
                time.sleep(0.02)
        self.assertEqual(order, [("audio", self.vid), ("memory", self.vid)])


if __name__ == "__main__":
    unittest.main()
