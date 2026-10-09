"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { api } from "@/lib/api";
import { initials } from "@/lib/format";
import { Person, ServerEvent } from "@/lib/server";
import { cn } from "@/lib/utils";

const MAX_LINES = 40; // keep the panel light during long visits
const ENDED_HOLD_MS = 10_000; // keep a finished visit's captions on screen briefly

type LiveVisit = { visitId: number; personId: number | null; lines: string[]; endedAt: number | null };

/** Tracks open visits and their transcript lines from server events. Feed it every ServerEvent. */
export function useLiveCaptions() {
  const [visits, setVisits] = useState<Map<number, LiveVisit>>(new Map());

  const update = useCallback((visitId: number, fn: (v: LiveVisit) => LiveVisit) => {
    setVisits((prev) => {
      const next = new Map(prev);
      next.set(visitId, fn(prev.get(visitId) ?? { visitId, personId: null, lines: [], endedAt: null }));
      return next;
    });
  }, []);

  // Opened mid-visit: show what has been said so far in visits that are still open.
  useEffect(() => {
    api
      .visits()
      .then((all) => {
        for (const v of all) {
          if (v.ended_at) continue;
          const lines = splitLines(v.transcript ?? "");
          update(v.id, (cur) => ({ ...cur, personId: v.person_id, lines: cur.lines.length ? cur.lines : lines }));
        }
      })
      .catch(() => {}); // server unreachable: live events will still fill it in
  }, [update]);

  const onEvent = useCallback(
    (e: ServerEvent) => {
      if (e.type === "visit_start") {
        update(e.visit_id, (v) => ({ ...v, personId: e.person_id, endedAt: null }));
      } else if (e.type === "transcript" && e.text?.trim()) {
        update(e.visit_id, (v) => ({ ...v, lines: [...v.lines, e.text.trim()].slice(-MAX_LINES) }));
      } else if (e.type === "visit_end") {
        update(e.visit_id, (v) => ({ ...v, personId: v.personId ?? e.person_id, endedAt: Date.now() }));
      }
    },
    [update],
  );

  // Drop finished visits after a short while.
  useEffect(() => {
    const id = setInterval(() => {
      setVisits((prev) => {
        const now = Date.now();
        const stale = [...prev.values()].filter((v) => v.endedAt && now - v.endedAt > ENDED_HOLD_MS);
        if (!stale.length) return prev;
        const next = new Map(prev);
        stale.forEach((v) => next.delete(v.visitId));
        return next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return { live: [...visits.values()], onEvent };
}

/** Live captions panel for the caregiver page: one card per open visit. Renders nothing when idle. */
export default function LiveCaptions({
  live,
  people,
  version,
}: {
  live: LiveVisit[];
  people: Person[] | null;
  version: number;
}) {
  if (live.length === 0) return null;
  const byId = new Map((people ?? []).map((p) => [p.id, p]));
  return (
    <section aria-label="Live conversation captions" className="mb-8 flex flex-col gap-3">
      {live.map((v) => (
        <CaptionCard
          key={v.visitId}
          visit={v}
          person={v.personId !== null ? byId.get(v.personId) : undefined}
          version={version}
        />
      ))}
    </section>
  );
}

function CaptionCard({ visit, person, version }: { visit: LiveVisit; person?: Person; version: number }) {
  const scroller = useRef<HTMLDivElement>(null);
  const ended = visit.endedAt !== null;
  const name = person?.name ?? (visit.personId !== null ? "Visitor" : "Someone");

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [visit.lines.length]);

  return (
    <div className={cn("rounded-2xl border bg-card p-4 transition-opacity duration-300", ended && "opacity-70")}>
      <div className="flex items-center gap-3">
        <Avatar className="size-10 shrink-0">
          {visit.personId !== null && (
            <AvatarImage src={api.thumbUrl(visit.personId, version)} alt="" className="object-cover" />
          )}
          <AvatarFallback className="bg-secondary text-footnote text-muted-foreground">
            {initials(person?.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-headline">{name}</div>
          <div className="text-footnote text-muted-foreground">
            {ended ? "Visit ended" : person?.relationship ? `Visiting now · ${person.relationship}` : "Visiting now"}
          </div>
        </div>
        {!ended && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-2.5 py-1 text-footnote font-semibold text-destructive">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-destructive opacity-60 motion-reduce:animate-none" />
              <span className="relative inline-flex size-2 rounded-full bg-destructive" />
            </span>
            Live
          </span>
        )}
      </div>

      <div
        ref={scroller}
        role="log"
        aria-live="polite"
        aria-label={`What ${name} is saying`}
        className="mt-3 max-h-40 overflow-y-auto rounded-xl bg-muted px-3 py-2"
      >
        {visit.lines.length === 0 ? (
          <p className="text-body text-muted-foreground">Listening… captions appear as they talk.</p>
        ) : (
          visit.lines.map((line, i) => (
            <p
              key={i}
              className={cn("text-body", i === visit.lines.length - 1 ? "text-foreground" : "text-muted-foreground")}
            >
              {line}
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function splitLines(text: string) {
  return text
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-MAX_LINES);
}
