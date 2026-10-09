"""Face model load, detect/embed, in-memory gallery + cosine matching, enroll / add photos / merge."""
import threading
import time
from collections import Counter

import numpy as np

import config
import db
import people
from faces import quality
from faces.tracker import FrameResult, Tracker
from faces.util import save_thumb


class EnrollError(ValueError):
    """Bad enrollment photos. `photos` lists [{"index": 0-based, "reason": str}] so the UI can mark them."""

    def __init__(self, message: str, photos: list[dict] | None = None):
        super().__init__(message)
        self.photos = photos or []


class DuplicateError(Exception):
    """The photos look like someone already saved (or the name is taken). Caller decides what to do."""

    def __init__(self, message: str, candidates: list[dict]):
        super().__init__(message)
        self.candidates = candidates


# --- embedding queries ---

def _blob(emb: np.ndarray) -> bytes:
    return np.asarray(emb, dtype=np.float32).tobytes()


def add_embedding(person_id: int, emb: np.ndarray):
    add_embeddings(person_id, [emb])


def add_embeddings(person_id: int, embs: list[np.ndarray]):
    """All or nothing: one transaction."""
    with db.connect() as c:
        c.executemany(
            "INSERT INTO face_embeddings (person_id, embedding, created_at) VALUES (?,?,?)",
            [(person_id, _blob(e), db.now()) for e in embs],
        )


def create_person_with_embeddings(name, relationship, is_unknown, name_source, embs, notes=None) -> int:
    """Person row + all their embeddings in ONE transaction, so a failure never leaves a face-less person."""
    created_at = db.now()
    with db.connect() as c:
        cur = c.execute(
            """INSERT INTO people (name, relationship, notes, is_unknown, name_source, created_at, registered_at)
               VALUES (?,?,?,?,?,?,?)""",
            (name, relationship, notes, int(is_unknown), name_source, created_at, created_at),
        )
        pid = cur.lastrowid
        c.executemany(
            "INSERT INTO face_embeddings (person_id, embedding, created_at) VALUES (?,?,?)",
            [(pid, _blob(e), db.now()) for e in embs],
        )
    return pid


def load_embeddings():
    """Returns (person_ids int array [N], embeddings float32 [N,512]), re-normalised to unit length."""
    with db.connect() as c:
        rows = c.execute(
            "SELECT e.person_id, e.embedding FROM face_embeddings e JOIN people p ON p.id = e.person_id"
        ).fetchall()
    rows = [r for r in rows if len(r["embedding"]) == 512 * 4]  # skip corrupt blobs instead of crashing
    if not rows:
        return np.zeros((0,), dtype=np.int64), np.zeros((0, 512), dtype=np.float32)
    ids = np.array([r["person_id"] for r in rows], dtype=np.int64)
    embs = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
    embs = embs / np.maximum(np.linalg.norm(embs, axis=1, keepdims=True), 1e-6)
    return ids, embs.astype(np.float32)


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


def normalize(emb) -> np.ndarray:
    emb = np.asarray(emb, dtype=np.float32)
    return emb / max(float(np.linalg.norm(emb)), 1e-6)


def per_person_max(sims: np.ndarray, gallery_ids: np.ndarray) -> dict[int, np.ndarray]:
    """sims [k, N] against a gallery -> {person_id: per-row max similarity [k]}."""
    return {int(pid): sims[:, gallery_ids == pid].max(axis=1) for pid in np.unique(gallery_ids)}


def top2_mean(scores: np.ndarray) -> float:
    """Average of the two best photos: one lucky photo isn't enough, but glasses-on shots don't drag it down."""
    s = np.sort(scores)[::-1]
    return float(s[:2].mean())


