"""Memory extraction tests with the LLM mocked (fast, offline). The real model is exercised by
tools/try_memory.py.

    cd server
    .venv/Scripts/python -m unittest tests.test_memory -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="memoryaid-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import db  # noqa: E402
import memory  # noqa: E402
import people  # noqa: E402

DEMO = "Hi Lola, it's Miguel, your grandson. I just started a new job in BGC."


def visit(pid, transcript, ended=True):
    now = db.now()
    with db.connect() as c:
        return c.execute(
            "INSERT INTO visits (person_id, started_at, ended_at, transcript, processed) VALUES (?,?,?,?,0)",
            (pid, now, now if ended else None, transcript)).lastrowid


def llm_returns(**out):
    base = {"visitor_name": "", "relationship": "", "summary": "", "facts": []}
    return mock.patch.object(memory, "call_llm", return_value=({**base, **out}, 0.1))


class MemoryTests(unittest.TestCase):
    def setUp(self):
        db.init()
        with db.connect() as c:
            for t in ("facts", "visits", "face_embeddings", "people"):
                c.execute(f"DELETE FROM {t}")
        self.broadcasts = mock.patch.object(memory.hub, "broadcast_threadsafe").start()
        self.addCleanup(mock.patch.stopall)

    def row(self, vid):
        with db.connect() as c:
            v = dict(c.execute("SELECT * FROM visits WHERE id = ?", (vid,)).fetchone())
            facts = [r[0] for r in c.execute("SELECT fact FROM facts WHERE visit_id = ? ORDER BY id", (vid,))]
        return v, facts

    def test_demo_saves_summary_facts_and_names_the_unknown(self):
        pid = people.create_person("Unknown #1", None, is_unknown=True)
        vid = visit(pid, DEMO)
        with llm_returns(visitor_name="Miguel", relationship="grandson",
                         summary="Miguel just started a new job in BGC.", facts=["new job in BGC"]):
            memory.process_visit(vid)
        v, facts = self.row(vid)
        self.assertEqual((v["summary"], v["processed"]), ("Miguel just started a new job in BGC.", 1))
        self.assertEqual(facts, ["new job in BGC"])
        p = people.get_person(pid)
        self.assertEqual((p["name"], p["relationship"], p["is_unknown"], p["name_source"]),
                         ("Miguel", "grandson", 0, "auto"))
        self.broadcasts.assert_called_with({"type": "memory_updated", "person_id": pid})

    def test_never_overwrites_an_enrolled_name(self):
        pid = people.create_person("Miguel Santos", "grandson", is_unknown=False, name_source="enrolled")
        vid = visit(pid, "Hi Lola, it's Migs! I brought you some pandesal this morning.")
        with llm_returns(visitor_name="Migs", relationship="grandchild", summary="Migs brought you pandesal."):
            memory.process_visit(vid)
        p = people.get_person(pid)
        self.assertEqual((p["name"], p["relationship"], p["name_source"]), ("Miguel Santos", "grandson", "enrolled"))

    def test_a_name_that_was_not_said_is_not_used(self):
        pid = people.create_person("Unknown #1", None, is_unknown=True)
        vid = visit(pid, "Hi Lola, I just started a new job in BGC, it's going well.")
        with llm_returns(visitor_name="Miguel", summary="Your visitor just started a new job in BGC."):
            memory.process_visit(vid)
        self.assertEqual(people.get_person(pid)["is_unknown"], 1)

    def test_kinship_words_are_not_names(self):
        pid = people.create_person("Unknown #1", None, is_unknown=True)
        vid = visit(pid, "Nanay, kumain na po ba kayo? Dinala ko yung paborito niyong adobo.")
        with llm_returns(visitor_name="Nanay", relationship="child", summary="Your visitor brought adobo."):
            memory.process_visit(vid)
        self.assertEqual(people.get_person(pid)["is_unknown"], 1)

    def test_short_transcript_is_skipped_without_calling_the_llm(self):
        pid = people.create_person("Ana", "daughter", name_source="enrolled")
        vid = visit(pid, "Hi Lola!")
        with mock.patch.object(memory, "call_llm") as llm:
            self.assertIsNone(memory.process_visit(vid))
            llm.assert_not_called()
        v, facts = self.row(vid)
        self.assertEqual((v["processed"], v["summary"], facts), (1, None, []))

    def test_reprocessing_replaces_facts_instead_of_duplicating(self):
        pid = people.create_person("Ana", "daughter", name_source="enrolled")
        vid = visit(pid, "Hi Ma, I'm going to Cebu next week for a work conference.")
        for _ in range(2):
            with llm_returns(summary="Ana is going to Cebu next week.", facts=["going to Cebu next week"]):
                memory.process_visit(vid)
        self.assertEqual(self.row(vid)[1], ["going to Cebu next week"])

    def test_llm_failure_leaves_the_visit_for_a_retry(self):
        pid = people.create_person("Ana", "daughter", name_source="enrolled")
        vid = visit(pid, "Hi Ma, I'm going to Cebu next week for a work conference.")
        with mock.patch.object(memory, "call_llm", side_effect=ConnectionError("ollama down")):
            with self.assertRaises(ConnectionError):
                memory.process_visit(vid)
        self.assertEqual(self.row(vid)[0]["processed"], 0)

    def test_pronouns_are_replaced_with_the_name(self):
        pid = people.create_person("Miguel", "grandson", name_source="enrolled")
        vid = visit(pid, DEMO)
        with llm_returns(summary="He told you about his new job in BGC."):
            memory.process_visit(vid)
        self.assertEqual(self.row(vid)[0]["summary"], "Miguel told you about Miguel's new job in BGC.")

    def test_colon_glitch_is_repaired_from_the_transcript(self):
        pid = people.create_person("Unknown #1", None, is_unknown=True)
        vid = visit(pid, DEMO)
        with llm_returns(visitor_name="Miguel", summary="Mig: I just started a new job in BGC.",
                         facts=["Mig: just started a new job in BGC"]):
            memory.process_visit(vid)
        v, facts = self.row(vid)
        self.assertEqual(v["summary"], 'Miguel said, "I just started a new job in BGC."')
        self.assertEqual(facts, ["Miguel just started a new job in BGC"])

    def test_start_requeues_finished_unprocessed_visits_only(self):
        pid = people.create_person("Ana", "daughter", name_source="enrolled")
        done = visit(pid, "x " * 10)
        open_ = visit(pid, "x " * 10, ended=False)
        with mock.patch.object(memory, "_worker", None), mock.patch.object(memory, "_queue") as q, \
                mock.patch.object(memory.threading, "Thread"):
            memory.start()
        queued = [c.args[0] for c in q.put.call_args_list]
        self.assertIn(done, queued)
        self.assertNotIn(open_, queued)


if __name__ == "__main__":
    unittest.main()
