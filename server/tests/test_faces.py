"""Unit tests for face recognition logic: enrollment, duplicates, matching, tracking, Unknowns.

Uses a fake detector with synthetic 512-d embeddings, so it's fast and deterministic. These tests prove
the LOGIC (thresholds, margins, voting, transactions) - not real-world accuracy. For the real model see
test_faces_real_model.py and tools/eval_faces.py.

    cd server
    .venv/Scripts/python -m unittest discover -s tests -v
"""
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

os.environ["DATA_DIR"] = tempfile.mkdtemp(prefix="memoryaid-test-")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

import config  # noqa: E402
import db  # noqa: E402
import people  # noqa: E402
from faces import engine as engine_mod  # noqa: E402
from faces import quality  # noqa: E402
from faces.engine import DuplicateError, EnrollError, FaceEngine, normalize  # noqa: E402

RNG = np.random.default_rng(1234)


def unit(v):
    return v / np.linalg.norm(v)


def random_identity():
    return unit(RNG.standard_normal(512).astype(np.float32))


def at_similarity(base, sim, rng=RNG):
    """A unit vector with EXACTLY cosine `sim` to `base` (random direction otherwise)."""
    r = rng.standard_normal(512).astype(np.float32)
    orth = unit(r - (r @ base) * base)
    return unit(sim * base + np.sqrt(1 - sim * sim) * orth).astype(np.float32)


def textured_image(brightness=130):
    """A sharp, evenly lit 640x480 frame so the quality gate passes."""
    spread = min(60, brightness, 255 - brightness)
    return RNG.integers(brightness - spread, brightness + spread + 1, size=(480, 640, 3)).astype(np.uint8)


class FakeFace:
    def __init__(self, emb, box=(240, 120, 400, 300), det=0.9, yaw=0.0):
        x1, y1, x2, y2 = box
        w, h = x2 - x1, y2 - y1
        self.bbox = np.array(box, dtype=np.float32)
        self.kps = np.array([[x1 + .3 * w, y1 + .4 * h], [x1 + .7 * w, y1 + .4 * h],
                             [x1 + (.5 + yaw * .4) * w, y1 + .6 * h],
                             [x1 + .35 * w, y1 + .8 * h], [x1 + .65 * w, y1 + .8 * h]], dtype=np.float32)
        self.det_score = det
        self.normed_embedding = normalize(emb)


class FakeApp:
    """Stands in for insightface FaceAnalysis: returns whatever faces the test registered."""

    def __init__(self):
        self.by_image = {}
        self.current = []

    def get(self, img):
        return self.by_image.get(id(img), self.current)


def photos(app, embs, brightness=130, **face_kw):
    """Register one enrollment photo per embedding; returns the images."""
    imgs = []
    for e in embs:
        img = textured_image(brightness)
        app.by_image[id(img)] = [FakeFace(e, **face_kw)]
        imgs.append(img)
    return imgs


def counts():
    with db.connect() as c:
        return (c.execute("SELECT COUNT(*) FROM people").fetchone()[0],
                c.execute("SELECT COUNT(*) FROM face_embeddings").fetchone()[0])


class FaceTestCase(unittest.TestCase):
    def setUp(self):
        db.init()
        with db.connect() as c:
            for t in ("facts", "visits", "face_embeddings", "people"):
                c.execute(f"DELETE FROM {t}")
        self.app = FakeApp()
        self.engine = FaceEngine(app=self.app)
        self.frame = textured_image()

    def enroll(self, name, embs, **kw):
        return self.engine.enroll(name, kw.pop("relationship", None), photos(self.app, embs), **kw)

    def feed(self, *faces, n=1):
        """Send n frames containing these faces; returns the last FrameResult."""
        res = None
        for _ in range(n):
            self.app.current = list(faces)
            res = self.engine.process(self.frame)
        return res

    def leave(self):
        """Nobody in view until every track expires."""
        self.feed(n=config.TRACK_MAX_MISSES + 2)


