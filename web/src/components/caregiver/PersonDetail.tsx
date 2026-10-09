"use client";

import { api, PersonDetail as PersonRecord } from "@/lib/api";

export default function PersonDetail({
  person,
  version,
  onBack,
}: {
  person: PersonRecord;
  version: number;
  onBack: () => void;
}) {
  return (
    <section aria-labelledby="person-detail-title" className="mx-auto max-w-4xl">
      <button
        type="button"
        onClick={onBack}
        className="mb-5 rounded-md border border-neutral-400 px-3 py-2 font-medium text-neutral-800 hover:bg-neutral-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
      >
        Back to people
      </button>
      <div className="flex flex-col gap-6 border-b border-neutral-300 pb-6 sm:flex-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={api.thumbUrl(person.id, version)}
          alt=""
          className="h-32 w-32 shrink-0 rounded-md bg-neutral-200 object-cover"
        />
        <div className="min-w-0">
          <h2 id="person-detail-title" className="text-2xl font-bold">
            {person.name ?? "Unnamed person"}
          </h2>
          <p className="mt-1 text-neutral-700">{person.relationship ?? "Relationship not recorded"}</p>
          <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <DetailValue label="Registered" value={formatDateTime(person.registered_at)} />
            <DetailValue label="First confirmed appearance" value={formatDateTime(person.first_seen_at)} />
            <DetailValue label="Most recent confirmed appearance" value={formatDateTime(person.last_seen_at)} />
            <DetailValue label="Notes" value={person.notes || "Not available"} />
          </dl>
        </div>
      </div>

      <section className="border-b border-neutral-300 py-6" aria-labelledby="hourly-status-title">
        <h3 id="hourly-status-title" className="text-lg font-semibold">Recent hourly monitoring</h3>
        <p className="mb-3 text-sm text-neutral-600">The latest 24 hours, with coverage gaps shown explicitly.</p>
        {person.hourly_status.length === 0 ? (
          <p className="text-sm text-neutral-600">No hourly monitoring information is available.</p>
        ) : (
          <ul className="grid gap-x-8 sm:grid-cols-2">
            {person.hourly_status.map((hour) => (
              <li key={hour.hour_bucket} className="flex items-baseline justify-between gap-3 border-t border-neutral-200 py-2 text-sm">
                <span>{formatHour(hour.hour_bucket)}</span>
                <span className={hour.status === "seen" ? "font-semibold text-green-800" : "text-neutral-700"}>
                  {statusLabel(hour.status, hour.in_progress)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="py-6" aria-labelledby="appearance-history-title">
        <h3 id="appearance-history-title" className="text-lg font-semibold">Appearance history</h3>
        {person.appearances.length === 0 ? (
          <p className="mt-3 text-neutral-600">No confirmed appearances recorded.</p>
        ) : (
          <ol className="mt-3 divide-y divide-neutral-200">
            {person.appearances.map((appearance) => (
              <li key={appearance.id} className="py-4">
                <h4 className="font-semibold">{formatHour(appearance.hour_bucket)}</h4>
                <p className="mt-1 text-sm text-neutral-700">Status: Seen</p>
                <p className="text-sm text-neutral-700">First detected: {formatTime(appearance.first_seen_at)}</p>
                <p className="text-sm text-neutral-700">Last detected: {formatTime(appearance.last_seen_at)}</p>
                {appearance.source !== "automatic" && (
                  <p className="text-sm text-neutral-600">Source: {appearance.source}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>

      {person.facts.length > 0 && (
        <section className="border-t border-neutral-300 py-6" aria-labelledby="person-facts-title">
          <h3 id="person-facts-title" className="text-lg font-semibold">Remembered facts</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-neutral-700">
            {person.facts.map((fact) => <li key={fact.id}>{fact.fact}</li>)}
          </ul>
        </section>
      )}
    </section>
  );
}

function DetailValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-semibold text-neutral-800">{label}</dt>
      <dd className="break-words text-neutral-700">{value}</dd>
    </div>
  );
}

function formatDateTime(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(date);
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(date);
}

function formatHour(value: string) {
  const start = new Date(value);
  if (Number.isNaN(start.getTime())) return "Hour not available";
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: "long" }).format(start);
  const times = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
  return `${date} - ${times.format(start)} to ${times.format(end)}`;
}

function statusLabel(status: string, inProgress: boolean) {
  if (inProgress) return status === "seen" ? "Seen (in progress)" : "Monitoring in progress";
  if (status === "seen") return "Seen";
  if (status === "not_seen") return "Not seen";
  return "Monitoring unavailable";
}
