"""Follows faces across frames (IoU), confirms identity over CONFIRM_FRAMES, creates "Unknown #N"."""
from __future__ import annotations

import itertools
import time
from collections import deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

import config
import people
from faces import quality
from faces.util import iou, save_thumb

if TYPE_CHECKING:
    from faces.engine import FaceEngine


@dataclass
class FrameResult:
    faces: list[dict] = field(default_factory=list)          # payload for the "faces" event
    present_person_ids: set[int] = field(default_factory=set)  # confirmed people in view this frame
    new_people: list[int] = field(default_factory=list)        # Unknown #N created this frame


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


class Tracker:
    def __init__(self):
        self.tracks: list[Track] = []

    def clear(self):
        self.tracks.clear()

    def forget_missing(self, valid_ids):
        """Drop identities of people that were deleted/merged."""
        for t in self.tracks:
            if t.person_id is not None and t.person_id not in valid_ids:
                t.person_id = None
                t.history.clear()

    def _associate(self, dets):
        """Greedy IoU matching of detections to existing tracks. Returns {det_index: Track}."""
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
        return assignment

    def update(self, faces, img_bgr, engine: FaceEngine) -> FrameResult:
        """Call with engine.state_lock held."""
        result = FrameResult()
        dets = [[float(v) for v in f.bbox] for f in faces]
        assignment = self._associate(dets)
        now = time.time()

        for di, f in enumerate(faces):
            t = assignment[di]
            t.box, t.misses = dets[di], 0
            good = quality.is_good(f, img_bgr)
            emb = f.normed_embedding.astype(np.float32)
            pid, score = engine.match(emb)
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
                and good
                and full
                and all(x is None for x in t.history)
                and len(t.unknown_embs) == config.CONFIRM_FRAMES
                and min(w, h) >= config.UNKNOWN_MIN_FACE_PX
                and float(f.det_score) >= config.UNKNOWN_MIN_DET_SCORE
                and t.best_score_ever < config.UNKNOWN_MAX_BEST_SCORE
            ):
                label = people.next_unknown_label()
                new_pid = people.create_person(label, None, is_unknown=True, name_source=None)
                for e in t.unknown_embs:
                    engine.add_to_gallery(new_pid, e)
                save_thumb(img_bgr, dets[di], new_pid)
                engine.people[new_pid] = people.get_person(new_pid)
                t.person_id = new_pid
                t.history.clear()
                t.last_learned = now
                result.new_people.append(new_pid)
                print(f"[faces] new unknown person {new_pid} ({label})")

            # Occasionally learn new angles from confident matches.
            if (
                t.person_id is not None
                and good
                and cand == t.person_id
                and config.ADD_EMBEDDING_MIN_SCORE <= score <= config.ADD_EMBEDDING_MAX_SCORE
                and now - t.last_learned > config.ADD_EMBEDDING_EVERY_S
                and engine.embedding_count_in_memory(t.person_id) < config.MAX_EMBEDDINGS_PER_PERSON
            ):
                engine.add_to_gallery(t.person_id, emb)
                t.last_learned = now

            person = engine.people.get(t.person_id) if t.person_id is not None else None
            result.faces.append({
                "box": [round(v, 1) for v in dets[di]],
                "person_id": t.person_id,
                "name": person["name"] if person else None,
                "relationship": person["relationship"] if person else None,
                "is_unknown": bool(person["is_unknown"]) if person else None,
                "score": round(score, 3),
            })

        self.tracks = [t for t in self.tracks if t.misses <= config.TRACK_MAX_MISSES]
        result.present_person_ids = {t.person_id for t in self.tracks if t.person_id is not None and t.misses == 0}
        return result
