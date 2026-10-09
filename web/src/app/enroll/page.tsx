"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { dataUrlToBlob, grabFrame, useCamera } from "@/lib/camera";
import { api } from "@/lib/api";

const STEPS = [
  "Look straight at the camera",
  "Turn your head slightly left",
  "Turn your head slightly right",
  "Tilt your chin up a little",
  "Tilt your chin down a little",
];

const RELATIONSHIPS = ["son", "daughter", "grandson", "granddaughter", "husband", "wife", "brother", "sister",
  "niece", "nephew", "friend", "neighbor", "caregiver", "doctor", "nurse"];

export default function EnrollPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const camError = useCamera(videoRef);

  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [shots, setShots] = useState<string[]>([]);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "ok" | "error"; msg?: string }>({ kind: "idle" });

  const step = Math.min(shots.length, STEPS.length - 1);
  const done = shots.length >= STEPS.length;

  function capture() {
    if (!videoRef.current || !grabRef.current || done) return;
    const f = grabFrame(videoRef.current, grabRef.current, 640, 0.9);
    if (f) setShots((s) => [...s, f.dataUrl]);
  }

  function reset() {
    setShots([]);
    setStatus({ kind: "idle" });
  }

  async function save() {
    if (!name.trim()) return setStatus({ kind: "error", msg: "Please enter a name." });
    if (shots.length < 3) return setStatus({ kind: "error", msg: "Capture at least 3 photos." });
    setStatus({ kind: "saving" });
    try {
      const person = await api.enroll(name.trim(), relationship.trim(), shots.map(dataUrlToBlob));
      setStatus({ kind: "ok", msg: `Saved ${person.name}.` });
      setShots([]);
      setName("");
      setRelationship("");
    } catch (e) {
      setStatus({ kind: "error", msg: e instanceof Error ? e.message : String(e) });
    }
  }

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
              {done ? "All photos captured" : `${shots.length + 1}/${STEPS.length}: ${STEPS[step]}`}
            </div>
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

          <div className="mt-4 grid grid-cols-5 gap-2">
            {STEPS.map((_, i) => (
              <div key={i} className="aspect-square overflow-hidden rounded-lg bg-neutral-200">
                {shots[i] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shots[i]} alt={`shot ${i + 1}`} className="h-full w-full object-cover" />
                )}
              </div>
            ))}
          </div>
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
          <button
            onClick={save}
            disabled={status.kind === "saving"}
            className="rounded-xl bg-green-600 px-6 py-3 text-lg font-semibold text-white disabled:opacity-40"
          >
            {status.kind === "saving" ? "Saving…" : "Save person"}
          </button>
          {status.msg && (
            <p className={status.kind === "error" ? "text-red-700" : "text-green-700"}>{status.msg}</p>
          )}
          <p className="text-sm text-neutral-600">
            One person in frame at a time. Good, even lighting helps. Photos stay on this computer.
          </p>
        </section>
      </div>
    </main>
  );
}
