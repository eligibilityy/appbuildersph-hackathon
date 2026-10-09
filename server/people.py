"""People: queries + REST routes (/people, /thumbs). Owner: lead."""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

import config
import db
import hub

router = APIRouter()


# --- queries ---

def create_person(name, relationship=None, is_unknown=False, name_source=None) -> int:
    created_at = db.now()
    with db.connect() as c:
        cur = c.execute(
            """INSERT INTO people
               (name, relationship, is_unknown, name_source, created_at, registered_at)
               VALUES (?,?,?,?,?,?)""",
            (name, relationship, int(is_unknown), name_source, created_at, created_at),
        )
        return cur.lastrowid


def next_unknown_label() -> str:
    # MAX, not COUNT: after an Unknown is merged/deleted, COUNT would hand out a label that's still in use.
    with db.connect() as c:
        n = c.execute(
            "SELECT COALESCE(MAX(CAST(SUBSTR(name, 10) AS INTEGER)), 0) FROM people WHERE name LIKE 'Unknown #%'"
        ).fetchone()[0]
    return f"Unknown #{n + 1}"


def get_person(person_id: int):
    with db.connect() as c:
        row = c.execute("SELECT * FROM people WHERE id = ?", (person_id,)).fetchone()
    return dict(row) if row else None


def list_people():
    with db.connect() as c:
        rows = c.execute(
            """SELECT p.*,
                      (SELECT MAX(started_at) FROM visits v WHERE v.person_id = p.id) AS last_seen,
                      (SELECT COUNT(*) FROM visits v WHERE v.person_id = p.id) AS visit_count
               FROM people p ORDER BY p.is_unknown, p.name"""
        ).fetchall()
    return [dict(r) for r in rows]


def update_person(person_id: int, fields: dict):
    allowed = {"name", "relationship", "notes", "is_unknown", "name_source"}
    fields = {k: v for k, v in fields.items() if k in allowed}
    if not fields:
        return
    sets = ", ".join(f"{k} = ?" for k in fields)
    with db.connect() as c:
        c.execute(f"UPDATE people SET {sets} WHERE id = ?", (*fields.values(), person_id))


def delete_person(person_id: int):
    with db.connect() as c:
        c.execute("DELETE FROM people WHERE id = ?", (person_id,))
    (config.THUMBS_DIR / f"{person_id}.jpg").unlink(missing_ok=True)


# --- routes ---

@router.get("/people")
def people():
    return list_people()


@router.get("/people/{person_id}")
def person(person_id: int):
    import memory
    import visits
    from faces.engine import count_embeddings

    p = get_person(person_id)
    if not p:
        raise HTTPException(404, "not found")
    p["visits"] = visits.list_visits(person_id)
    p["facts"] = memory.list_facts(person_id)
    p["appearances"], p["hourly_status"] = visits.appearance_history(person_id)
    p["embedding_count"] = count_embeddings(person_id)
    return p


@router.patch("/people/{person_id}")
async def patch_person(person_id: int, body: dict):
    if not get_person(person_id):
        raise HTTPException(404, "not found")
    fields = {k: body[k] for k in ("name", "relationship", "notes") if k in body}
    if fields.get("name"):
        # A caregiver typing/confirming a name makes this a known, trusted person.
        fields["is_unknown"] = 0
        fields["name_source"] = "enrolled"
    update_person(person_id, fields)
    hub.engine.reload()
    await hub.broadcast({"type": "memory_updated", "person_id": person_id})
    return get_person(person_id)


@router.delete("/people/{person_id}")
async def remove_person(person_id: int):
    delete_person(person_id)
    hub.engine.reload()
    await hub.broadcast({"type": "memory_updated", "person_id": person_id})
    return {"ok": True}


@router.get("/thumbs/{person_id}.jpg")
def thumb(person_id: int):
    path = config.THUMBS_DIR / f"{person_id}.jpg"
    if not path.exists():
        raise HTTPException(404, "no thumbnail")
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})
