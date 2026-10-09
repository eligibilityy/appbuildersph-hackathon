"""Measure how well faces match, using photos of the team, to pick MATCH_THRESHOLD from real numbers.

1. Put photos in server/data/eval/<person>/  (gitignored — real faces never go in the repo)
       server/data/eval/miguel/straight.jpg, glasses.jpg, dim_light.jpg, ...
       server/data/eval/ana/...
   One face per photo. Vary it: glasses on/off, hair up/down, angles, lighting.
2. cd server
   .venv/Scripts/python tools/eval_faces.py                 (macOS/Linux: .venv/bin/python ...)
   .venv/Scripts/python tools/eval_faces.py --model buffalo_l   (compare the bigger model; downloads once)

Prints same-person vs different-person similarity scores, error rates per threshold, and the
hardest same-person pairs (e.g. glasses vs no glasses) so you can see what breaks.

Glasses: put "glasses" in the file name of photos WITH glasses (e.g. glasses_straight.jpg; "noglasses" /
"no_glasses" counts as without). The script then also reports
  - photos where NO face was detected, per condition (glasses often lower the detector's confidence)
  - same-person scores for plain<->plain, glasses<->glasses and plain<->glasses
  - a gallery simulation like the live app: enroll each person from one condition, probe with the other,
    decide with MATCH_THRESHOLD + MATCH_MARGIN (best person vs 2nd-best) -> correct / unsure / WRONG person
"""
import argparse
import itertools
import sys
import time
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import config  # noqa: E402

EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def condition(filename: str) -> str:
    n = filename.lower().replace("-", "").replace("_", "").replace(" ", "")
    return "glasses" if "glasses" in n and "noglasses" not in n and "withoutglasses" not in n else "plain"