class TestEnrollment(FaceTestCase):
    def test_one_request_creates_exactly_one_person_with_all_embeddings(self):  # 1, 3
        base = random_identity()
        pid = self.enroll("Miguel", [at_similarity(base, 0.8) for _ in range(5)], relationship="grandson")
        self.assertEqual(counts(), (1, 5))
        self.assertEqual(engine_mod.count_embeddings(pid), 5)
        self.assertEqual(self.engine.embedding_count_in_memory(pid), 5)
        p = people.get_person(pid)
        self.assertEqual((p["name"], p["relationship"], p["is_unknown"], p["name_source"]),
                         ("Miguel", "grandson", 0, "enrolled"))

    def test_embeddings_belong_to_the_right_person(self):  # 3
        a, b = random_identity(), random_identity()
        pa = self.enroll("Ana", [at_similarity(a, 0.8) for _ in range(3)])
        pb = self.enroll("Ben", [at_similarity(b, 0.8) for _ in range(4)])
        self.assertEqual(engine_mod.count_embeddings(pa), 3)
        self.assertEqual(engine_mod.count_embeddings(pb), 4)
        self.assertEqual(self.engine.match(at_similarity(a, 0.7))[0], pa)
        self.assertEqual(self.engine.match(at_similarity(b, 0.7))[0], pb)

    def test_duplicate_face_is_rejected_with_the_existing_person(self):  # 2
        base = random_identity()
        pid = self.enroll("Miguel", [at_similarity(base, 0.8) for _ in range(3)])
        with self.assertRaises(DuplicateError) as cm:
            self.enroll("Miguel D.", [at_similarity(base, 0.8) for _ in range(3)])
        self.assertEqual(cm.exception.candidates[0]["id"], pid)
        self.assertIn("face", cm.exception.candidates[0]["reason"])
        self.assertEqual(counts(), (1, 3))

    def test_same_name_is_flagged_even_with_a_different_face(self):  # 2
        first = random_identity()
        self.enroll("Miguel", [at_similarity(first, 0.8) for _ in range(3)])
        with self.assertRaises(DuplicateError) as cm:
            other = random_identity()
            self.enroll(" miguel ", [at_similarity(other, 0.8) for _ in range(3)])
        self.assertEqual(cm.exception.candidates[0]["reason"], "name")
        self.assertEqual(counts()[0], 1)

    def test_force_enrolls_a_genuinely_different_person(self):  # 2
        base = random_identity()
        self.enroll("Maria", [at_similarity(base, 0.8) for _ in range(3)])
        self.enroll("Maria's twin", [at_similarity(base, 0.8) for _ in range(3)], force=True)
        self.assertEqual(counts(), (2, 6))

    def test_face_matching_an_unknown_is_flagged_so_history_can_be_kept(self):  # 2, B
        base = random_identity()
        self.feed(FakeFace(at_similarity(base, 0.9)), n=config.CONFIRM_FRAMES)
        unknown_id = next(iter(self.engine.people))
        with self.assertRaises(DuplicateError) as cm:
            self.enroll("Miguel", [at_similarity(base, 0.8) for _ in range(3)])
        self.assertEqual(cm.exception.candidates[0]["id"], unknown_id)
        self.assertTrue(cm.exception.candidates[0]["is_unknown"])

    def test_concurrent_duplicate_requests_create_one_person(self):  # 2 / C (double-clicked Save)
        base = random_identity()
        batches = [photos(self.app, [at_similarity(base, 0.8) for _ in range(3)]) for _ in range(4)]
        errors = []

        def go(imgs):
            try:
                self.engine.enroll("Miguel", None, imgs)
            except DuplicateError as e:
                errors.append(e)

        threads = [threading.Thread(target=go, args=(b,)) for b in batches]
        [t.start() for t in threads]
        [t.join() for t in threads]
        self.assertEqual(counts()[0], 1)
        self.assertEqual(len(errors), 3)

    def test_low_quality_photo_is_rejected_with_its_index(self):  # 9
        base = random_identity()
        imgs = photos(self.app, [at_similarity(base, 0.8) for _ in range(2)])
        imgs += photos(self.app, [at_similarity(base, 0.8)], brightness=15)   # too dark
        imgs += photos(self.app, [at_similarity(base, 0.8)], box=(300, 200, 350, 250))  # too small
        with self.assertRaises(EnrollError) as cm:
            self.engine.enroll("Miguel", None, imgs)
        bad = {p["index"]: p["reason"] for p in cm.exception.photos}
        self.assertEqual(set(bad), {2, 3})
        self.assertIn("dark", bad[2])
        self.assertIn("small", bad[3])
        self.assertEqual(counts(), (0, 0))

    def test_zero_or_multiple_faces_rejected(self):  # 9
        base = random_identity()
        imgs = photos(self.app, [at_similarity(base, 0.8) for _ in range(3)])
        self.app.by_image[id(imgs[0])] = []
        self.app.by_image[id(imgs[1])] = [FakeFace(base), FakeFace(random_identity(), box=(20, 20, 180, 200))]
        with self.assertRaises(EnrollError) as cm:
            self.engine.enroll("Miguel", None, imgs)
        msg = str(cm.exception)
        self.assertIn("Photo 1: no face", msg)
        self.assertIn("Photo 2: found 2 faces", msg)
        self.assertEqual(counts(), (0, 0))

    def test_photo_of_someone_else_in_the_set_is_rejected(self):  # 9
        base = random_identity()
        embs = [at_similarity(base, 0.8) for _ in range(4)] + [random_identity()]
        with self.assertRaises(EnrollError) as cm:
            self.enroll("Miguel", embs)
        self.assertEqual([p["index"] for p in cm.exception.photos], [4])
        self.assertEqual(counts(), (0, 0))

    def test_database_failure_mid_enrollment_leaves_nothing_behind(self):  # 10
        base = random_identity()
        real_blob, calls = engine_mod._blob, []

        def flaky(e):
            calls.append(1)
            if len(calls) == 3:
                raise RuntimeError("disk full")
            return real_blob(e)

        with mock.patch.object(engine_mod, "_blob", flaky):
            with self.assertRaises(RuntimeError):
                self.enroll("Miguel", [at_similarity(base, 0.8) for _ in range(4)])
        self.assertEqual(counts(), (0, 0))
        self.assertEqual(len(self.engine.people), 0)

    def test_add_photos_refuses_someone_elses_face(self):
        a, b = random_identity(), random_identity()
        pa = self.enroll("Ana", [at_similarity(a, 0.8) for _ in range(3)])
        self.enroll("Ben", [at_similarity(b, 0.8) for _ in range(3)])
        with self.assertRaises(DuplicateError):
            self.engine.add_photos(pa, photos(self.app, [at_similarity(b, 0.8) for _ in range(2)]))
        self.assertEqual(engine_mod.count_embeddings(pa), 3)
        # Ana's own glasses photos (lower similarity, but closest to Ana) are accepted.
        self.engine.add_photos(pa, photos(self.app, [at_similarity(a, 0.4) for _ in range(2)]))
        self.assertEqual(engine_mod.count_embeddings(pa), 5)


