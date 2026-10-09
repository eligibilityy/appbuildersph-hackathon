"use client";

import { MessageSquareText, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Fact, Visit } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Visits newest first: date, start time, duration, summary, that visit's facts, expandable transcript. */
export default function VisitTimeline({ visits, facts }: { visits: Visit[]; facts: Fact[] }) {
  const ordered = [...visits].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  const visitIds = new Set(ordered.map((v) => v.id));
  const factsByVisit = new Map<number, Fact[]>();
  for (const f of facts) {
    if (!visitIds.has(f.visit_id)) continue;
    factsByVisit.set(f.visit_id, [...(factsByVisit.get(f.visit_id) ?? []), f]);
  }
  const otherFacts = facts.filter((f) => !visitIds.has(f.visit_id));

  return (
    <>
      <section aria-labelledby="visits-title" className="rounded-2xl border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="visits-title" className="text-title">
            Visits
          </h3>
          {ordered.length > 0 && (
            <span className="text-footnote text-muted-foreground">
              {ordered.length} visit{ordered.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {ordered.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-body text-muted-foreground">
            <MessageSquareText className="size-4" /> No visits yet. A visit starts when the camera recognizes this
            person.
          </p>
        ) : (
          <ol className="mt-4 flex flex-col">
            {ordered.map((v, i) => (
              <VisitItem key={v.id} visit={v} facts={factsByVisit.get(v.id) ?? []} last={i === ordered.length - 1} />
            ))}
          </ol>
        )}
      </section>

      {otherFacts.length > 0 && (
        <section aria-labelledby="other-facts-title" className="rounded-2xl border bg-card p-5">
          <h3 id="other-facts-title" className="flex items-center gap-2 text-title">
            <Sparkles className="size-5 text-primary" /> Other things remembered
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-body">
            {otherFacts.map((fact) => (
              <li key={fact.id}>{fact.fact}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function VisitItem({ visit, facts, last }: { visit: Visit; facts: Fact[]; last: boolean }) {
  const live = !visit.ended_at;
  const transcript = visit.transcript?.trim() ?? "";
  const words = transcript ? transcript.split(/\s+/).length : 0;

  return (
    <li className="relative flex gap-4 pb-6 last:pb-0">
      {/* Timeline rail */}
      <div className="flex flex-col items-center pt-1.5" aria-hidden>
        <span
          className={cn("size-2.5 shrink-0 rounded-full", live ? "bg-success ring-4 ring-success/20" : "bg-primary")}
        />
        {!last && <span className="mt-1.5 w-px flex-1 bg-border" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-headline">{formatDay(visit.started_at)}</span>
          <span className="text-body text-muted-foreground">
            {formatTime(visit.started_at)} · {live ? "now" : formatDuration(visit.started_at, visit.ended_at!)}
          </span>
          {live && <Badge className="rounded-full bg-success/15 font-medium text-[#1f7a35]">In progress</Badge>}
        </div>

        <p className={cn("mt-1.5 text-body", !visit.summary && "text-muted-foreground")}>
          {visit.summary ?? summaryPlaceholder(visit, words)}
        </p>

        {facts.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1">
            {facts.map((f) => (
              <li key={f.id} className="flex items-start gap-2 text-body">
                <Sparkles className="mt-1 size-3.5 shrink-0 text-primary" />
                {f.fact}
              </li>
            ))}
          </ul>
        )}

        {transcript && (
          <details className="group mt-2">
            <summary className="cursor-pointer text-footnote font-medium text-primary select-none">
              Transcript · {words} word{words === 1 ? "" : "s"}
            </summary>
            <p className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-muted p-3 text-body whitespace-pre-wrap text-foreground">
              {transcript}
            </p>
          </details>
        )}
      </div>
    </li>
  );
}

function summaryPlaceholder(v: Visit, words: number) {
  if (!v.ended_at) return "Visit in progress. A summary appears after they leave.";
  if (!v.processed) return words ? "Summarizing the conversation…" : "No conversation was recorded.";
  return "Nothing to remember from this visit.";
}

function formatDay(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(d);
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(d);
}

function formatDuration(startIso: string, endIso: string) {
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const min = Math.round(ms / 60_000);
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
