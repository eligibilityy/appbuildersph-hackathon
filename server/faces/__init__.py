"""Face recognition — the core feature. Owner: face recognition member.

engine.py   model load, detect/embed, gallery + matching, enroll / add photos / merge
tracker.py  follows faces across frames, confirms identity, creates "Unknown #N"
quality.py  decides whether a face crop is good enough to trust or learn from
routes.py   REST: /enroll, /people/{id}/photos, /people/{id}/merge
util.py     small helpers (IoU, thumbnails)
"""
