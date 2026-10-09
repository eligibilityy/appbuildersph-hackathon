// What the name-tag profile card shows. Pure, so it's unit-tested: only data that actually exists in the
// person's saved profile is shown; nothing is made up.
import type { PersonDetail } from "./api";

export const NO_DESCRIPTION = "No description added yet.";

export type ProfileView = {
  name: string;
  relationship: string | null; // "Grandson"
  description: string | null; // the saved description (people.notes), or null
  descriptionText: string; // description, or the friendly empty message
  lastVisitAt: string | null; // start of the most recent FINISHED visit (ISO), format with timeAgo()
  facts: string[]; // up to 3 facts remembered from conversations
};

export function profileView(p: PersonDetail): ProfileView {
  const description = p.notes?.trim() || null;
  const rel = p.relationship?.trim() || null;
  const finished = (p.visits ?? []).filter((v) => v.ended_at).sort((a, b) => (a.started_at < b.started_at ? 1 : -1));
  return {
    name: p.name?.trim() || "Unnamed",
    relationship: rel ? rel.charAt(0).toUpperCase() + rel.slice(1) : null,
    description,
    descriptionText: description ?? NO_DESCRIPTION,
    lastVisitAt: finished.length ? finished[0].started_at : null,
    facts: (p.facts ?? []).map((f) => f.fact.trim()).filter(Boolean).slice(0, 3),
  };
}