class TestMatching(FaceTestCase):
    def test_person_is_matched_against_all_their_embeddings(self):  # 4
        a = random_identity()
        side = random_identity()  # e.g. a very different angle captured as the 3rd photo
        embs = [at_similarity(a, 0.8), at_similarity(a, 0.8), unit(0.5 * a + side)]
        pid = self.engine.enroll("Ana", None, photos(self.app, embs[:2]) + photos(self.app, [embs[2]]), force=True)
        probe = at_similarity(normalize(embs[2]), 0.9)
        scores = self.engine.person_scores(probe)
        self.assertAlmostEqual(scores[pid], float(np.max(self.engine.gallery @ probe)), places=5)
        self.assertGreater(scores[pid], float(embs[0] @ probe))

    def test_embeddings_are_l2_normalised_when_loaded(self):
        a = random_identity()
        pid = self.enroll("Ana", [at_similarity(a, 0.8) for _ in range(3)])
        with db.connect() as c:  # simulate a legacy un-normalised row
            c.execute("INSERT INTO face_embeddings (person_id, embedding, created_at) VALUES (?,?,?)",
                      (pid, (a * 7).astype(np.float32).tobytes(), db.now()))
        self.engine.reload()
        np.testing.assert_allclose(np.linalg.norm(self.engine.gallery, axis=1), 1.0, atol=1e-5)


