"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { UserPlus, Users } from "lucide-react";
import AppHeader from "@/components/app/AppHeader";
import PersonCard from "@/components/caregiver/PersonCard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import { Person, ServerEvent, useServerSocket } from "@/lib/server";

export default function CaregiverPage() {
  const [people, setPeople] = useState<Person[] | null>(null); // null = loading
  const [version, setVersion] = useState(0); // cache-bust thumbnails
  const [error, setError] = useState<string | null>(null);

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

  // Refresh whenever the server says something changed (new Unknown, enrollment, merge...).
  const onEvent = useCallback(
    (e: ServerEvent) => {
      if (e.type === "memory_updated") load();
    },
    [load],
  );
  useServerSocket(onEvent);

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
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
