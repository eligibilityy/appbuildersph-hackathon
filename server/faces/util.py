"""Small helpers shared by the face modules."""
import cv2

import config


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