class TestGlasses(FaceTestCase):
    """Synthetic stand-in for glasses: a fixed 'glasses direction' moves the embedding away from the
    bare face. Real-model behaviour is checked in test_faces_real_model.py."""

    def setUp(self):
        super().setUp()
        self.face = random_identity()
        self.glasses = at_similarity(self.face, 0.55)  # same person, glasses on

    def test_enrolled_with_glasses_recognised_without(self):  # 5
        pid = self.enroll("Miguel", [at_similarity(self.glasses, 0.9) for _ in range(3)])
        res = self.feed(FakeFace(at_similarity(self.face, 0.95)), n=config.CONFIRM_FRAMES)
        self.assertEqual(res.faces[0]["person_id"], pid)

    def test_enrolled_without_glasses_recognised_with(self):  # 6
        pid = self.enroll("Miguel", [at_similarity(self.face, 0.9) for _ in range(3)])
        res = self.feed(FakeFace(at_similarity(self.glasses, 0.95)), n=config.CONFIRM_FRAMES)
        self.assertEqual(res.faces[0]["person_id"], pid)

    def test_heavy_glasses_just_under_threshold_confirmed_only_after_sustained_evidence(self):  # 6
        pid = self.enroll("Miguel", [self.face] * 3)
        heavy = [FakeFace(at_similarity(self.face, 0.41)) for _ in range(config.WEAK_MATCH_FRAMES)]
        for i, f in enumerate(heavy):
            res = self.feed(f)
            if i < config.WEAK_MATCH_FRAMES - 1:
                self.assertIsNone(res.faces[0]["person_id"], f"named too early at frame {i + 1}")
        self.assertEqual(res.faces[0]["person_id"], pid)
        self.assertEqual(counts(), (1, 3), "no Unknown created and nothing learned from a weak match")

    def test_enrolling_both_looks_gives_a_strong_match_either_way(self):  # A
        pid = self.enroll("Miguel", [self.face, at_similarity(self.face, 0.9), self.glasses,
                                     at_similarity(self.glasses, 0.9)])
        for probe in (self.face, self.glasses):
            self.leave()
            res = self.feed(FakeFace(at_similarity(probe, 0.9)), n=config.CONFIRM_FRAMES)
            self.assertEqual(res.faces[0]["person_id"], pid)


class TestUncertainAndUnknown(FaceTestCase):
    def test_ambiguous_face_between_two_people_stays_unnamed(self):  # 7
        a = random_identity()
        b = at_similarity(a, 0.6)  # two people who look alike
        self.enroll("Ana", [a] * 3)
        self.enroll("Bea", [b] * 3, force=True)
        mid = unit(a + b)  # equally close to both
        res = self.feed(FakeFace(mid), n=30)
        self.assertIsNone(res.faces[0]["person_id"])
        self.assertEqual(counts()[0], 2, "an ambiguous known-looking face must not become an Unknown either")

    def test_weak_resemblance_never_names_a_stranger(self):  # 7
        a = random_identity()
        self.enroll("Ana", [a] * 3)
        res = self.feed(FakeFace(at_similarity(a, 0.30)), n=40)
        self.assertNotEqual(res.faces[0]["name"], "Ana")
        self.assertTrue(res.faces[0]["is_unknown"])  # stays a separate Unknown, not Ana

    def test_returning_unknown_reuses_the_same_record(self):  # 8
        s = random_identity()
        res = self.feed(FakeFace(at_similarity(s, 0.9)), n=config.CONFIRM_FRAMES)
        first = res.faces[0]["person_id"]
        self.assertIsNotNone(first)
        self.assertEqual(self.engine.people[first]["name"], "Unknown #1")
        for _ in range(3):
            self.leave()
            # comes back elsewhere in the frame (new track) and a bit different
            res = self.feed(FakeFace(at_similarity(s, 0.7), box=(40, 60, 200, 240)), n=config.CONFIRM_FRAMES + 2)
            self.assertEqual(res.faces[0]["person_id"], first)
        self.assertEqual(counts()[0], 1)

    def test_brief_detection_dropouts_do_not_create_new_unknowns(self):  # 8
        s = random_identity()
        face = FakeFace(at_similarity(s, 0.9))
        self.feed(face, n=config.CONFIRM_FRAMES)
        for _ in range(5):
            self.feed(n=2)                 # detector misses the face for a couple of frames
            res = self.feed(FakeFace(at_similarity(s, 0.8)), n=2)
        self.assertEqual(counts()[0], 1)
        self.assertIsNotNone(res.faces[0]["person_id"])

    def test_bad_quality_frames_never_create_unknowns(self):  # 8, 9
        res = self.feed(FakeFace(random_identity(), yaw=2.0), n=20)  # extreme head turn
        self.assertIsNone(res.faces[0]["person_id"])
        self.assertEqual(counts(), (0, 0))

    def test_unknown_labels_never_repeat_after_a_delete(self):
        self.feed(FakeFace(random_identity()), n=config.CONFIRM_FRAMES)
        self.leave()
        self.feed(FakeFace(random_identity(), box=(40, 60, 200, 240)), n=config.CONFIRM_FRAMES)
        first = min(self.engine.people)
        people.delete_person(first)
        self.engine.reload()
        self.assertEqual(people.next_unknown_label(), "Unknown #3")


