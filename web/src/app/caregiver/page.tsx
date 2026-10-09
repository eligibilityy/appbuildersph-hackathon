"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import PersonCard from "@/components/caregiver/PersonCard";
import { api } from "@/lib/api";
import { Person, ServerEvent, useServerSocket } from "@/lib/server";

export default function CaregiverPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [version, setVersion] = useState(0); // cache-bust thumbnails
  const [error, setError] = useState<string | null>(null);

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

  const onEvent = useCallback(
    (e: ServerEvent) => {
      if (e.type === "memory_updated") load();
    },
    [load],
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
        <h1 className="text-3xl font-bold">Caregiver</h1>
        <nav className="flex items-center gap-4 text-blue-700 underline">
          <span className={`h-3 w-3 rounded-full ${connected ? "bg-green-500" : "bg-red-600"}`} />
          <Link href="/">Patient view</Link>
          <Link href="/enroll">Add a person</Link>
        </nav>
      </div>
      {error && <p className="mb-4 text-red-700">{error}</p>}
      {people.length === 0 && !error && <p className="text-neutral-600">No one yet. Add a person to get started.</p>}

      <ul className="grid gap-4 sm:grid-cols-2">
        {people.map((p) => (
          <PersonCard key={p.id} p={p} version={version} onSave={save} onDelete={remove} />
        ))}
      </ul>
    </main>
  );
}
