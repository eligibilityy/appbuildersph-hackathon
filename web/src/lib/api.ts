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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${serverUrl()}${path}`, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.detail ?? res.statusText);
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

  /** New person: 3–5 photos, each with exactly one face. */
  enroll: (name: string, relationship: string, images: Blob[]) =>
    request<Person>("/enroll", { method: "POST", body: imagesForm(images, { name, relationship }) }),
  /** More photos for someone already known (e.g. now wearing glasses): 1–5 photos. */
  addPhotos: (id: number, images: Blob[]) =>
    request<{ ok: boolean; added: number }>(`/people/${id}/photos`, { method: "POST", body: imagesForm(images) }),
  /** "Unknown #3 is actually Miguel": moves their faces, visits and facts into the target. */
  merge: (sourceId: number, intoId: number) =>
    request<Person>(`/people/${sourceId}/merge`, json("POST", { into_person_id: intoId })),

  visits: (personId?: number) => request<Visit[]>(personId ? `/visits?person_id=${personId}` : "/visits"),
  thumbUrl: (id: number, version = 0) => `${serverUrl()}/thumbs/${id}.jpg?v=${version}`,
};
