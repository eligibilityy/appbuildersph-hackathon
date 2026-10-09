"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { dataUrlToBlob, grabFrame, useCamera } from "@/lib/camera";
import { api, ApiError, DuplicateCandidate, FrameCheck } from "@/lib/api";

const STEPS = [
  "Look straight at the camera",
  "Turn your head slightly left",
  "Turn your head slightly right",
  "Lower your chin a little",
  "Look straight and smile",
];
// A face saved only without glasses can be hard to recognise with them (and vice versa), so capture both.
const GLASSES_STEPS = [
  "Switch glasses (put them on, or take them off) and look straight",
  "Glasses switched: turn your head slightly",
];
const CHECK_EVERY_MS = 700;

const RELATIONSHIPS = ["son", "daughter", "grandson", "granddaughter", "husband", "wife", "brother", "sister",
  "niece", "nephew", "friend", "neighbor", "caregiver", "doctor", "nurse"];

type Shot = { dataUrl: string; check?: FrameCheck; serverError?: string };
type Status = { kind: "idle" | "saving" | "ok" | "error"; msg?: string };

export default function EnrollPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const camError = useCamera(videoRef);

  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [glasses, setGlasses] = useState(false);
  const steps = glasses ? [...STEPS, ...GLASSES_STEPS] : STEPS;
  const [shots, setShots] = useState<(Shot | null)[]>([]);
  const [live, setLive] = useState<FrameCheck | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [dups, setDups] = useState<DuplicateCandidate[] | null>(null);

  const slots = steps.map((_, i) => shots[i] ?? null);
  const next = slots.findIndex((s) => s === null);
  const done = next === -1;
  const taken = slots.filter((s): s is Shot => s !== null);
  const bad = taken.filter((s) => s.serverError || s.check?.ok === false).length;

  // Live guidance: is there exactly one good face in view right now?
  const busy = useRef(false);
  useEffect(() => {
    if (done) return;
    const id = setInterval(async () => {
      const video = videoRef.current;
      const canvas = grabRef.current;
      if (busy.current || !video || !canvas) return;
      const f = grabFrame(video, canvas, 640, 0.7);
      if (!f) return;
      busy.current = true;
      try {
        setLive(await api.checkFrame(dataUrlToBlob(f.dataUrl)));
      } catch {
        setLive(null); // server not reachable: just no guidance
      } finally {
        busy.current = false;
      }
    }, CHECK_EVERY_MS);
    return () => clearInterval(id);
  }, [done]);

  async function capture() {
    if (!videoRef.current || !grabRef.current || done) return;
    const f = grabFrame(videoRef.current, grabRef.current, 640, 0.9);
    if (!f) return;
    const slot = next;
    setShots((s) => withSlot(s, slot, { dataUrl: f.dataUrl }));
    setStatus({ kind: "idle" });
    try {
      const check = await api.checkFrame(dataUrlToBlob(f.dataUrl));
      setShots((s) => (s[slot]?.dataUrl === f.dataUrl ? withSlot(s, slot, { dataUrl: f.dataUrl, check }) : s));
    } catch {
      /* the server re-checks every photo on save anyway */
    }
  }

  function retake(i: number) {
    setShots((s) => withSlot(s, i, null));
    setStatus({ kind: "idle" });
  }

  function reset() {
    setShots([]);
    setDups(null);
    setStatus({ kind: "idle" });
  }

  function finished(msg: string) {
    setStatus({ kind: "ok", msg });
    setShots([]);
    setDups(null);
    setName("");
    setRelationship("");
    setGlasses(false);
  }

  function failed(e: unknown) {
    if (e instanceof ApiError && e.status === 409 && e.candidates.length) {
      setDups(e.candidates);
      setStatus({ kind: "idle" });
      return;
    }
    if (e instanceof ApiError && e.photos.length) {
      // Map the server's photo indexes (in the order we sent them) back to our slots.
      const sentSlots = slots.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
      setShots((s) => {
        const copy = [...s];
        for (const p of e.photos) {
          const slot = sentSlots[p.index];
          if (copy[slot]) copy[slot] = { ...copy[slot]!, serverError: p.reason };
        }
        return copy;
      });
      setStatus({ kind: "error", msg: "Some photos need to be retaken - tap a photo marked in red." });
      return;
    }
    setStatus({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
  }

  const blobs = () => taken.map((s) => dataUrlToBlob(s.dataUrl));

  async function save(force = false) {
    if (!name.trim()) return setStatus({ kind: "error", msg: "Please enter a name." });
    if (taken.length < 3) return setStatus({ kind: "error", msg: "Capture at least 3 photos." });
    setStatus({ kind: "saving" });
    setDups(null);
    try {
      const person = await api.enroll(name.trim(), relationship.trim(), blobs(), force);
      finished(`Saved ${person.name}.`);
    } catch (e) {
      failed(e);
    }
  }

  /** "Yes, it's them": add these photos to the existing person instead of creating a duplicate. */
  async function addToExisting(c: DuplicateCandidate) {
    setStatus({ kind: "saving" });
    try {
      await api.addPhotos(c.id, blobs());
      if (c.is_unknown) {
        // A face the camera already saw as "Unknown #N": naming it keeps their visit history.
        await api.updatePerson(c.id, { name: name.trim(), relationship: relationship.trim() || null });
        finished(`Saved ${name.trim()} (kept the earlier visits recorded as ${c.name}).`);
      } else {
        finished(`Added ${taken.length} photos to ${c.name}.`);
      }
    } catch (e) {
      setDups(null);
      failed(e);
    }
  }

  const hint = liveHint(live);

  return (
    <main className="mx-auto max-w-5xl p-6 text-neutral-900">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-3xl font-bold">Add a person</h1>
        <nav className="flex gap-4 text-blue-700 underline">
          <Link href="/">Patient view</Link>
          <Link href="/caregiver">Caregiver</Link>
        </nav>
      </div>

      <div className="grid gap-6 md:grid-cols-[1fr_320px]">
        <section>
          <div className="relative overflow-hidden rounded-2xl bg-black">
            {/* Mirrored preview so the person can position themselves; captured frames are not mirrored. */}
            <video ref={videoRef} className="aspect-video w-full -scale-x-100 object-cover" muted playsInline />
            <div className="absolute inset-x-0 top-0 bg-black/60 p-4 text-center text-2xl font-semibold text-white">
              {done ? "All photos captured" : `${next + 1}/${steps.length}: ${steps[next]}`}
            </div>
            {!done && hint && (
              <div
                className={`absolute inset-x-0 bottom-4 mx-auto w-fit rounded-full px-5 py-2 text-lg font-semibold shadow-lg ${hint.className}`}
              >
                {hint.text}
              </div>
            )}
          </div>
          {camError && <p className="mt-2 text-red-700">Camera unavailable: {camError}</p>}
          <canvas ref={grabRef} className="hidden" />

          <div className="mt-4 flex gap-3">
            <button
              onClick={capture}
              disabled={done}
              className="rounded-xl bg-blue-600 px-6 py-3 text-lg font-semibold text-white disabled:opacity-40"
            >
              Capture photo
            </button>
            <button onClick={reset} className="rounded-xl border px-6 py-3 text-lg">
              Start over
            </button>
          </div>

          <div className="mt-4 grid grid-cols-4 gap-2 sm:grid-cols-7">
            {slots.map((s, i) => {
              const problem = s?.serverError ?? (s?.check?.ok === false ? s.check.reason ?? "No usable face" : null);
              return (
                <button
                  key={i}
                  onClick={() => s && retake(i)}
                  title={s ? "Tap to retake" : steps[i]}
                  className={`relative aspect-square overflow-hidden rounded-lg bg-neutral-200 ring-4 ${
                    !s ? "ring-transparent" : problem ? "ring-red-500" : s.check?.ok ? "ring-green-500" : "ring-transparent"
                  } ${i === next ? "outline outline-2 outline-blue-600" : ""}`}
                >
                  {s ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.dataUrl} alt={`photo ${i + 1}`} className="h-full w-full object-cover" />
                  ) : (
                    <span className="text-sm text-neutral-500">{i + 1}</span>
                  )}
                  {problem && (
                    <span className="absolute inset-x-0 bottom-0 bg-red-600/90 px-1 text-[11px] leading-tight text-white">
                      {problem}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {bad > 0 && <p className="mt-2 text-red-700">Tap a photo marked in red to retake it.</p>}
        </section>

        <section className="flex flex-col gap-4">
          <label className="flex flex-col gap-1">
            <span className="font-medium">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="rounded-lg border px-3 py-2 text-lg"
              placeholder="Miguel"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-medium">Relationship to the patient</span>
            <input
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              list="relationships"
              className="rounded-lg border px-3 py-2 text-lg"
              placeholder="grandson"
            />
            <datalist id="relationships">
              {RELATIONSHIPS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              checked={glasses}
              onChange={(e) => setGlasses(e.target.checked)}
              className="mt-1 h-5 w-5"
            />
            <span>
              <span className="font-medium">Sometimes wears glasses</span>
              <span className="block text-sm text-neutral-600">
                Adds 2 photos with the other look, so they&apos;re recognised with and without them.
              </span>
            </span>
          </label>

          {dups ? (
            <DuplicatePanel
              candidates={dups}
              name={name.trim()}
              busy={status.kind === "saving"}
              onAdd={addToExisting}
              onDifferent={() => save(true)}
              onCancel={() => setDups(null)}
            />
          ) : (
            <button
              onClick={() => save()}
              disabled={status.kind === "saving"}
              className="rounded-xl bg-green-600 px-6 py-3 text-lg font-semibold text-white disabled:opacity-40"
            >
              {status.kind === "saving" ? "Saving…" : "Save person"}
            </button>
          )}
          {status.msg && (
            <p className={status.kind === "error" ? "text-red-700" : "text-green-700"}>{status.msg}</p>
          )}
          <p className="text-sm text-neutral-600">
            One person in frame at a time. Good, even light on the face; avoid a bright window behind them.
            Photos stay on this computer.
          </p>
        </section>
      </div>
    </main>
  );
}

function DuplicatePanel({
  candidates,
  name,
  busy,
  onAdd,
  onDifferent,
  onCancel,
}: {
  candidates: DuplicateCandidate[];
  name: string;
  busy: boolean;
  onAdd: (c: DuplicateCandidate) => void;
  onDifferent: () => void;
  onCancel: () => void;
}) {
  const c = candidates[0];
  const who = `${c.name ?? "someone"}${c.relationship ? ` (${c.relationship})` : ""}`;
  return (
    <div className="flex flex-col gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-4">
      <p className="font-semibold">
        {c.is_unknown
          ? `The camera has seen this face before, saved as ${c.name}.`
          : c.reason === "name"
            ? `Someone named ${c.name} is already saved.`
            : `This looks like ${who}, who is already saved.`}
      </p>
      <p className="text-sm text-neutral-700">
        Saving the same person twice splits their visits and memories. Is this the same person?
      </p>
      <button
        onClick={() => onAdd(c)}
        disabled={busy}
        className="rounded-lg bg-blue-600 px-4 py-2 font-semibold text-white disabled:opacity-40"
      >
        {c.is_unknown ? `Yes - save as ${name || "this name"} and keep their visits` : `Yes - add these photos to ${c.name}`}
      </button>
      <button onClick={onDifferent} disabled={busy} className="rounded-lg border px-4 py-2 disabled:opacity-40">
        No - this is a different person
      </button>
      <button onClick={onCancel} disabled={busy} className="text-sm text-neutral-600 underline">
        Cancel
      </button>
    </div>
  );
}

function withSlot(shots: (Shot | null)[], i: number, shot: Shot | null) {
  const copy = [...shots];
  while (copy.length <= i) copy.push(null);
  copy[i] = shot;
  return copy;
}

function liveHint(c: FrameCheck | null): { text: string; className: string } | null {
  if (!c) return null;
  if (c.match && c.faces === 1) {
    return { text: `Already saved as ${c.match.name}`, className: "bg-amber-400 text-black" };
  }
  if (c.ok) return { text: "✓ Face found - ready", className: "bg-green-500 text-white" };
  const reason = c.reason ?? "No face found";
  return { text: reason.charAt(0).toUpperCase() + reason.slice(1), className: "bg-white/90 text-black" };
}