def simulate(E, labels, conds, enroll_cond, probe_cond):
    """Enroll every person from `enroll_cond` photos, probe with their `probe_cond` photos.
    Returns (correct, unsure, wrong, n) using the same rule as the live tracker (single frame)."""
    people = sorted(set(labels))
    gallery = {p: [i for i in range(len(labels)) if labels[i] == p and conds[i] == enroll_cond] for p in people}
    gallery = {p: idx for p, idx in gallery.items() if idx}
    correct = unsure = wrong = n = 0
    for i in range(len(labels)):
        if conds[i] != probe_cond or labels[i] not in gallery:
            continue
        scores = sorted(((max(float(E[i] @ E[j]) for j in idx if j != i), p)
                         for p, idx in gallery.items() if any(j != i for j in idx)), reverse=True)
        if not scores:
            continue
        n += 1
        best, who = scores[0]
        second = scores[1][0] if len(scores) > 1 else 0.0
        if best >= config.MATCH_THRESHOLD and best - second >= config.MATCH_MARGIN:
            correct += who == labels[i]
            wrong += who != labels[i]
        else:
            unsure += 1
    return correct, unsure, wrong, n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default=str(config.DATA_DIR / "eval"))
    ap.add_argument("--model", default=config.FACE_MODEL)
    args = ap.parse_args()

    root = Path(args.dir)
    people = sorted(p for p in root.iterdir() if p.is_dir()) if root.exists() else []
    if len(people) < 2:
        print(f"Need photos of at least 2 people in {root}/<person>/ - see the top of this file.")
        sys.exit(1)

    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name=args.model, providers=config.FACE_PROVIDERS, allowed_modules=["detection", "recognition"])
    app.prepare(ctx_id=-1, det_size=config.FACE_DET_SIZE)

    from faces import quality

    embs, labels, names, conds, times = [], [], [], [], []
    missed = {"plain": [0, 0], "glasses": [0, 0]}  # [no face detected, total]
    low_quality = []
    for person in people:
        for img_path in sorted(person.iterdir()):
            if img_path.suffix.lower() not in EXTS:
                continue
            img = cv2.imread(str(img_path))
            if img is None:
                print(f"  skip {img_path.name}: can't read")
                continue
            if img.shape[1] > 640:  # same size the live app uses
                img = cv2.resize(img, (640, int(img.shape[0] * 640 / img.shape[1])))
            cond = condition(img_path.name)
            missed[cond][1] += 1
            t = time.perf_counter()
            faces = app.get(img)
            times.append((time.perf_counter() - t) * 1000)
            if len(faces) == 0:
                missed[cond][0] += 1
            if len(faces) != 1:
                print(f"  skip {person.name}/{img_path.name}: {len(faces)} faces")
                continue
            reason = quality.check(faces[0], img)
            if reason:
                low_quality.append(f"{person.name}/{img_path.name}: {reason}")
            embs.append(faces[0].normed_embedding.astype(np.float32))
            labels.append(person.name)
            names.append(f"{person.name}/{img_path.name}")
            conds.append(cond)

    if len(embs) < 3:
        print("Not enough usable photos.")
        sys.exit(1)
    E = np.stack(embs)
    S = E @ E.T
    genuine, impostor = [], []
    for i, j in itertools.combinations(range(len(embs)), 2):
        (genuine if labels[i] == labels[j] else impostor).append((float(S[i, j]), i, j))

    g = np.array([s for s, _, _ in genuine])
    im = np.array([s for s, _, _ in impostor])
    print(f"\nModel {args.model}: {len(embs)} photos of {len(set(labels))} people, "
          f"detect+embed mean {np.mean(times):.0f} ms per photo (CPU)")
    if len(g):
        print(f"Same person      ({len(g):4d} pairs): min {g.min():.3f}  mean {g.mean():.3f}  max {g.max():.3f}")
    print(f"Different people ({len(im):4d} pairs): min {im.min():.3f}  mean {im.mean():.3f}  max {im.max():.3f}")

    print("\nthreshold | same person rejected | different people accepted")
    for t in np.arange(0.25, 0.651, 0.05):
        fr = (g < t).mean() * 100 if len(g) else 0
        fa = (im >= t).mean() * 100
        mark = "  <- current" if abs(t - config.MATCH_THRESHOLD) < 1e-6 else ""
        print(f"   {t:.2f}   |        {fr:5.1f}%        |          {fa:5.1f}%{mark}")

    print("\nHardest same-person pairs (what breaks recognition):")
    for s, i, j in sorted(genuine)[:8]:
        print(f"  {s:.3f}  {names[i]}  <->  {names[j]}")
    print("\nMost similar different-person pairs (risk of mix-ups):")
    for s, i, j in sorted(impostor, reverse=True)[:5]:
        print(f"  {s:.3f}  {names[i]}  <->  {names[j]}")

    if low_quality:
        print(f"\nPhotos the live quality gate would skip ({len(low_quality)}):")
        for line in low_quality[:10]:
            print(f"  {line}")

    if missed["glasses"][1]:
        print(f"\nGlasses (det_size {config.FACE_DET_SIZE[0]}):")
        for c in ("plain", "glasses"):
            print(f"  no face detected: {missed[c][0]}/{missed[c][1]} {c} photos")
        for a, b in (("plain", "plain"), ("glasses", "glasses"), ("plain", "glasses")):
            s = np.array([sc for sc, i, j in genuine if {conds[i], conds[j]} == {a, b}])
            if len(s):
                print(f"  same person, {a:7s} <-> {b:7s} ({len(s):3d} pairs): min {s.min():.3f}  mean {s.mean():.3f}")
        print(f"  gallery simulation (threshold {config.MATCH_THRESHOLD}, margin {config.MATCH_MARGIN}, single photo):")
        for enroll_c, probe_c in (("plain", "glasses"), ("glasses", "plain"), ("plain", "plain"), ("glasses", "glasses")):
            ok, unsure, wrong, n = simulate(E, labels, conds, enroll_c, probe_c)
            if n:
                print(f"    enrolled {enroll_c:7s} -> seen {probe_c:7s}: {ok}/{n} correct, {unsure} unsure, {wrong} WRONG person")
    print("\nNote: single photos are a worst case - the live app also averages and confirms over 5 frames.")


if __name__ == "__main__":
    main()
