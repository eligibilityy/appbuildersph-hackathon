"""REST for faces: enroll a new person, add photos to someone, merge an Unknown into someone."""
import asyncio

import cv2
import numpy as np
from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

import hub
import people

router = APIRouter()


def decode_jpeg(data: bytes):
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode image")
    return img


async def _read_images(files: list[UploadFile]):
    try:
        return [decode_jpeg(await f.read()) for f in files]
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/enroll")
async def enroll(
    name: str = Form(...),
    relationship: str = Form(""),
    images: list[UploadFile] = File(...),
):
    name = name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    if not 3 <= len(images) <= 5:
        raise HTTPException(400, f"send 3 to 5 images (got {len(images)})")
    imgs = await _read_images(images)
    try:
        pid = await asyncio.to_thread(hub.engine.enroll, name, relationship.strip() or None, imgs)
    except ValueError as e:
        raise HTTPException(400, str(e))
    await hub.broadcast({"type": "memory_updated", "person_id": pid})
    return people.get_person(pid)


@router.post("/people/{person_id}/photos")
async def add_photos(person_id: int, images: list[UploadFile] = File(...)):
    if not people.get_person(person_id):
        raise HTTPException(404, "not found")
    if not 1 <= len(images) <= 5:
        raise HTTPException(400, f"send 1 to 5 images (got {len(images)})")
    imgs = await _read_images(images)
    try:
        added = await asyncio.to_thread(hub.engine.add_photos, person_id, imgs)
    except ValueError as e:
        raise HTTPException(400, str(e))
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
