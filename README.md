Test

## Face recognition: changes and how to verify them

Everything below runs locally on the CPU (InsightFace `buffalo_s`, ONNX Runtime `CPUExecutionProvider`). No new models, dependencies, network calls or telemetry were added.

### What changed

**Glasses and accessories**
- **The detector input is now 480 px instead of 320 px** (`FACE_DET_SIZE` in `server/config.py`). Glasses lower the face detector's confidence, so at 320 px, faces with glasses at a normal distance were often not detected at all. They never even reached the matching step. That was the main reason "enrolled without glasses, then seen with glasses" failed while the opposite direction worked: enrollment photos are close-ups, which are still detected with glasses.
- **Track-averaged matching.** Each face is scored against every saved person, using the best match over all of that person's photos. Scores are then averaged over the last 5 good frames.
- **Margin check.** The best person must beat the second-best person by `MATCH_MARGIN` (0.08), otherwise the face stays unnamed. A face that resembles two people is never given either name.
- **Sustained-evidence rule.** A face scoring just under the threshold (≥ 0.38) can still be named if it stays far ahead of everyone else for about 3 seconds (15 good frames). This rule can't override a name already shown, and the app never learns new face data from it.
- **The global threshold was not lowered.** `MATCH_THRESHOLD` stays at 0.45.

**Enrollment**
- A real **quality gate** (`server/faces/quality.py`) rejects photos that are too small, too dark, over-exposed, blurry, or taken with the head turned too far. Each rejected photo gets a reason, and the enroll page marks it in red so it can be retaken.
- The enroll page shows a live hint ("✓ Face found - ready", "Too dark…", "Already saved as Miguel") using `POST /enroll/check`, which saves nothing.
- An optional **"Sometimes wears glasses"** tick box adds 2 photos with the other look (glasses on ↔ off).
- Photos with 0 faces or more than 1 face are rejected. So is a photo that doesn't look like the same person as the other photos.
- Up to 8 photos per enrollment (was 5).

**Duplicate people**
- **Enrollment checks for duplicates before saving.** If the photos look like someone already saved, or the name is already taken, the server returns **409** with the likely match. The caregiver then chooses one of:
  - add the photos to that person (if it was an `Unknown #N`, naming it keeps their earlier visits);
  - save as a different person;
  - cancel.
- **Saving is all-or-nothing.** A person and all of their face data are saved in one database transaction, so a failure never leaves a person without face data. A lock stops a double-clicked "Save" from creating two people.
- **Fewer duplicate Unknowns.** Only good-quality frames can create an `Unknown #N`, and those frames must all look like the same face. Unknown labels no longer repeat after a delete or merge.
- "Add photos to X" refuses photos that look more like someone else.

**Tracking and robustness**
- Blurry or badly angled frames are tracked but don't vote, aren't learned from, and can't create Unknowns.
- When a person is deleted or merged, any live face tracks immediately stop voting for them.
- A malformed WebSocket message is ignored instead of closing the connection.
- The console logs confirmations, identity switches and a summary of skipped low-quality frames. Names and scores only, never images or face data.

**Patient view: name tags instead of boxes**
- The rectangle around each face is gone. Each confirmed, known person gets a floating name tag: their name on a dark rounded pill with a white outline, above the head (or under the chin when there's no room above), never covering the face.
- Unknown faces, and faces not yet confidently identified, get no tag.
- Tags glide smoothly, survive brief detection gaps (0.8 s), then fade out. They stay aligned when the window is resized or the video is cropped or mirrored.
- The WebSocket `faces` event format is unchanged; the face box coordinates are still sent and are used to position the tags.

### Tests

```powershell
cd server
.\.venv\Scripts\python tools\smoke_test.py               # end-to-end server test (19 checks)
.\.venv\Scripts\python -m unittest discover -s tests     # 35 face tests (30 logic + 5 real model)
cd ..\web
npm test                                                 # 9 name-tag tests
```

All of these pass. The 30 logic tests use synthetic face data, so they prove the matching and tracking rules work, not real-world accuracy. The 5 real-model tests draw synthetic glasses onto InsightFace's bundled sample photos.

### Measured results (synthetic glasses only)

Measured on the development laptop with the real `buffalo_s` model, using glasses **drawn onto** InsightFace's sample photos. These are not measurements of real glasses or of our team's faces.

| What | Result |
|---|---|
| Synthetic-glasses faces detected, `det_size` 320 → 480 | 15/21 → 21/21 |
| Detect + embed time per frame, 1 face, 320 → 480 | ~11 ms → ~14 ms (dev laptop, not the GTX 1650 target) |
| Similarity, same photo with vs without glasses | 0.68–0.70 (identical in both directions) |
| Highest similarity between two *different* people | 0.28 (both wearing glasses) |
| Enrolled without glasses → seen with glasses, and the reverse (single photo, threshold + margin) | 21/21 correct each way, 0 wrong person |

### Still to verify with real faces

- Real glasses (glare, frame shadows, very dark lenses). One sample face with drawn-on dark sunglasses wasn't detected at all.
- Tune `MATCH_MARGIN` and the sustained-evidence values (`WEAK_MATCH_*`) on consented photos of the team. Put them in `server/data/eval/<person>/` (gitignored), name the ones with glasses `glasses_*.jpg`, then run `.\.venv\Scripts\python tools\eval_faces.py`.
- Re-time detection on the demo laptop. If it's too slow, set `FACE_DET_SIZE` back to `(320, 320)`.
