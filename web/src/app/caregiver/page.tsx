"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useMemo, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import AppHeader from "@/components/app/AppHeader";
import PersonCard from "@/components/caregiver/PersonCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import PersonDetail from "@/components/caregiver/PersonDetail";
import { api, PersonDetail as PersonRecord } from "@/lib/api";
import { Person, ServerEvent, useServerSocket } from "@/lib/server";

export default function CaregiverPage() {
  const [people, setPeople] = useState<Person[] | null>(null); // null = loading
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
      setError("Can't reach the local server. Make sure it's running (see README → Running it).");
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

  const unknown = useMemo(() => (people ?? []).filter((p) => p.is_unknown), [people]);
  const known = useMemo(() => (people ?? []).filter((p) => !p.is_unknown), [people]);

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-large-title">People</h1>
            <p className="mt-1 text-body text-muted-foreground">
              {people === null
                ? "Loading…"
                : `${known.length} known${unknown.length ? ` · ${unknown.length} waiting for a name` : ""}`}
            </p>
          </div>
          <Button asChild size="lg">
            <Link href="/enroll">
              <UserPlus /> Add person
            </Link>
          </Button>
        </div>

        {error && (
          <p role="alert" className="mb-6 rounded-xl bg-destructive/10 p-4 text-body text-destructive">
            {error}
          </p>
        )}

        {people === null && !error && <CardGridSkeleton />}

        {people !== null && unknown.length > 0 && (
          <Section
            title="Needs a name"
            description="Faces the app saw but doesn't know yet. Say who they are, or merge them into someone you added."
          >
            {unknown.map((p) => (
              <PersonCard key={p.id} p={p} version={version} knownPeople={known} onChanged={load} />
            ))}
          </Section>
        )}

        {people !== null && (
          <Section title="Family & friends">
            {known.length === 0 ? (
              <EmptyState />
            ) : (
              known.map((p) => <PersonCard key={p.id} p={p} version={version} knownPeople={known} onChanged={load} />)
            )}
          </Section>
        )}
      </main>
    </>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-title">{title}</h2>
      {description && <p className="mt-1 max-w-2xl text-body text-muted-foreground">{description}</p>}
      <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{children}</ul>
    </section>
  );
}

function EmptyState() {
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
