// Typed calls to the local server's REST API. One place to change if an endpoint changes.
import { Person, serverUrl } from "@/lib/server";

export type Visit = {
  id: number;
  person_id: number;
  started_at: string;
  ended_at: string | null;
  transcript: string | null;
  summary: string | null;
  processed: number;
};

export type Fact = { id: number; person_id: number; visit_id: number; fact: string; created_at: string };

export type PersonDetail = Person & { visits: Visit[]; facts: Fact[]; embedding_count: number };

/** Someone already saved that new enrollment photos (or the name) probably belong to. */
export type DuplicateCandidate = {
  id: number;
  name: string | null;
  relationship: string | null;
  is_unknown: boolean;
  score: number;
  reason: "face" | "name" | "face+name";
};

/** Result of checking one camera frame for enrollment (nothing is saved). */
export type FrameCheck = {
  faces: number;
  ok: boolean;
  reason: string | null;
  box: [number, number, number, number] | null;
  match: { id: number; name: string | null; is_unknown: boolean; score: number } | null;
  /** Head pose from the 5 face landmarks. yaw > 0 = turned to the person's own left. */
  pose: { yaw: number; pitch: number } | null;
  /** Size of the checked image [width, height]; `box` is in these pixels. */
  frame: [number, number];
};

/** Error with the server's structured detail: `photos` (400: which photos to retake) or
 *  `candidates` (409: looks like someone already saved). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly photos: { index: number; reason: string }[] = [],
    readonly candidates: DuplicateCandidate[] = [],
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${serverUrl()}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = body.detail;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      throw new ApiError(d.message ?? res.statusText, res.status, d.photos ?? [], d.candidates ?? []);
    }
    throw new ApiError(typeof d === "string" ? d : res.statusText, res.status);
  }
  return body as T;
}

function json(method: string, data: unknown): RequestInit {
  return { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) };
}

function imagesForm(images: Blob[], fields: Record<string, string> = {}) {
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  images.forEach((img, i) => form.append("images", img, `photo${i + 1}.jpg`));
  return form;
}

export const api = {
  people: () => request<Person[]>("/people"),
  person: (id: number) => request<PersonDetail>(`/people/${id}`),
  updatePerson: (id: number, fields: Partial<Pick<Person, "name" | "relationship" | "notes">>) =>
    request<Person>(`/people/${id}`, json("PATCH", fields)),
  deletePerson: (id: number) => request<{ ok: boolean }>(`/people/${id}`, { method: "DELETE" }),

  /** New person: 3–8 photos, each with exactly one face. 409 (ApiError.candidates) if they look like
   *  someone already saved; `force` = the caregiver confirmed it's a different person. */
  enroll: (name: string, relationship: string, images: Blob[], force = false, notes = "") =>
    request<Person>("/enroll", {
      method: "POST",
      body: imagesForm(images, { name, relationship, notes, ...(force ? { force: "true" } : {}) }),
    }),
  /** More photos for someone already known (e.g. now wearing glasses): 1–8 photos. */
  addPhotos: (id: number, images: Blob[], force = false) =>
    request<{ ok: boolean; added: number }>(`/people/${id}/photos`, {
      method: "POST",
      body: imagesForm(images, force ? { force: "true" } : {}),
    }),
  /** Live enrollment guidance for one frame: face found? good enough? already saved? */
  checkFrame: (image: Blob) => {
    const form = new FormData();
    form.append("image", image, "frame.jpg");
    return request<FrameCheck>("/enroll/check", { method: "POST", body: form });
  },
  /** "Unknown #3 is actually Miguel": moves their faces, visits and facts into the target. */
  merge: (sourceId: number, intoId: number) =>
    request<Person>(`/people/${sourceId}/merge`, json("POST", { into_person_id: intoId })),

  visits: (personId?: number) => request<Visit[]>(personId ? `/visits?person_id=${personId}` : "/visits"),
  thumbUrl: (id: number, version = 0) => `${serverUrl()}/thumbs/${id}.jpg?v=${version}`,
};
