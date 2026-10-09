"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Person, ServerEvent, serverUrl, useServerSocket } from "@/lib/server";

export default function CaregiverPage() {
  const [people, setPeople] = useState<Person[]>([]);
  const [version, setVersion] = useState(0); // cache-bust thumbnails
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${serverUrl()}/people`);
      setPeople(await res.json());
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
    await fetch(`${serverUrl()}/people/${p.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, relationship }),
    });
    load();
  }

  async function remove(p: Person) {
    if (!confirm(`Delete ${p.name ?? "this person"} and all their memories?`)) return;
    await fetch(`${serverUrl()}/people/${p.id}`, { method: "DELETE" });
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
          <PersonRow key={p.id} p={p} version={version} onSave={save} onDelete={remove} />
        ))}
      </ul>
    </main>
  );
}

function PersonRow({
  p,
  version,
  onSave,
  onDelete,
}: {
  p: Person;
  version: number;
  onSave: (p: Person, name: string, relationship: string) => void;
  onDelete: (p: Person) => void;
}) {
  const [name, setName] = useState(p.is_unknown ? "" : p.name ?? "");
  const [relationship, setRelationship] = useState(p.relationship ?? "");

  return (
    <li className={`flex gap-4 rounded-2xl border p-4 ${p.is_unknown ? "border-amber-400 bg-amber-50" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`${serverUrl()}/thumbs/${p.id}.jpg?v=${version}`}
        alt=""
        className="h-24 w-24 shrink-0 rounded-xl bg-neutral-200 object-cover"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-center gap-2">
          <span className="truncate text-lg font-semibold">{p.name ?? "Unnamed"}</span>
          {p.is_unknown ? <Badge className="bg-amber-200">needs a name</Badge> : null}
          {p.name_source === "auto" ? <Badge className="bg-blue-100">auto-named, please confirm</Badge> : null}
        </div>
        <div className="text-sm text-neutral-600">
          {p.visit_count ?? 0} visit(s){p.last_seen ? ` · last seen ${new Date(p.last_seen).toLocaleString()}` : ""}
        </div>
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name"
            className="w-full min-w-0 rounded border px-2 py-1"
          />
          <input
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="Relationship"
            className="w-full min-w-0 rounded border px-2 py-1"
          />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => onSave(p, name.trim(), relationship.trim())}
            disabled={!name.trim()}
            className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-40"
          >
            Save
          </button>
          <button onClick={() => onDelete(p)} className="rounded border border-red-300 px-3 py-1 text-red-700">
            Delete
          </button>
        </div>
      </div>
    </li>
  );
}

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs ${className}`}>{children}</span>;
}
