"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import PersonCard from "@/components/caregiver/PersonCard";
import PersonDetail from "@/components/caregiver/PersonDetail";
import { api, PersonDetail as PersonRecord } from "@/lib/api";
import { Person, ServerEvent, useServerSocket } from "@/lib/server";

export default function CaregiverPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [version, setVersion] = useState(0); // cache-bust thumbnails
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PersonRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0);

  const load = useCallback(async () => {
    try {
      setPeople(await api.people());
      setVersion((v) => v + 1);
      setError(null);
    } catch {
      setError("Can't reach the local server on port 8000.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadDetail = useCallback(async (personId: number) => {
    const requestId = ++detailRequest.current;
    setSelectedId(personId);
    setDetailLoading(true);
    setDetailError(null);
    try {
      const result = await api.person(personId);
      if (detailRequest.current === requestId) setDetail(result);
    } catch (e) {
      if (detailRequest.current === requestId) {
        setDetail(null);
        setDetailError(e instanceof Error ? e.message : "Person details are unavailable.");
      }
    } finally {
      if (detailRequest.current === requestId) setDetailLoading(false);
    }
  }, []);

  function closeDetail() {
    detailRequest.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }

  const onEvent = useCallback(
    (e: ServerEvent) => {
      if (e.type === "memory_updated") {
        load();
        if (selectedId === e.person_id) loadDetail(e.person_id);
      }
      if (e.type === "appearance_updated") {
        load();
        if (selectedId === e.person_id) loadDetail(e.person_id);
      }
    },
    [load, loadDetail, selectedId],
  );
  const { connected } = useServerSocket(onEvent);

  async function save(p: Person, name: string, relationship: string) {
    await api.updatePerson(p.id, { name, relationship });
    load();
  }

  async function remove(p: Person) {
    if (!confirm(`Delete ${p.name ?? "this person"} and all their memories?`)) return;
    await api.deletePerson(p.id);
    load();
  }

  return (
    <main className="mx-auto max-w-5xl p-6 text-neutral-900">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold">{selectedId === null ? "Caregiver" : "Person details"}</h1>
        <nav className="flex items-center gap-4 text-blue-700 underline">
          <span className={`h-3 w-3 rounded-full ${connected ? "bg-green-500" : "bg-red-600"}`} />
          <Link href="/">Patient view</Link>
          <Link href="/enroll">Add a person</Link>
        </nav>
      </div>
      {error && <p className="mb-4 text-red-700">{error}</p>}
      {selectedId !== null && (
        <div aria-live="polite">
          {detailLoading && <p className="mb-4 text-neutral-600">Loading person details...</p>}
          {detailError && (
            <div className="mb-4 text-red-700">
              <p>Unable to load this person: {detailError}</p>
              <button type="button" onClick={() => loadDetail(selectedId)} className="mt-2 underline">
                Retry
              </button>
            </div>
          )}
          {detail && <PersonDetail person={detail} version={version} onBack={closeDetail} />}
          {!detailLoading && !detailError && !detail && (
            <p className="mb-4 text-neutral-600">This person may have been deleted.</p>
          )}
        </div>
      )}
      {selectedId === null && people.length === 0 && !error && (
        <p className="text-neutral-600">No one yet. Add a person to get started.</p>
      )}

      <ul hidden={selectedId !== null} className="grid gap-4 sm:grid-cols-2">
        {people.map((p) => (
          <PersonCard
            key={p.id}
            p={p}
            version={version}
            onSave={save}
            onDelete={remove}
            onSelect={(person) => loadDetail(person.id)}
          />
        ))}
      </ul>
    </main>
  );
}
