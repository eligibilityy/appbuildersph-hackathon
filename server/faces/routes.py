"""REST for faces: enroll a new person, add photos to someone, merge an Unknown into someone.

Errors the enrollment UI acts on:
  400 {"detail": {"message": str, "photos": [{"index": 0-based, "reason": str}]}}  retake these photos
  409 {"detail": {"message": str, "candidates": [{"id", "name", "relationship", "is_unknown", "score",
                                                   "reason": "face"|"name"|"face+name"}]}}
      looks like someone already saved: cancel, add the photos to that person, or resend with force=true
"""
import asyncio

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

import config
import hub
import people
from faces.engine import DuplicateError, EnrollError

router = APIRouter()


def decode_jpeg(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR) if data else None
    if img is None:
        raise ValueError("could not decode image")
    return img


async def _read_images(files: list[UploadFile]):
    imgs, problems = [], []
    for i, f in enumerate(files):
        try:
            imgs.append(decode_jpeg(await f.read()))
        except ValueError:
            problems.append({"index": i, "reason": "could not read this image"})
    if problems:
        raise HTTPException(400, {"message": "; ".join(f"Photo {p['index'] + 1}: {p['reason']}" for p in problems),
                                  "photos": problems})
    return imgs


def _count_ok(images: list[UploadFile], lo: int, hi: int):
    if not lo <= len(images) <= hi:
        raise HTTPException(400, f"send {lo} to {hi} images (got {len(images)})")


async def _run(fn, *args):
    try:
        return await asyncio.to_thread(fn, *args)
    except EnrollError as e:
        raise HTTPException(400, {"message": str(e), "photos": e.photos})
    except DuplicateError as e:
        raise HTTPException(409, {"message": str(e), "candidates": e.candidates})
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/enroll")
async def enroll(
    name: str = Form(...),
    relationship: str = Form(""),
    images: list[UploadFile] = File(...),
    force: bool = Form(False),  # caregiver confirmed "this is a different person" after a 409
):
    name = name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    _count_ok(images, config.ENROLL_MIN_IMAGES, config.ENROLL_MAX_IMAGES)
    imgs = await _read_images(images)
    pid = await _run(hub.engine.enroll, name, relationship.strip() or None, imgs, force)
    await hub.broadcast({"type": "memory_updated", "person_id": pid})
    return people.get_person(pid)


@router.post("/enroll/check")
async def enroll_check(image: UploadFile = File(...)):
    """One camera frame -> is it a usable enrollment photo? (Nothing is saved.)"""
    try:
        img = decode_jpeg(await image.read())
    except ValueError as e:
        raise HTTPException(400, str(e))
    return await asyncio.to_thread(hub.engine.check_frame, img)


@router.post("/people/{person_id}/photos")
async def add_photos(person_id: int, images: list[UploadFile] = File(...), force: bool = Form(False)):
    if not people.get_person(person_id):
        raise HTTPException(404, "not found")
    _count_ok(images, 1, config.ENROLL_MAX_IMAGES)
    imgs = await _read_images(images)
    added = await _run(hub.engine.add_photos, person_id, imgs, force)
    await hub.broadcast({"type": "memory_updated", "person_id": person_id})
    return {"ok": True, "added": added}


class MergeBody(BaseModel):
    into_person_id: int


@router.post("/people/{person_id}/merge")
async def merge(person_id: int, body: MergeBody):
    if person_id == body.into_person_id:
        raise HTTPException(400, "can't merge a person into themselves")
    if not people.get_person(person_id) or not people.get_person(body.into_person_id):
        raise HTTPException(404, "not found")
    await asyncio.to_thread(hub.engine.merge, person_id, body.into_person_id)
    await hub.broadcast({"type": "memory_updated", "person_id": body.into_person_id})
    return people.get_person(body.into_person_id)
