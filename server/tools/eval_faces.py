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

    embs, labels, names, times = [], [], [], []
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
            t = time.perf_counter()
            faces = app.get(img)
            times.append((time.perf_counter() - t) * 1000)
            if len(faces) != 1:
                print(f"  skip {person.name}/{img_path.name}: {len(faces)} faces")
                continue
            embs.append(faces[0].normed_embedding.astype(np.float32))
            labels.append(person.name)
            names.append(f"{person.name}/{img_path.name}")

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
    print("\nNote: single photos are a worst case - the live app also confirms over 5 frames.")


if __name__ == "__main__":
    main()
