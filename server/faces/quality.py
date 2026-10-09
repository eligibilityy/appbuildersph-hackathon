"""Face quality gate: is this face crop good enough to trust or learn from?

STUB — always says yes for now. Block 1 task for the face recognition member:
  - blur:  cv2.Laplacian(gray_crop, cv2.CV_64F).var() below a threshold -> too blurry
  - pose:  use face.kps (5 points: eyes, nose, mouth corners); if the nose is far off
           the midpoint between the eyes, the head is turned too far sideways
  - size:  box smaller than ~60 px -> too small
Put the thresholds in config.py. Bad faces still get a box drawn; they just don't vote
for an identity, become an Unknown, or get learned.
"""


def is_good(face, img_bgr) -> bool:
    return True
