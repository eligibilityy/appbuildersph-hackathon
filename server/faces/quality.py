"""Face quality gate: is this face crop good enough to trust or learn from?

check() returns None for a usable face, or a short human-readable reason. Two strictness levels:
  live (default)  lenient - a bad frame doesn't vote for an identity, become an Unknown or get learned,
                  but its face is still tracked. Lenient on purpose: glasses lower the detector score
                  and add edges/glare, and a strict gate would silently stop glasses frames from voting.
  strict=True     enrollment photos - these become the person's reference faces, so they must be good.

Thresholds live in config.py. Metrics (calibrated on InsightFace's sample photos, see config.py):
  size        shorter side of the face box, in pixels
  brightness  mean grey level of the face crop (over-exposure hurts ArcFace much more than darkness)
  sharpness   variance of the Laplacian on a contrast-normalised 112 px crop (so dark != blurry)
  yaw/pitch   from the 5 landmarks: nose offset from the eye midpoint, relative to eye distance
"""
import cv2
import numpy as np

import config


def metrics(face, img_bgr) -> dict:
    h, w = img_bgr.shape[:2]
    x1, y1, x2, y2 = (int(round(float(v))) for v in face.bbox)
    out = {"size": float(min(x2 - x1, y2 - y1)), "det_score": float(face.det_score)}
    crop = img_bgr[max(0, y1):min(h, y2), max(0, x1):min(w, x2)]
    if crop.size == 0:
        out.update(brightness=0.0, sharpness=0.0)
    else:
        g = cv2.resize(cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY), (112, 112)).astype(np.float32)
        out["brightness"] = float(g.mean())
        g = (g - g.mean()) / (g.std() + 1e-6) * 50.0
        out["sharpness"] = float(cv2.Laplacian(g, cv2.CV_32F).var())

    kps = getattr(face, "kps", None)
    if kps is not None and len(kps) == 5:
        k = np.asarray(kps, dtype=np.float32)
        eye_mid = (k[0] + k[1]) / 2
        eye_dist = float(np.linalg.norm(k[1] - k[0])) + 1e-6
        mouth_mid = (k[3] + k[4]) / 2
        out["yaw"] = float((k[2][0] - eye_mid[0]) / eye_dist)
        out["pitch"] = float((k[2][1] - eye_mid[1]) / (mouth_mid[1] - eye_mid[1] + 1e-6))
    return out


def check(face, img_bgr, strict: bool = False) -> str | None:
    """None if the face is usable, else a short reason like 'too blurry'."""
    q = config.QUALITY_ENROLL if strict else config.QUALITY_LIVE
    m = metrics(face, img_bgr)
    if m["size"] < q["min_face_px"]:
        return "face too small - move closer to the camera"
    if m["brightness"] < q["min_brightness"]:
        return "too dark - add light in front of the face"
    if m["brightness"] > q["max_brightness"]:
        return "too bright - avoid strong light or a window behind the camera"
    if m["sharpness"] < q["min_sharpness"]:
        return "too blurry - hold still"
    if "yaw" in m and abs(m["yaw"]) > q["max_yaw"]:
        return "head turned too far - face the camera more"
    if "pitch" in m and not q["pitch_range"][0] <= m["pitch"] <= q["pitch_range"][1]:
        return "head tilted too far up or down"
    return None


def is_good(face, img_bgr) -> bool:
    return check(face, img_bgr) is None
