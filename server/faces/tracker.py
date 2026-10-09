"""Follows faces across frames (IoU), confirms identity over CONFIRM_FRAMES, creates "Unknown #N".

How a track gets a name:
  - Every good-quality frame scores the face against every saved person (max over ALL of that person's
    embeddings). Scores are averaged per person over the last TRACK_SCORE_WINDOW good frames.
  - Strong vote: averaged best >= MATCH_THRESHOLD and ahead of the 2nd-best person by MATCH_MARGIN.
    CONFIRM_FRAMES strong votes in a row for the same person confirm it (or switch an existing identity).
  - Sustained weak evidence (glasses, hats): a track with NO identity yet whose averaged best stays
    >= WEAK_MATCH_THRESHOLD with a big margin for WEAK_MATCH_FRAMES good frames is confirmed too.
    It can't switch an existing identity and is never learned from.
  - Low-quality frames (quality.check) are drawn but don't vote, aren't learned and can't create Unknowns.
  - Once confirmed, a track keeps its identity while it's followed, even through bad or doubtful frames.
"""
from __future__ import annotations

import itertools
import time
from collections import Counter, deque
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np

import config
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
        self.scores = deque(maxlen=config.TRACK_SCORE_WINDOW)  # {person_id: similarity} per good frame
        self.history = deque(maxlen=config.CONFIRM_FRAMES)     # strong candidate person_id (or None) per good frame
        self.unknown_embs = deque(maxlen=config.CONFIRM_FRAMES)
        self.weak_pid = None
        self.weak_streak = 0
        self.person_id = None        # confirmed identity
        self.strong = False          # confirmed by strong votes (only then do we learn new angles)
        self.best_score_ever = 0.0
        self.score = 0.0
        self.last_learned = 0.0

    def averaged(self):
        """(best person_id, its averaged score, margin over the 2nd-best person) over the score window."""
        totals, counts = {}, {}
        for frame in self.scores:
            for pid, s in frame.items():
                totals[pid] = totals.get(pid, 0.0) + s
                counts[pid] = counts.get(pid, 0) + 1
        if not totals:
            return None, 0.0, 0.0
        ranked = sorted(((totals[p] / counts[p], p) for p in totals), reverse=True)
        best, pid = ranked[0]
        second = ranked[1][0] if len(ranked) > 1 else 0.0
        return pid, best, best - second

    def reset_votes(self):
        self.history.clear()
        self.weak_pid, self.weak_streak = None, 0


