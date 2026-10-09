"""Real InsightFace model + SYNTHETIC glasses drawn on InsightFace's bundled sample photos (no real people
of ours). Checks both directions of the glasses problem through the real enrollment + tracking pipeline.

This is evidence about drawn-on frames, not about real glasses (no reflections, no frame shadows, no
lens distortion). Real-world numbers have to come from tools/eval_faces.py with consented photos.
Skipped automatically if insightface or the buffalo_s model isn't available.

    cd server
    .venv/Scripts/python -m unittest tests.test_faces_real_model -v
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="memoryaid-test-"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

import config  # noqa: E402
import db  # noqa: E402

try:
    import cv2
    import insightface

    IMAGES = Path(insightface.__file__).parent / "data" / "images"
    MODEL_OK = (Path.home() / ".insightface" / "models" / config.FACE_MODEL).exists() and IMAGES.exists()
except ImportError:
    MODEL_OK = False


def draw_glasses(img, kps, dark=False):
    """Round frames + bridge + temples over the 5-point eye landmarks."""
    out = img.copy()
    le, re = kps[0], kps[1]
    d = float(np.linalg.norm(re - le))
    r, th = int(d * 0.38), max(2, int(d * 0.09))
    for e in (le, re):
        c = (int(e[0]), int(e[1]))
        if dark:
            cv2.circle(out, c, r, (25, 25, 25), -1)
        cv2.circle(out, c, r, (10, 10, 10), th)
    cv2.line(out, (int(le[0] + r), int(le[1])), (int(re[0] - r), int(re[1])), (10, 10, 10), th)
    cv2.line(out, (int(le[0] - r), int(le[1])), (int(le[0] - r - d * .4), int(le[1] - d * .05)), (10, 10, 10), th)
    cv2.line(out, (int(re[0] + r), int(re[1])), (int(re[0] + r + d * .4), int(re[1] - d * .05)), (10, 10, 10), th)
    return out


def padded(img, size):
    """Centre a face photo on a 640x480 black frame (like a webcam frame)."""
    f = cv2.resize(img, (size, size))
    top, left = (480 - size) // 2, (640 - size) // 2
    return cv2.copyMakeBorder(f, top, 480 - size - top, left, 640 - size - left, cv2.BORDER_CONSTANT)


@unittest.skipUnless(MODEL_OK, "InsightFace buffalo_s model / sample images not available")
class TestRealModelSyntheticGlasses(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from faces.engine import FaceEngine

        db.init()
        cls.engine = FaceEngine()
        tom = cv2.imread(str(IMAGES / "Tom_Hanks_54745.png"))
        cls.plain = [padded(tom, s) for s in (200, 224, 250)]
        cls.glasses = []
        for img in cls.plain:
            faces = cls.engine.detect(img)
            assert len(faces) == 1
            cls.glasses.append(draw_glasses(img, faces[0].kps))
        group = cv2.imread(str(IMAGES / "t1.jpg"))
        cls.strangers = []
        for f in cls.engine.detect(group):
            x1, y1, x2, y2 = f.bbox.astype(int)
            m = int((x2 - x1) * 0.6)
            crop = group[max(0, y1 - m):y2 + m, max(0, x1 - m):x2 + m]
            cls.strangers.append(padded(crop, 224))

    def setUp(self):
        db.init()
        with db.connect() as c:
            for t in ("facts", "visits", "face_embeddings", "people"):
                c.execute(f"DELETE FROM {t}")
        self.engine.reload()
        self.engine.tracker.clear()

    def run_frames(self, img, n):
        res = None
        for _ in range(n):
            res = self.engine.process(img)
        self.engine.tracker.clear()
        return res

    def emb(self, img):
        return self.engine.detect(img)[0].normed_embedding

    def test_similarity_is_symmetric_so_any_asymmetry_comes_from_the_pipeline(self):
        a, b = self.emb(self.plain[1]), self.emb(self.glasses[1])
        self.assertAlmostEqual(float(a @ b), float(b @ a), places=6)
        print(f"\n  [measured] plain vs synthetic-glasses similarity (same photo): {float(a @ b):.3f}")

    def test_enrolled_without_glasses_recognised_with_glasses(self):
        pid = self.engine.enroll("Tom", "friend", self.plain)
        before = self.engine.person_scores(self.emb(self.glasses[1]))[pid]  # before the tracker learns anything
        res = self.run_frames(self.glasses[1], config.WEAK_MATCH_FRAMES)
        print(f"\n  [measured] plain-enrolled, glasses probe: best similarity to enrolled photos {before:.3f}")
        self.assertEqual(res.faces[0]["person_id"], pid)

    def test_enrolled_with_glasses_recognised_without(self):
        pid = self.engine.enroll("Tom", "friend", self.glasses)
        before = self.engine.person_scores(self.emb(self.plain[1]))[pid]  # before the tracker learns anything
        res = self.run_frames(self.plain[1], config.WEAK_MATCH_FRAMES)
        print(f"\n  [measured] glasses-enrolled, plain probe: best similarity to enrolled photos {before:.3f}")
        self.assertEqual(res.faces[0]["person_id"], pid)

    def test_strangers_are_never_named_tom_even_with_glasses(self):
        pid = self.engine.enroll("Tom", "friend", self.plain + self.glasses)
        for img in self.strangers:
            faces = self.engine.detect(img)
            for probe in (img, draw_glasses(img, faces[0].kps)):
                res = self.run_frames(probe, config.WEAK_MATCH_FRAMES)
                self.assertNotEqual(res.faces[0]["person_id"], pid)

    def test_re_enrolling_the_same_face_is_blocked(self):
        from faces.engine import DuplicateError

        self.engine.enroll("Tom", "friend", self.plain)
        with self.assertRaises(DuplicateError):
            self.engine.enroll("Thomas", None, self.glasses)


if __name__ == "__main__":
    unittest.main()
