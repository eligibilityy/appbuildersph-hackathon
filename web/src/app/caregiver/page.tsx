"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import AppHeader from "@/components/app/AppHeader";
import AskPanel from "@/components/caregiver/AskPanel";
import PersonCard from "@/components/caregiver/PersonCard";
import LiveCaptions, { useLiveCaptions } from "@/components/caregiver/LiveCaptions";
import PersonDetail from "@/components/caregiver/PersonDetail";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, PersonDetail as PersonRecord } from "@/lib/api";
import { Person, ServerEvent, useServerSocket } from "@/lib/server";

export default function CaregiverPage() {
  const [people, setPeople] = useState<Person[] | null>(null); // null = loading
  const [version, setVersion] = useState(0); // cache-bust thumbnails
  const [error, setError] = useState<string | null>(null);

  // Detail view (one person: registration, appearance history, last 24 hours).
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<PersonRecord | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const detailRequest = useRef(0); // ignore responses from older requests

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

  function openDetail(p: Person) {
    setDetail(null);
    loadDetail(p.id);
    window.scrollTo({ top: 0 });
  }

  function closeDetail() {
    detailRequest.current += 1;
    setSelectedId(null);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(false);
  }

  // Live captions of open visits (visit_start / transcript / visit_end events).
  const { live, onEvent: onCaptionEvent } = useLiveCaptions();

  // Refresh whenever the server says something changed (new Unknown, enrollment, merge, new appearance).
  const onEvent = useCallback(
    (e: ServerEvent) => {
      onCaptionEvent(e);
      if (e.type === "memory_updated" || e.type === "appearance_updated") {
        load();
        if (selectedId === e.person_id) loadDetail(e.person_id);
      }
      // A visit ended (summary/facts may follow): refresh the open person's timeline.
      if (e.type === "visit_end" && selectedId === e.person_id) loadDetail(e.person_id);
    },
    [load, loadDetail, onCaptionEvent, selectedId],
  );
  const { connected } = useServerSocket(onEvent);

  const unknown = useMemo(() => (people ?? []).filter((p) => p.is_unknown), [people]);
  const known = useMemo(() => (people ?? []).filter((p) => !p.is_unknown), [people]);

  if (selectedId !== null) {
    return (
      <>
        <AppHeader />
        <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
          <div className="mx-auto max-w-4xl">
            <LiveCaptions live={live} people={people} version={version} />
          </div>
          <div aria-live="polite">
            {detail ? (
              <PersonDetail
                person={detail}
                version={version}
                onBack={closeDetail}
                onChanged={() => {
                  loadDetail(detail.id);
                  load();
                }}
              />
            ) : detailLoading ? (
              <DetailSkeleton />
            ) : (
              <div className="mx-auto flex max-w-4xl flex-col items-start gap-3">
                <p role="alert" className="w-full rounded-xl bg-destructive/10 p-4 text-body text-destructive">
                  {detailError ? `Unable to load this person: ${detailError}` : "This person may have been deleted."}
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" onClick={closeDetail}>
                    Back to people
                  </Button>
                  {detailError && <Button onClick={() => loadDetail(selectedId)}>Retry</Button>}
                </div>
              </div>
            )}
          </div>
        </main>
      </>
    );
  }

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
        {/* Announced to screen readers only (from fixui, ryuuu924). */}
        <p className="sr-only" role="status">
          {connected ? "Live updates connected" : "Live updates disconnected"}
        </p>

        {people !== null && <AskPanel people={known} version={version} onOpenPerson={openDetail} />}

        <LiveCaptions live={live} people={people} version={version} />

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
              <PersonCard
                key={p.id}
                p={p}
                version={version}
                knownPeople={known}
                onChanged={load}
                onSelect={openDetail}
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
                  onSelect={openDetail}
                />
              ))
            )}
          </Section>
        )}
      </main>
    </>
  );
}

function DetailSkeleton() {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Skeleton className="h-9 w-28" />
      <div className="flex items-center gap-5 rounded-2xl border bg-card p-5">
        <Skeleton className="size-20 rounded-full" />
        <div className="flex flex-1 flex-col gap-2">
          <Skeleton className="h-8 w-1/2" />
          <Skeleton className="h-4 w-1/4" />
        </div>
      </div>
      <Skeleton className="h-40 rounded-2xl" />
    </div>
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
    <li className="col-span-full flex flex-col items-center gap-3 rounded-2xl border border-dashed bg-card px-6 py-12 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-secondary">
        <Users className="size-6 text-muted-foreground" />
      </span>
      <div>
        <p className="text-headline">No one added yet</p>
        <p className="mt-1 text-body text-muted-foreground">Add the people who visit, so the app can introduce them.</p>
      </div>
      <Button asChild>
        <Link href="/enroll">
          <UserPlus /> Add the first person
        </Link>
      </Button>
    </li>
  );
}

function CardGridSkeleton() {
  return (
    <div role="status" aria-label="Loading people" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <span className="sr-only">Loading people…</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-3.5 rounded-2xl border bg-card p-4">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
