"""Face model load, detect/embed, in-memory gallery + cosine matching, enroll / add photos / merge."""
import threading
import time

import numpy as np

import config
import db
import people
from faces.tracker import FrameResult, Tracker
from faces.util import save_thumb


# --- embedding queries ---

def add_embedding(person_id: int, emb: np.ndarray):
    with db.connect() as c:
        c.execute(
            "INSERT INTO face_embeddings (person_id, embedding, created_at) VALUES (?,?,?)",
            (person_id, emb.astype(np.float32).tobytes(), db.now()),
        )


def load_embeddings():
    """Returns (person_ids int array [N], embeddings float32 [N,512])."""
    with db.connect() as c:
        rows = c.execute("SELECT person_id, embedding FROM face_embeddings").fetchall()
    if not rows:
        return np.zeros((0,), dtype=np.int64), np.zeros((0, 512), dtype=np.float32)
    ids = np.array([r["person_id"] for r in rows], dtype=np.int64)
    embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    return ids, embs


def count_embeddings(person_id: int) -> int:
    with db.connect() as c:
        return c.execute("SELECT COUNT(*) FROM face_embeddings WHERE person_id = ?", (person_id,)).fetchone()[0]


def move_person_data(source_id: int, into_id: int):
    """Merge all history into the target, consolidating person-hour appearance rows."""
    with db.connect() as c:
        for table in ("face_embeddings", "visits", "facts"):
            c.execute(f"UPDATE {table} SET person_id = ? WHERE person_id = ?", (into_id, source_id))
        source_appearances = c.execute(
            "SELECT * FROM appearances WHERE person_id = ?", (source_id,)
        ).fetchall()
        for row in source_appearances:
            c.execute(
                """INSERT INTO appearances
                   (person_id, hour_bucket, first_seen_at, last_seen_at, source)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(person_id, hour_bucket) DO UPDATE SET
                     first_seen_at = MIN(appearances.first_seen_at, excluded.first_seen_at),
                     last_seen_at = MAX(appearances.last_seen_at, excluded.last_seen_at),
                     source = CASE WHEN appearances.source = excluded.source
                                   THEN appearances.source ELSE 'mixed' END""",
                (into_id, row["hour_bucket"], row["first_seen_at"], row["last_seen_at"], row["source"]),
            )
        c.execute("DELETE FROM appearances WHERE person_id = ?", (source_id,))
        c.execute(
            """UPDATE people SET
                 first_seen_at = CASE
                   WHEN first_seen_at IS NULL THEN (SELECT first_seen_at FROM people WHERE id = ?)
                   WHEN (SELECT first_seen_at FROM people WHERE id = ?) IS NULL THEN first_seen_at
                   ELSE MIN(first_seen_at, (SELECT first_seen_at FROM people WHERE id = ?)) END,
                 last_seen_at = CASE
                   WHEN last_seen_at IS NULL THEN (SELECT last_seen_at FROM people WHERE id = ?)
                   WHEN (SELECT last_seen_at FROM people WHERE id = ?) IS NULL THEN last_seen_at
                   ELSE MAX(last_seen_at, (SELECT last_seen_at FROM people WHERE id = ?)) END
               WHERE id = ?""",
            (source_id, source_id, source_id, source_id, source_id, source_id, into_id),
        )
        c.execute("DELETE FROM people WHERE id = ?", (source_id,))


