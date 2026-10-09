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
        <p className="sr-only" role="status">
          {connected ? "Live updates connected" : "Live updates disconnected"}
        </p>

        {error && (
          <p role="alert" className="mb-6 rounded-xl bg-destructive/10 p-4 text-body text-destructive">
            {error}
          </p>
        )}

        {people === null && !error && <CardGridSkeleton />}

        {selectedId !== null ? (
          <section aria-live="polite">
            {detailLoading && <p className="text-body text-muted-foreground">Loading person details...</p>}
            {detailError && (
              <div role="alert" className="text-body text-destructive">
                <p>Unable to load this person: {detailError}</p>
                <Button variant="outline" className="mt-3" onClick={() => loadDetail(selectedId)}>
                  Try again
                </Button>
              </div>
            )}
            {detail && <PersonDetail person={detail} version={version} onBack={closeDetail} />}
            {!detailLoading && !detailError && !detail && (
              <p className="text-body text-muted-foreground">This person may have been deleted.</p>
            )}
          </section>
        ) : (
          <>
            {people !== null && unknown.length > 0 && (
              <Section
                title="Needs a name"
                description="Faces the app saw but doesn't know yet. Say who they are, or merge them into someone you added."
              >
                {unknown.map((p) => (
                  <PersonCard
                    key={p.id}
                    p={p}
                    version={version}
                    knownPeople={known}
                    onChanged={load}
                    onSelect={() => loadDetail(p.id)}
                  />
                ))}
              </Section>
            )}

            {people !== null && (
              <Section title="Family & friends">
                {known.length === 0 ? (
                  <EmptyState />
                ) : (
                  known.map((p) => (
                    <PersonCard
                      key={p.id}
                      p={p}
                      version={version}
                      knownPeople={known}
                      onChanged={load}
                      onSelect={() => loadDetail(p.id)}
                    />
                  ))
                )}
              </Section>
            )}
          </>
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

function CardGridSkeleton() {
  return (
    <div role="status" aria-label="Loading people" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }, (_, index) => (
        <div key={index} className="flex min-h-40 gap-4 rounded-xl border bg-card p-4">
          <Skeleton className="size-16 shrink-0 rounded-full" />
          <div className="flex flex-1 flex-col gap-3 pt-1">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="mt-auto h-9 w-full" />
          </div>
        </div>
      ))}
      <span className="sr-only">Loading people...</span>
    </div>
  );
}

function EmptyState() {
  return (
    <li className="col-span-full flex flex-col items-center gap-3 rounded-xl border border-dashed bg-card px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Users aria-hidden="true" className="size-6" />
      </span>
      <p className="text-body font-medium">No known people yet</p>
      <p className="max-w-sm text-footnote text-muted-foreground">
        Add a person to start building their recognition and appearance history.
      </p>
    </li>
  );
}
