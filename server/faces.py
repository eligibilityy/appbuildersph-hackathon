"""InsightFace load, detect/embed, matching against the in-memory gallery, and simple IoU tracking."""
import itertools
import threading
import time
from collections import deque

import cv2
import numpy as np

import config
import db


def iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    if inter <= 0:
        return 0.0
    area_a = (a[2] - a[0]) * (a[3] - a[1])
    area_b = (b[2] - b[0]) * (b[3] - b[1])
    return inter / (area_a + area_b - inter)


def save_thumb(img_bgr, box, person_id: int):
    h, w = img_bgr.shape[:2]
    x1, y1, x2, y2 = box
    m = 0.35 * max(x2 - x1, y2 - y1)
    x1, y1 = int(max(0, x1 - m)), int(max(0, y1 - m))
    x2, y2 = int(min(w, x2 + m)), int(min(h, y2 + m))
    crop = img_bgr[y1:y2, x1:x2]
    if crop.size == 0:
        return
    s = 256 / max(crop.shape[:2])
    crop = cv2.resize(crop, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(config.THUMBS_DIR / f"{person_id}.jpg"), crop, [cv2.IMWRITE_JPEG_QUALITY, 85])


class Track:
    _ids = itertools.count(1)

    def __init__(self, box):
        self.id = next(self._ids)
        self.box = box
        self.misses = 0
        self.history = deque(maxlen=config.CONFIRM_FRAMES)  # candidate person_id (or None) per frame
        self.unknown_embs = deque(maxlen=config.CONFIRM_FRAMES)
        self.person_id = None        # confirmed identity
        self.best_score_ever = 0.0
        self.score = 0.0
        self.last_learned = 0.0


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
        self.state_lock = threading.Lock()
        self.tracks: list[Track] = []
        self.people: dict[int, dict] = {}
        self.gallery_ids = np.zeros((0,), dtype=np.int64)
        self.gallery = np.zeros((0, 512), dtype=np.float32)
        self.reload()

        self._timings = []
        self._last_timing_log = time.time()

    # --- gallery ---

    def reload(self):
        """Reload people + embeddings from SQLite (after enroll / edit / delete)."""
        ids, embs = db.load_embeddings()
        people = {p["id"]: p for p in db.list_people()}
        with self.state_lock:
            self.gallery_ids, self.gallery = ids, embs
            self.people = people
            for t in self.tracks:
                if t.person_id is not None and t.person_id not in people:
                    t.person_id = None
                    t.history.clear()

    def _add_to_gallery(self, person_id: int, emb: np.ndarray):
        db.add_embedding(person_id, emb)
        self.gallery_ids = np.append(self.gallery_ids, person_id)
        self.gallery = np.vstack([self.gallery, emb[None, :].astype(np.float32)])

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
        """For enrollment: returns (embedding, box) or raises ValueError if not exactly one face."""
        faces = self.detect(img_bgr)
        if len(faces) != 1:
            raise ValueError(f"expected exactly 1 face, found {len(faces)}")
        f = faces[0]
        return f.normed_embedding.astype(np.float32), [float(v) for v in f.bbox]

    def enroll(self, name: str, relationship: str, images_bgr: list):
        embs, first = [], None
        for i, img in enumerate(images_bgr):
            try:
                emb, box = self.embed_single(img)
            except ValueError as e:
                raise ValueError(f"image {i + 1}: {e}")
            embs.append(emb)
            if first is None:
                first = (img, box)
        pid = db.create_person(name, relationship, is_unknown=False, name_source="enrolled")
        for emb in embs:
            db.add_embedding(pid, emb)
        save_thumb(first[0], first[1], pid)
        self.reload()
        return pid

    # --- per-frame pipeline ---

    def process(self, img_bgr):
        """Detect, embed, match, track. Returns (faces_payload, present_person_ids, new_people)."""
        t0 = time.perf_counter()
        faces = self.detect(img_bgr)
        detect_ms = (time.perf_counter() - t0) * 1000
        self._log_timing(detect_ms, len(faces))

        new_people = []
        with self.state_lock:
            # Associate detections to tracks greedily by IoU.
            dets = [[float(v) for v in f.bbox] for f in faces]
            unmatched_tracks = set(range(len(self.tracks)))
            assignment = {}
            pairs = sorted(
                ((iou(t.box, d), ti, di) for ti, t in enumerate(self.tracks) for di, d in enumerate(dets)),
                reverse=True,
            )
            used_dets = set()
            for score, ti, di in pairs:
                if score < config.TRACK_IOU:
                    break
                if ti in unmatched_tracks and di not in used_dets:
                    assignment[di] = self.tracks[ti]
                    unmatched_tracks.discard(ti)
                    used_dets.add(di)
            for ti in unmatched_tracks:
                self.tracks[ti].misses += 1
            for di in range(len(dets)):
                if di not in assignment:
                    t = Track(dets[di])
                    self.tracks.append(t)
                    assignment[di] = t

            payload = []
            now = time.time()
            for di, f in enumerate(faces):
                t = assignment[di]
                t.box, t.misses = dets[di], 0
                emb = f.normed_embedding.astype(np.float32)
                pid, score = self.match(emb)
                is_match = pid is not None and score >= config.MATCH_THRESHOLD
                cand = pid if is_match else None
                t.score = score
                t.best_score_ever = max(t.best_score_ever, score)
                t.history.append(cand)

                full = len(t.history) == config.CONFIRM_FRAMES
                if cand is not None and full and all(h == cand for h in t.history):
                    t.person_id = cand  # confirm (or switch after a sustained disagreement)

                if cand is None:
                    t.unknown_embs.append(emb)
                else:
                    t.unknown_embs.clear()

                # Unmatched for CONFIRM_FRAMES -> save as a new Unknown person, if the face is good enough.
                w, h = dets[di][2] - dets[di][0], dets[di][3] - dets[di][1]
                if (
                    t.person_id is None
                    and full
                    and all(x is None for x in t.history)
                    and len(t.unknown_embs) == config.CONFIRM_FRAMES
                    and min(w, h) >= config.UNKNOWN_MIN_FACE_PX
                    and float(f.det_score) >= config.UNKNOWN_MIN_DET_SCORE
                    and t.best_score_ever < config.UNKNOWN_MAX_BEST_SCORE
                ):
                    label = db.next_unknown_label()
                    new_pid = db.create_person(label, None, is_unknown=True, name_source=None)
                    for e in t.unknown_embs:
                        self._add_to_gallery(new_pid, e)
                    save_thumb(img_bgr, dets[di], new_pid)
                    self.people[new_pid] = db.get_person(new_pid)
                    t.person_id = new_pid
                    t.history.clear()
                    t.last_learned = now
                    new_people.append(new_pid)
                    print(f"[faces] new unknown person {new_pid} ({label})")

                # Occasionally learn new angles from confident matches.
                if (
                    t.person_id is not None
                    and cand == t.person_id
                    and config.ADD_EMBEDDING_MIN_SCORE <= score <= config.ADD_EMBEDDING_MAX_SCORE
                    and now - t.last_learned > config.ADD_EMBEDDING_EVERY_S
                    and int(np.sum(self.gallery_ids == t.person_id)) < config.MAX_EMBEDDINGS_PER_PERSON
                ):
                    self._add_to_gallery(t.person_id, emb)
                    t.last_learned = now

                person = self.people.get(t.person_id) if t.person_id is not None else None
                payload.append({
                    "box": [round(v, 1) for v in dets[di]],
                    "person_id": t.person_id,
                    "name": person["name"] if person else None,
                    "relationship": person["relationship"] if person else None,
                    "is_unknown": bool(person["is_unknown"]) if person else None,
                    "score": round(score, 3),
                })

            self.tracks = [t for t in self.tracks if t.misses <= config.TRACK_MAX_MISSES]
            present = {t.person_id for t in self.tracks if t.person_id is not None and t.misses == 0}

        return payload, present, new_people

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
