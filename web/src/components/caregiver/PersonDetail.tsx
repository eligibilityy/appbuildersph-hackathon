"use client";

import { CalendarClock, ChevronLeft, Eye, EyeOff, Sparkles } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, HourlyStatus, PersonDetail as PersonRecord } from "@/lib/api";
import { initials, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

/** One person's details: registration, confirmed appearances, last-24-hours monitoring, facts. */
export default function PersonDetail({
  person,
  version,
  onBack,
}: {
  person: PersonRecord;
  version: number;
  onBack: () => void;
}) {
  // Server sends the latest hour first; the strip reads left (oldest) to right (now).
  const hours = [...person.hourly_status].reverse();
  const seenHours = person.hourly_status.filter((h) => h.status === "seen").length;

  return (
    <section aria-labelledby="person-detail-title" className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <Button variant="ghost" onClick={onBack} className="-ml-2 text-primary">
          <ChevronLeft className="size-5" /> People
        </Button>
      </div>

      {/* Header */}
      <div className="flex flex-col gap-5 rounded-2xl border bg-card p-5 sm:flex-row sm:items-center">
        <Avatar className="size-20 shrink-0">
          <AvatarImage src={api.thumbUrl(person.id, version)} alt="" className="object-cover" />
          <AvatarFallback className="bg-secondary text-title text-muted-foreground">
            {initials(person.name)}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id="person-detail-title" className="text-large-title">
              {person.name ?? "Unnamed person"}
            </h2>
            {person.is_unknown ? (
              <Badge className="rounded-full bg-warning/15 font-medium text-[#b25f00]">Needs a name</Badge>
            ) : null}
            {person.name_source === "auto" && (
              <Badge className="rounded-full bg-primary/10 font-medium text-primary">Auto-named</Badge>
            )}
          </div>
          <p className="mt-0.5 text-body text-muted-foreground">{person.relationship ?? "Relationship not recorded"}</p>
        </div>
      </div>

      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat icon={CalendarClock} label="Registered" value={formatDateTime(person.registered_at)} />
        <Stat icon={Eye} label="First confirmed appearance" value={formatDateTime(person.first_seen_at)} />
        <Stat
          icon={Eye}
          label="Most recent confirmed appearance"
          value={formatDateTime(person.last_seen_at)}
          hint={timeAgo(person.last_seen_at) ?? undefined}
        />
      </dl>
      {person.notes && (
        <p className="rounded-2xl border bg-card p-4 text-body">
          <span className="text-footnote font-medium text-muted-foreground">Notes</span>
          <br />
          {person.notes}
        </p>
      )}

      {/* Last 24 hours */}
      <section aria-labelledby="hourly-status-title" className="rounded-2xl border bg-card p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="hourly-status-title" className="text-title">
            Last 24 hours
          </h3>
          <span className="text-footnote text-muted-foreground">
            Seen in {seenHours} of {person.hourly_status.length} hours
          </span>
        </div>
        <p className="mt-1 text-body text-muted-foreground">
          Hours when the camera was off are shown as gaps, not as &quot;not seen&quot;.
        </p>

        {hours.length === 0 ? (
          <p className="mt-4 text-body text-muted-foreground">No hourly monitoring information is available.</p>
        ) : (
          <>
            <ol
              className="mt-4 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-1"
              aria-label="Hourly status, oldest first"
            >
              {hours.map((h) => (
                <li
                  key={h.hour_bucket}
                  title={`${formatHour(h.hour_bucket)}: ${statusLabel(h.status, h.in_progress)}`}
                  aria-label={`${formatHour(h.hour_bucket)}: ${statusLabel(h.status, h.in_progress)}`}
                  className={cn(
                    "h-10 rounded-md",
                    CELL[h.status],
                    h.in_progress && "ring-2 ring-primary ring-offset-1",
                  )}
                />
              ))}
            </ol>
            <div className="mt-1.5 flex justify-between text-footnote text-tertiary-foreground">
              <span>{formatClock(hours[0].hour_bucket)}</span>
              <span>now</span>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-footnote text-muted-foreground">
              <Legend className={CELL.seen} label="Seen" />
              <Legend className={CELL.not_seen} label="Not seen" />
              <Legend className={CELL.monitoring_unavailable} label="Camera off / not monitored" />
            </div>

            <details className="group mt-4">
              <summary className="cursor-pointer text-body font-medium text-primary select-none">Hour by hour</summary>
              <ul className="mt-2 grid gap-x-8 sm:grid-cols-2">
                {person.hourly_status.map((h) => (
                  <li key={h.hour_bucket} className="flex items-baseline justify-between gap-3 border-t py-2 text-body">
                    <span className="text-muted-foreground">{formatHour(h.hour_bucket)}</span>
                    <span className={h.status === "seen" ? "font-semibold text-success" : "text-foreground"}>
                      {statusLabel(h.status, h.in_progress)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
      </section>

      {/* Appearance history */}
      <section aria-labelledby="appearance-history-title" className="rounded-2xl border bg-card p-5">
        <h3 id="appearance-history-title" className="text-title">
          Appearance history
        </h3>
        {person.appearances.length === 0 ? (
          <p className="mt-3 flex items-center gap-2 text-body text-muted-foreground">
            <EyeOff className="size-4" /> No confirmed appearances recorded.
          </p>
        ) : (
          <ol className="mt-2 divide-y">
            {person.appearances.map((a) => (
              <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
                <span className="text-headline">{formatHour(a.hour_bucket)}</span>
                <span className="text-body text-muted-foreground">
                  First detected {formatTime(a.first_seen_at)} · last {formatTime(a.last_seen_at)}
                  {a.source !== "automatic" && (
                    <Badge variant="secondary" className="ml-2 rounded-full">
                      {a.source}
                    </Badge>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      {person.facts.length > 0 && (
        <section aria-labelledby="person-facts-title" className="rounded-2xl border bg-card p-5">
          <h3 id="person-facts-title" className="flex items-center gap-2 text-title">
            <Sparkles className="size-5 text-primary" /> Remembered facts
          </h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-body">
            {person.facts.map((fact) => (
              <li key={fact.id}>{fact.fact}</li>
            ))}
          </ul>
        </section>
      )}
    </section>
  );
}

const CELL: Record<HourlyStatus["status"], string> = {
  seen: "bg-success",
  not_seen: "bg-secondary",
  monitoring_unavailable: "border border-dashed border-input bg-transparent",
};

function Stat({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border bg-card p-4">
      <dt className="flex items-center gap-1.5 text-footnote font-medium text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </dt>
      <dd className="mt-1 text-headline break-words">{value}</dd>
      {hint && <dd className="text-footnote text-tertiary-foreground">{hint}</dd>}
    </div>
  );
}

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("size-3 rounded-sm", className)} />
      {label}
    </span>
  );
}

function formatDateTime(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

function formatClock(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat(undefined, { hour: "numeric" }).format(date);
}

function formatHour(value: string) {
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) return "Hour not available";
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const date = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(start);
  const times = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  return `${date}, ${times.format(start)} – ${times.format(end)}`;
}

function statusLabel(status: string, inProgress: boolean) {
  if (inProgress) return status === "seen" ? "Seen (in progress)" : "Monitoring in progress";
  if (status === "seen") return "Seen";
  if (status === "not_seen") return "Not seen";
  return "Monitoring unavailable";
}