class FaceEngine:
    def __init__(self):
        from insightface.app import FaceAnalysis

        t = time.perf_counter()
        self.app = FaceAnalysis(
            name=config.FACE_MODEL,
            providers=config.FACE_PROVIDERS,
            allowed_modules=["detection", "recognition"],
        )
        self.app.prepare(ctx_id=-1, det_size=config.FACE_DET_SIZE)
        print(f"[faces] loaded {config.FACE_MODEL} in {time.perf_counter() - t:.1f}s")

        self.infer_lock = threading.Lock()   # FaceAnalysis isn't guaranteed thread-safe
        self.state_lock = threading.Lock()   # guards gallery, people cache, tracker
        self.tracker = Tracker()
        self.people: dict[int, dict] = {}
        self.gallery_ids = np.zeros((0,), dtype=np.int64)
        self.gallery = np.zeros((0, 512), dtype=np.float32)
        self.reload()

        self._timings = []
        self._last_timing_log = time.time()

    # --- gallery ---

    def reload(self):
        """Reload people + embeddings from SQLite (after enroll / edit / delete / merge)."""
        ids, embs = load_embeddings()
        ppl = {p["id"]: p for p in people.list_people()}
        with self.state_lock:
            self.gallery_ids, self.gallery = ids, embs
            self.people = ppl
            self.tracker.forget_missing(ppl.keys())

    def add_to_gallery(self, person_id: int, emb: np.ndarray):
        """Call with state_lock held."""
        add_embedding(person_id, emb)
        self.gallery_ids = np.append(self.gallery_ids, person_id)
        self.gallery = np.vstack([self.gallery, emb[None, :].astype(np.float32)])

    def embedding_count_in_memory(self, person_id: int) -> int:
        return int(np.sum(self.gallery_ids == person_id))

    def match(self, emb: np.ndarray):
        """Best person's max cosine similarity. Embeddings are L2-normalized, so dot = cosine."""
        if len(self.gallery_ids) == 0:
            return None, 0.0
        sims = self.gallery @ emb
        i = int(np.argmax(sims))
        return int(self.gallery_ids[i]), float(sims[i])

    # --- detection ---

    def detect(self, img_bgr):
        with self.infer_lock:
            return self.app.get(img_bgr)

    def embed_single(self, img_bgr):
        """Returns (embedding, box) or raises ValueError if not exactly one face."""
        faces = self.detect(img_bgr)
        if len(faces) != 1:
            raise ValueError(f"expected exactly 1 face, found {len(faces)}")
        f = faces[0]
        return f.normed_embedding.astype(np.float32), [float(v) for v in f.bbox]

    def _embed_all(self, images_bgr):
        out = []
        for i, img in enumerate(images_bgr):
            try:
                out.append(self.embed_single(img))
            except ValueError as e:
                raise ValueError(f"image {i + 1}: {e}")
        return out

    # --- enrollment / corrections ---

    def enroll(self, name: str, relationship: str | None, images_bgr: list) -> int:
        embedded = self._embed_all(images_bgr)  # validate every image before writing anything
        pid = people.create_person(name, relationship, is_unknown=False, name_source="enrolled")
        for emb, _ in embedded:
            add_embedding(pid, emb)
        save_thumb(images_bgr[0], embedded[0][1], pid)
        self.reload()
        return pid

    def add_photos(self, person_id: int, images_bgr: list) -> int:
        """Add more photos to an existing person (e.g. now wearing glasses)."""
        embedded = self._embed_all(images_bgr)
        for emb, _ in embedded:
            add_embedding(person_id, emb)
        if not (config.THUMBS_DIR / f"{person_id}.jpg").exists():
            save_thumb(images_bgr[0], embedded[0][1], person_id)
        self.reload()
        return len(embedded)

    def merge(self, source_id: int, into_id: int):
        """'Unknown #3 is actually Miguel': source's faces, visits and facts move to target."""
        move_person_data(source_id, into_id)
        src_thumb = config.THUMBS_DIR / f"{source_id}.jpg"
        dst_thumb = config.THUMBS_DIR / f"{into_id}.jpg"
        if src_thumb.exists():
            if dst_thumb.exists():
                src_thumb.unlink()
            else:
                src_thumb.rename(dst_thumb)
        self.reload()

    # --- per-frame pipeline ---

    def process(self, img_bgr) -> FrameResult:
        """Detect, embed, match, track."""
        t0 = time.perf_counter()
        faces = self.detect(img_bgr)
        self._log_timing((time.perf_counter() - t0) * 1000, len(faces))
        with self.state_lock:
            return self.tracker.update(faces, img_bgr, self)

    def _log_timing(self, ms: float, n_faces: int):
        self._timings.append(ms)
        if time.time() - self._last_timing_log >= 10 and self._timings:
            arr = np.array(self._timings)
            print(
                f"[faces] detect+embed over {len(arr)} frames: "
                f"mean {arr.mean():.0f} ms, p95 {np.percentile(arr, 95):.0f} ms, max {arr.max():.0f} ms "
                f"(last frame: {n_faces} face(s))"
            )
            self._timings.clear()
            self._last_timing_log = time.time()