class FaceEngine:
    def __init__(self, app=None):
        """`app` lets tests inject a fake detector; normally the InsightFace model is loaded here."""
        if app is None:
            from insightface.app import FaceAnalysis

            t = time.perf_counter()
            app = FaceAnalysis(
                name=config.FACE_MODEL,
                providers=config.FACE_PROVIDERS,
                allowed_modules=["detection", "recognition"],
            )
            app.prepare(ctx_id=-1, det_size=config.FACE_DET_SIZE)
            print(f"[faces] loaded {config.FACE_MODEL} in {time.perf_counter() - t:.1f}s")
        self.app = app

        self.infer_lock = threading.Lock()   # FaceAnalysis isn't guaranteed thread-safe
        self.state_lock = threading.RLock()  # guards gallery, people cache, tracker
        self.enroll_lock = threading.Lock()  # duplicate check + insert happen as one step
        self.tracker = Tracker()
        self.people: dict[int, dict] = {}
        self.gallery_ids = np.zeros((0,), dtype=np.int64)
        self.gallery = np.zeros((0, 512), dtype=np.float32)
        self._uniq = np.zeros((0,), dtype=np.int64)
        self._inv = np.zeros((0,), dtype=np.int64)
        self.reload()

        self._timings = []
        self._last_timing_log = time.time()

    # --- gallery ---

    def reload(self):
        """Reload people + embeddings from SQLite (after enroll / edit / delete / merge)."""
        with self.state_lock:  # held while reading too, so a face learned mid-reload isn't lost
            ids, embs = load_embeddings()
            self.people = {p["id"]: p for p in people.list_people()}
            self.gallery_ids, self.gallery = ids, embs
            self._reindex()
            self.tracker.forget_missing(self.people.keys())

    def _reindex(self):
        self._uniq, self._inv = np.unique(self.gallery_ids, return_inverse=True)

    def _append_gallery(self, person_id: int, embs: list[np.ndarray]):
        """Call with state_lock held, after the embeddings were written to SQLite."""
        self.gallery_ids = np.concatenate([self.gallery_ids, np.full(len(embs), person_id, dtype=np.int64)])
        self.gallery = np.vstack([self.gallery, np.stack(embs).astype(np.float32)])
        self._reindex()

    def add_to_gallery(self, person_id: int, emb: np.ndarray):
        """Call with state_lock held."""
        add_embedding(person_id, emb)
        self._append_gallery(person_id, [emb])

    def create_unknown(self, embs: list[np.ndarray]) -> int:
        """Call with state_lock held. New "Unknown #N" with its faces, written atomically."""
        label = people.next_unknown_label()
        pid = create_person_with_embeddings(label, None, True, None, embs)
        self._append_gallery(pid, embs)
        self.people[pid] = people.get_person(pid)
        return pid

    def embedding_count_in_memory(self, person_id: int) -> int:
        return int(np.sum(self.gallery_ids == person_id))

    def person_scores(self, emb: np.ndarray) -> dict[int, float]:
        """{person_id: best cosine similarity over ALL of that person's embeddings}.
        Embeddings are L2-normalised, so dot product = cosine similarity."""
        if len(self.gallery_ids) == 0:
            return {}
        sims = self.gallery @ emb
        best = np.full(len(self._uniq), -1.0, dtype=np.float32)
        np.maximum.at(best, self._inv, sims)
        return dict(zip(self._uniq.tolist(), best.tolist()))

    def match(self, emb: np.ndarray):
        """Best person's max cosine similarity -> (person_id, score), or (None, 0.0) with an empty gallery."""
        scores = self.person_scores(emb)
        if not scores:
            return None, 0.0
        pid = max(scores, key=scores.get)
        return pid, scores[pid]

    # --- detection ---

    def detect(self, img_bgr):
        with self.infer_lock:
            return self.app.get(img_bgr)

    def embed_single(self, img_bgr, strict: bool = True):
        """Returns (embedding, box) or raises ValueError if not exactly one usable face."""
        faces = self.detect(img_bgr)
        if len(faces) == 0:
            raise ValueError("no face found - face the camera in good, even light")
        if len(faces) > 1:
            raise ValueError(f"found {len(faces)} faces - only the person being added should be in the photo")
        f = faces[0]
        reason = quality.check(f, img_bgr, strict=strict)
        if reason:
            raise ValueError(reason)
        return normalize(f.normed_embedding), [float(v) for v in f.bbox]

    def _embed_all(self, images_bgr):
        """Embed every photo; report EVERY bad photo at once (not just the first) so they can be retaken."""
        out, problems = [], []
        for i, img in enumerate(images_bgr):
            try:
                out.append(self.embed_single(img))
            except ValueError as e:
                problems.append({"index": i, "reason": str(e)})
        if not problems and len(out) >= 3:
            embs = np.stack([e for e, _ in out])
            for i in range(len(embs)):
                others = normalize(np.delete(embs, i, axis=0).mean(axis=0))
                if float(embs[i] @ others) < config.ENROLL_MIN_SELF_SIM:
                    problems.append({"index": i, "reason": "doesn't look like the same person as the other photos"})
        if problems:
            msg = "; ".join(f"Photo {p['index'] + 1}: {p['reason']}" for p in problems)
            print(f"[faces] enrollment photos rejected: {msg}")
            raise EnrollError(msg, problems)
        return out

    def check_frame(self, img_bgr) -> dict:
        """Live enrollment guidance: is there exactly one usable face? Does it look like someone saved?
        `pose` is a 2-D estimate from the 5 detected landmarks (not from the box), used to guide head turns:
          yaw    nose offset from the eye midpoint / eye distance. ~0 = facing the camera,
                 > 0 = turned to the person's OWN left, < 0 = to their own right (in the unmirrored frame).
          pitch  nose height between the eyes (0) and the mouth (1); ~0.5-0.7 when level."""
        faces = self.detect(img_bgr)
        h, w = img_bgr.shape[:2]
        res = {"faces": len(faces), "ok": False, "reason": None, "box": None, "match": None,
               "pose": None, "frame": [w, h]}
        if len(faces) == 0:
            res["reason"] = "No face found"
            return res
        if len(faces) > 1:
            res["reason"] = f"{len(faces)} faces - only one person please"
            return res
        f = faces[0]
        res["box"] = [round(float(v), 1) for v in f.bbox]
        m = quality.metrics(f, img_bgr)
        if "yaw" in m:
            res["pose"] = {"yaw": round(m["yaw"], 3), "pitch": round(m["pitch"], 3)}
        res["reason"] = quality.check(f, img_bgr, strict=True)
        res["ok"] = res["reason"] is None
        with self.state_lock:
            pid, score = self.match(normalize(f.normed_embedding))
            p = self.people.get(pid) if pid is not None else None
        if p and score >= config.DUPLICATE_THRESHOLD:
            res["match"] = {"id": pid, "name": p["name"], "is_unknown": bool(p["is_unknown"]),
                            "score": round(score, 3)}
        return res

    # --- duplicates ---

    def find_duplicates(self, embs: list[np.ndarray], name: str | None = None,
                        exclude_id: int | None = None) -> list[dict]:
        """Saved people these photos (or this name) probably belong to, most likely first."""
        with self.state_lock:
            gallery_ids, gallery, ppl = self.gallery_ids, self.gallery, dict(self.people)
        scores = {}
        if len(gallery_ids):
            sims = np.stack(embs) @ gallery.T
            scores = {pid: top2_mean(s) for pid, s in per_person_max(sims, gallery_ids).items()}
        key = (name or "").strip().casefold()
        out = []
        for pid, p in ppl.items():
            if pid == exclude_id:
                continue
            face = scores.get(pid, 0.0) >= config.DUPLICATE_THRESHOLD
            same_name = bool(key) and not p["is_unknown"] and (p["name"] or "").strip().casefold() == key
            if face or same_name:
                out.append({
                    "id": pid, "name": p["name"], "relationship": p["relationship"],
                    "is_unknown": bool(p["is_unknown"]), "score": round(scores.get(pid, 0.0), 3),
                    "reason": "face+name" if face and same_name else "face" if face else "name",
                })
        out.sort(key=lambda d: (d["reason"] != "name", d["score"]), reverse=True)
        return out

    # --- enrollment / corrections ---

    def enroll(self, name: str, relationship: str | None, images_bgr: list, force: bool = False,
               notes: str | None = None) -> int:
        """One request -> exactly one person with all of its photos' embeddings, or nothing at all."""
        embedded = self._embed_all(images_bgr)  # validate every image before writing anything
        embs = [e for e, _ in embedded]
        with self.enroll_lock:  # a double-clicked Save can't create the same person twice
            if not force:
                dups = self.find_duplicates(embs, name)
                if dups:
                    d = dups[0]
                    what = "looks like" if "face" in d["reason"] else "has the same name as"
                    print(f"[faces] enrollment of {name!r} blocked: {what} person {d['id']} "
                          f"(score {d['score']:.3f})")
                    raise DuplicateError(f"This person {what} {d['name']}, who is already saved.", dups)
            pid = create_person_with_embeddings(name, relationship, False, "enrolled", embs, notes)
            self.reload()
        save_thumb(images_bgr[0], embedded[0][1], pid)
        print(f"[faces] enrolled person {pid} with {len(embs)} photos" + (" (duplicate check overridden)" if force else ""))
        return pid

    def add_photos(self, person_id: int, images_bgr: list, force: bool = False) -> int:
        """Add more photos to an existing person (e.g. now wearing glasses)."""
        embedded = self._embed_all(images_bgr)
        embs = [e for e, _ in embedded]
        with self.enroll_lock:
            if not force:
                with self.state_lock:
                    mine = self.gallery[self.gallery_ids == person_id]
                    target = self.people.get(person_id) or {}
                own = top2_mean((np.stack(embs) @ mine.T).max(axis=1)) if len(mine) else None
                others = [d for d in self.find_duplicates(embs, exclude_id=person_id) if d["reason"] != "name"]
                if others and (own is None or others[0]["score"] > own):
                    raise DuplicateError(f"These photos look more like {others[0]['name']} than "
                                         f"{target.get('name') or 'this person'}.", others)
                if own is not None and own < config.ADD_PHOTOS_MIN_SIM:
                    raise DuplicateError(f"These photos don't look like {target.get('name') or 'this person'}.", [])
            add_embeddings(person_id, embs)
            self.reload()
        if not (config.THUMBS_DIR / f"{person_id}.jpg").exists():
            save_thumb(images_bgr[0], embedded[0][1], person_id)
        print(f"[faces] added {len(embs)} photos to person {person_id}")
        return len(embedded)

    def merge(self, source_id: int, into_id: int):
        """'Unknown #3 is actually Miguel': source's faces, visits and facts move to target."""
        with self.enroll_lock:
            move_person_data(source_id, into_id)
            self.reload()
        src_thumb = config.THUMBS_DIR / f"{source_id}.jpg"
        dst_thumb = config.THUMBS_DIR / f"{into_id}.jpg"
        if src_thumb.exists():
            if dst_thumb.exists():
                src_thumb.unlink()
            else:
                src_thumb.rename(dst_thumb)
        print(f"[faces] merged person {source_id} into {into_id}")

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
            rejects = self.tracker.rejects
            print(
                f"[faces] detect+embed over {len(arr)} frames: "
                f"mean {arr.mean():.0f} ms, p95 {np.percentile(arr, 95):.0f} ms, max {arr.max():.0f} ms "
                f"(last frame: {n_faces} face(s))"
                + (f"; low-quality faces skipped: {dict(rejects)}" if rejects else "")
            )
            self._timings.clear()
            self.tracker.rejects = Counter()
            self._last_timing_log = time.time()
