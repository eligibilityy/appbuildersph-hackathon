"""Ask + add-a-conversation tests with the LLM mocked (fast, offline).

    cd server
    .venv/Scripts/python -m unittest tests.test_ask -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="memoryaid-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import FastAPI  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import ask  # noqa: E402
import config  # noqa: E402
import db  # noqa: E402
import memory  # noqa: E402
import people  # noqa: E402

DEMO = "Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."


def llm_says(**out):
    base = {"visitor_name": "", "relationship": "", "summary": "", "facts": []}
    return mock.patch.object(memory, "call_llm", return_value=({**base, **out}, 0.4))


class AskTests(unittest.TestCase):
    def setUp(self):
        db.init()
        with db.connect() as c:
            c.execute("DELETE FROM people")
        app = FastAPI()
        app.include_router(ask.router)
        self.client = TestClient(app)
        for p in (
            mock.patch.dict(config.FEATURES, {"memory": True, "tts": False}),
            mock.patch.object(memory.hub, "broadcast_threadsafe"),
        ):
            p.start()
            self.addCleanup(p.stop)

    def visit(self, pid, summary=None, transcript=None):
        now = db.now()
        with db.connect() as c:
            return c.execute(
                "INSERT INTO visits (person_id, started_at, ended_at, transcript, summary, processed) VALUES (?,?,?,?,?,1)",
                (pid, now, now, transcript, summary)).lastrowid

    # --- context ---
    def test_context_has_known_people_memories_and_skips_unknowns(self):
        miguel = people.create_person("Miguel", "grandson")
        vid = self.visit(miguel, summary="Miguel just started a new job in BGC.")
        with db.connect() as c:
            c.execute("INSERT INTO facts (person_id, visit_id, fact, created_at) VALUES (?,?,?,?)",
                      (miguel, vid, "new job in BGC", db.now()))
        people.create_person("Unknown #1", is_unknown=True)
        text, known = ask.build_context()
        self.assertEqual(list(known), [miguel])
        self.assertIn(f"[id {miguel}] Miguel, the patient's grandson", text)
        self.assertIn("Miguel just started a new job in BGC.", text)
        self.assertIn("Facts: new job in BGC", text)
        self.assertNotIn("Unknown", text)

    def test_question_naming_someone_only_sends_their_notes(self):
        ana = people.create_person("Ana", "daughter")
        miguel = people.create_person("Miguel Santos", "grandson")
        self.visit(ana, summary="Ana just came from Baguio.")
        self.visit(miguel, summary="Miguel just started a new job in BGC.")
        self.assertEqual(ask.mentioned("Ano'ng balita kay ana?", ask.known_people()), [ana])
        self.assertEqual(ask.mentioned("What's new with Miguel?", ask.known_people()), [miguel])
        self.assertEqual(ask.mentioned("Who visited today?", ask.known_people()), [])
        self.assertEqual(ask.mentioned("Banana bread?", ask.known_people()), [])  # whole words only
        text, _ = ask.build_context(only=[ana])
        self.assertIn("Ana just came from Baguio.", text)
        self.assertNotIn("BGC", text)
        self.assertIn("Visited today: Ana, Miguel Santos.", text)  # worked out in code, for everyone

    # --- /ask ---
    def test_answer_keeps_only_known_people_and_uses_names(self):
        miguel = people.create_person("Miguel", "grandson")
        unknown = people.create_person("Unknown #1", is_unknown=True)
        reply = {"answer": "He just started a new job in BGC.", "person_ids": [miguel, unknown, 999, miguel]}
        with mock.patch.object(ask, "call_llm", return_value=(reply, 1.2)) as llm:
            r = self.client.post("/ask", json={"question": "Ano'ng balita kay Miguel?"})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertEqual(body["person_ids"], [miguel])
        self.assertEqual(body["answer"], "Miguel just started a new job in BGC.")
        self.assertEqual(body["llm_seconds"], 1.2)
        self.assertIsNone(body["audio_url"])  # tts off in this test
        self.assertEqual(llm.call_args.args[0], "Ano'ng balita kay Miguel?")

    def test_empty_answer_becomes_dont_remember(self):
        people.create_person("Miguel", "grandson")
        with mock.patch.object(ask, "call_llm", return_value=({"answer": "", "person_ids": []}, 0.5)):
            self.assertEqual(self.client.post("/ask", json={"question": "Where does Miguel live?"}).json()["answer"],
                             ask.DONT_KNOW)

    def test_nobody_saved_answers_without_the_llm(self):
        with mock.patch.object(ask, "call_llm") as llm:
            r = self.client.post("/ask", json={"question": "Who visited today?"})
        self.assertEqual(r.json()["answer"], ask.NOBODY)
        llm.assert_not_called()

    def test_blank_question_and_llm_down(self):
        self.assertEqual(self.client.post("/ask", json={"question": "  "}).status_code, 400)
        people.create_person("Miguel", "grandson")
        with mock.patch.object(ask, "call_llm", side_effect=ConnectionError("refused")):
            r = self.client.post("/ask", json={"question": "Who is Miguel?"})
        self.assertEqual(r.status_code, 503)
        self.assertIn("Ollama", r.json()["detail"])

    # --- /people/{id}/conversations ---
    def test_conversation_auto_names_an_unknown_and_returns_the_next_brief(self):
        pid = people.create_person("Unknown #1", is_unknown=True)
        with llm_says(visitor_name="Miguel", relationship="grandson",
                      summary="Miguel just started a new job in BGC.", facts=["new job in BGC"]):
            r = self.client.post(f"/people/{pid}/conversations", json={"transcript": DEMO})
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertTrue(body["renamed"])
        self.assertEqual(body["person"]["name"], "Miguel")
        self.assertEqual(body["facts"], ["new job in BGC"])
        self.assertIn("Miguel just started a new job in BGC.", body["brief"])
        self.assertTrue(body["brief"].startswith("This is Miguel, your grandson."))
        with db.connect() as c:
            row = c.execute("SELECT transcript, processed FROM visits WHERE id = ?", (body["visit_id"],)).fetchone()
        self.assertEqual((row["transcript"], row["processed"]), (DEMO, 1))

    def test_conversation_rejects_short_text_and_missing_person(self):
        pid = people.create_person("Miguel", "grandson")
        self.assertEqual(self.client.post(f"/people/{pid}/conversations", json={"transcript": "Hi Lola"}).status_code, 400)
        self.assertEqual(self.client.post("/people/9999/conversations", json={"transcript": DEMO}).status_code, 404)

    def test_failed_llm_leaves_no_visit_behind(self):
        pid = people.create_person("Miguel", "grandson")
        with mock.patch.object(memory, "call_llm", side_effect=ConnectionError("refused")):
            r = self.client.post(f"/people/{pid}/conversations", json={"transcript": DEMO})
        self.assertEqual(r.status_code, 503)
        with db.connect() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM visits WHERE person_id = ?", (pid,)).fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