class TestTrackingStability(FaceTestCase):
    def test_identity_is_stable_through_noisy_frames(self):  # 11
        a, b = random_identity(), random_identity()
        pa = self.enroll("Ana", [a] * 3)
        self.enroll("Ben", [b] * 3)
        self.feed(FakeFace(at_similarity(a, 0.8)), n=config.CONFIRM_FRAMES)
        rng = np.random.default_rng(7)
        names = set()
        for i in range(60):
            if i % 10 == 3:
                emb = unit(0.5 * a + 0.6 * b)        # one odd frame that looks more like Ben
            elif i % 7 == 0:
                emb = at_similarity(a, 0.3, rng)      # a frame where Ana barely matches
            else:
                emb = at_similarity(a, 0.7, rng)
            res = self.feed(FakeFace(emb))
            names.add(res.faces[0]["person_id"])
        self.assertEqual(names, {pa})

    def test_identity_switches_only_after_sustained_disagreement(self):
        a, b = random_identity(), random_identity()
        pa = self.enroll("Ana", [a] * 3)
        pb = self.enroll("Ben", [b] * 3)
        self.feed(FakeFace(a), n=config.CONFIRM_FRAMES)
        res = self.feed(FakeFace(b), n=2)
        self.assertEqual(res.faces[0]["person_id"], pa)
        res = self.feed(FakeFace(b), n=config.CONFIRM_FRAMES + config.TRACK_SCORE_WINDOW)
        self.assertEqual(res.faces[0]["person_id"], pb)

    def test_two_people_keep_their_own_names(self):  # 11, 13 (backend side)
        a, b = random_identity(), random_identity()
        pa = self.enroll("Ana", [a] * 3)
        pb = self.enroll("Ben", [b] * 3)
        left, right = (20, 100, 180, 280), (420, 100, 580, 280)
        res = self.feed(FakeFace(a, box=left), FakeFace(b, box=right), n=config.CONFIRM_FRAMES)
        by_x = sorted(res.faces, key=lambda f: f["box"][0])
        self.assertEqual([f["person_id"] for f in by_x], [pa, pb])

    def test_deleted_person_is_forgotten_by_live_tracks(self):
        a = random_identity()
        pa = self.enroll("Ana", [a] * 3)
        self.feed(FakeFace(a), n=config.CONFIRM_FRAMES)
        people.delete_person(pa)
        self.engine.reload()
        for t in self.engine.tracker.tracks:
            self.assertIsNone(t.person_id)
            self.assertTrue(all(pa not in fr for fr in t.scores))


class TestWebSocketContract(FaceTestCase):
    def test_faces_event_payload_shape(self):  # 15
        a = random_identity()
        pid = self.enroll("Ana", [a] * 3, relationship="daughter")
        res = self.feed(FakeFace(a), FakeFace(random_identity(), box=(20, 20, 60, 60)), n=config.CONFIRM_FRAMES)
        self.assertEqual(len(res.faces), 2)
        for f in res.faces:
            self.assertEqual(set(f), {"box", "person_id", "name", "relationship", "is_unknown", "score"})
            self.assertEqual(len(f["box"]), 4)
            self.assertIsInstance(f["score"], float)
        known = next(f for f in res.faces if f["person_id"] == pid)
        self.assertEqual((known["name"], known["relationship"], known["is_unknown"]), ("Ana", "daughter", False))
        pending = next(f for f in res.faces if f["person_id"] != pid)
        self.assertEqual((pending["name"], pending["is_unknown"]), (None, None))
        self.assertEqual(res.present_person_ids, {pid})


class TestQuality(unittest.TestCase):
    def test_reasons(self):
        img = textured_image()
        self.assertIsNone(quality.check(FakeFace(random_identity()), img, strict=True))
        self.assertIn("small", quality.check(FakeFace(random_identity(), box=(0, 0, 50, 50)), img, strict=True))
        self.assertIn("turned", quality.check(FakeFace(random_identity(), yaw=1.0), img, strict=True))
        flat = np.full((480, 640, 3), 128, np.uint8)
        self.assertIn("blurry", quality.check(FakeFace(random_identity()), flat, strict=True))
        self.assertIn("bright", quality.check(FakeFace(random_identity()), textured_image(240), strict=True))


if __name__ == "__main__":
    unittest.main()
