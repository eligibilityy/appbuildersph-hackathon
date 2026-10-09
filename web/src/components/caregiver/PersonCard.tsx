"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { Person } from "@/lib/server";

type Props = {
  p: Person;
  version: number; // bump to refresh the thumbnail
  onSave: (p: Person, name: string, relationship: string) => void;
  onDelete: (p: Person) => void;
};

// TODO (block 1, frontend): on Unknown cards, add "This is…" <select> of known people -> api.merge();
// on known cards, add "Add photos" (camera capture, like /enroll) -> api.addPhotos().
export default function PersonCard({ p, version, onSave, onDelete }: Props) {
  const [name, setName] = useState(p.is_unknown ? "" : (p.name ?? ""));
  const [relationship, setRelationship] = useState(p.relationship ?? "");

  return (
    <li className={`flex gap-4 rounded-2xl border p-4 ${p.is_unknown ? "border-amber-400 bg-amber-50" : ""}`}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={api.thumbUrl(p.id, version)}
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