class Tracker:
    def __init__(self):
        self.tracks: list[Track] = []
        self.rejects = Counter()  # low-quality reasons since the last timing log (diagnostics)

    def clear(self):
        self.tracks.clear()

    def forget_missing(self, valid_ids):
        """Drop identities AND stale scores of people that were deleted/merged, so no track can
        keep voting for a person who no longer exists."""
        valid = set(valid_ids)
        for t in self.tracks:
            for frame in t.scores:
                for pid in [p for p in frame if p not in valid]:
                    del frame[pid]
            if any(h is not None and h not in valid for h in t.history) or (
                t.weak_pid is not None and t.weak_pid not in valid
            ):
                t.reset_votes()
            if t.person_id is not None and t.person_id not in valid:
                t.person_id, t.strong = None, False
                t.reset_votes()

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

    def _name(self, engine: FaceEngine, pid):
        p = engine.people.get(pid)
        return f"{p['name']} (id {pid})" if p else f"id {pid}"

    def update(self, faces, img_bgr, engine: FaceEngine) -> FrameResult:
        """Call with engine.state_lock held."""
        result = FrameResult()
        dets = [[float(v) for v in f.bbox] for f in faces]
        assignment = self._associate(dets)
        now = time.time()

        for di, f in enumerate(faces):
            t = assignment[di]
            t.box, t.misses = dets[di], 0
            reason = quality.check(f, img_bgr)
            good = reason is None
            if not good:
                self.rejects[reason.split(" - ")[0]] += 1

            emb = np.asarray(f.normed_embedding, dtype=np.float32)
            emb = emb / max(float(np.linalg.norm(emb)), 1e-6)
            frame_scores = engine.person_scores(emb)
            frame_best = max(frame_scores.values(), default=0.0)
            # Even a bad frame that came close to someone blocks this track from becoming a new Unknown.
            t.best_score_ever = max(t.best_score_ever, frame_best)

            if good:
                t.scores.append(frame_scores)
                pid, avg, margin = t.averaged()
                strong = pid is not None and avg >= config.MATCH_THRESHOLD and margin >= config.MATCH_MARGIN
                cand = pid if strong else None
                t.history.append(cand)

                weak = pid is not None and avg >= config.WEAK_MATCH_THRESHOLD and margin >= config.WEAK_MATCH_MARGIN
                if weak and pid == t.weak_pid:
                    t.weak_streak += 1
                elif weak:
                    t.weak_pid, t.weak_streak = pid, 1
                else:
                    t.weak_pid, t.weak_streak = None, 0

                full = len(t.history) == config.CONFIRM_FRAMES
                if cand is not None and full and all(h == cand for h in t.history):
                    if t.person_id != cand:
                        what = "confirmed" if t.person_id is None else f"switched from {self._name(engine, t.person_id)} to"
                        print(f"[faces] track {t.id} {what} {self._name(engine, cand)}: "
                              f"avg {avg:.3f}, margin {margin:.3f}")
                    t.person_id, t.strong = cand, True
                elif t.person_id is None and t.weak_streak >= config.WEAK_MATCH_FRAMES:
                    t.person_id, t.strong = t.weak_pid, False
                    print(f"[faces] track {t.id} confirmed {self._name(engine, t.person_id)} on sustained "
                          f"weak evidence: avg {avg:.3f}, margin {margin:.3f} over {t.weak_streak} frames")

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
                    and self._consistent(t.unknown_embs)
                ):
                    new_pid = engine.create_unknown(list(t.unknown_embs))
                    save_thumb(img_bgr, dets[di], new_pid)
                    t.person_id, t.strong = new_pid, True
                    t.reset_votes()
                    t.last_learned = now
                    result.new_people.append(new_pid)
                    print(f"[faces] track {t.id}: new unknown {self._name(engine, new_pid)} "
                          f"(closest saved person was {t.best_score_ever:.3f})")

                # Occasionally learn new angles, only from strong, confident matches of a strongly confirmed track.
                own = frame_scores.get(t.person_id, 0.0) if t.person_id is not None else 0.0
                if (
                    t.person_id is not None
                    and t.strong
                    and cand == t.person_id
                    and config.ADD_EMBEDDING_MIN_SCORE <= own <= config.ADD_EMBEDDING_MAX_SCORE
                    and now - t.last_learned > config.ADD_EMBEDDING_EVERY_S
                    and engine.embedding_count_in_memory(t.person_id) < config.MAX_EMBEDDINGS_PER_PERSON
                ):
                    engine.add_to_gallery(t.person_id, emb)
                    t.last_learned = now

            # Score shown to clients: the averaged score for the track's identity (or its best guess).
            pid, avg, _ = t.averaged()
            if t.person_id is not None:
                n = [fr[t.person_id] for fr in t.scores if t.person_id in fr]
                t.score = sum(n) / len(n) if n else frame_scores.get(t.person_id, 0.0)
            else:
                t.score = avg if pid is not None else frame_best

            person = engine.people.get(t.person_id) if t.person_id is not None else None
            result.faces.append({
                "box": [round(v, 1) for v in dets[di]],
                "person_id": t.person_id if person else None,
                "name": person["name"] if person else None,
                "relationship": person["relationship"] if person else None,
                "is_unknown": bool(person["is_unknown"]) if person else None,
                "score": round(float(t.score), 3),
            })

        self.tracks = [t for t in self.tracks if t.misses <= config.TRACK_MAX_MISSES]
        result.present_person_ids = {t.person_id for t in self.tracks if t.person_id is not None and t.misses == 0}
        return result

    @staticmethod
    def _consistent(embs) -> bool:
        """The frames about to become a new Unknown should all be the same face (the IoU tracker can
        drift between two people standing close together)."""
        e = np.stack(list(embs))
        mean = e.mean(axis=0)
        mean /= max(float(np.linalg.norm(mean)), 1e-6)
        return bool((e @ mean).min() >= config.UNKNOWN_MIN_SELF_SIM)
