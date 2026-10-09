"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Glasses, ShieldCheck, UserCheck } from "lucide-react";
import { toast } from "sonner";
import AppHeader from "@/components/app/AppHeader";
import CameraCapture, { CaptureHint, PhotoMark } from "@/components/CameraCapture";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api, ApiError, DuplicateCandidate, FrameCheck } from "@/lib/api";
import { dataUrlToBlob, grabFrame } from "@/lib/camera";
import { cn } from "@/lib/utils";

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
const MIN_PHOTOS = 3;

const RELATIONSHIPS = ["grandson", "granddaughter", "son", "daughter", "wife", "husband", "friend", "caregiver"];

type Shot = { dataUrl: string; check?: FrameCheck; serverError?: string };

export default function EnrollPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const checkCanvasRef = useRef<HTMLCanvasElement>(null);

  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [glasses, setGlasses] = useState(false);
  const steps = glasses ? [...STEPS, ...GLASSES_STEPS] : STEPS;
  const [shots, setShots] = useState<(Shot | null)[]>([]);
  const [live, setLive] = useState<FrameCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dups, setDups] = useState<DuplicateCandidate[] | null>(null);

  const slots = steps.map((_, i) => shots[i] ?? null);
  const next = slots.findIndex((s) => s === null);
  const done = next === -1;
  const taken = slots.filter((s): s is Shot => s !== null);
  const bad = taken.filter((s) => s.serverError || s.check?.ok === false).length;
  const canSave = name.trim().length > 0 && taken.length >= MIN_PHOTOS && !saving;

  // Live guidance: is there exactly one good face in view right now?
  const busy = useRef(false);
  useEffect(() => {
    if (done) return;
    const id = setInterval(async () => {
      const video = videoRef.current;
      const canvas = checkCanvasRef.current;
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

  async function capture(slot: number, dataUrl: string) {
    setShots((s) => withSlot(s, slot, { dataUrl }));
    setError(null);
    try {
      const check = await api.checkFrame(dataUrlToBlob(dataUrl));
      setShots((s) => (s[slot]?.dataUrl === dataUrl ? withSlot(s, slot, { dataUrl, check }) : s));
    } catch {
      /* the server re-checks every photo on save anyway */
    }
  }

  function retake(i: number) {
    setShots((s) => withSlot(s, i, null));
    setError(null);
  }

  function finished(title: string, description?: string) {
    toast.success(title, {
      description: description ?? "They'll be recognized on the patient view.",
      action: { label: "View people", onClick: () => (window.location.href = "/caregiver") },
    });
    setShots([]);
    setDups(null);
    setName("");
    setRelationship("");
    setGlasses(false);
    setError(null);
  }

  function failed(e: unknown) {
    if (e instanceof ApiError && e.status === 409 && e.candidates.length) {
      setDups(e.candidates);
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
      setError("Some photos need to be retaken — tap × on a photo marked in red.");
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    setError(msg);
    toast.error("Couldn't save", { description: msg });
  }

  const blobs = () => taken.map((s) => dataUrlToBlob(s.dataUrl));

  async function save(force = false) {
    if (!name.trim()) return setError("Enter a name.");
    if (taken.length < MIN_PHOTOS) return setError(`Take at least ${MIN_PHOTOS} photos.`);
    setSaving(true);
    setError(null);
    setDups(null);
    try {
      const person = await api.enroll(name.trim(), relationship.trim(), blobs(), force);
      finished(`${person.name} was added`);
    } catch (e) {
      failed(e);
    } finally {
      setSaving(false);
    }
  }

  /** "Yes, it's them": add these photos to the existing person instead of creating a duplicate. */
  async function addToExisting(c: DuplicateCandidate) {
    setSaving(true);
    try {
      await api.addPhotos(c.id, blobs());
      if (c.is_unknown) {
        // A face the camera already saw as "Unknown #N": naming it keeps their visit history.
        await api.updatePerson(c.id, { name: name.trim(), relationship: relationship.trim() || null });
        finished(`${name.trim()} was added`, `Kept the earlier visits recorded as ${c.name}.`);
      } else {
        finished(`Added ${taken.length} photos to ${c.name}`);
      }
    } catch (e) {
      setDups(null);
      failed(e);
    } finally {
      setSaving(false);
    }
  }

  const marks: (PhotoMark | null)[] = slots.map((s) => {
    if (!s) return null;
    const problem = s.serverError ?? (s.check?.ok === false ? (s.check.reason ?? "No usable face") : null);
    if (problem) return { ok: false, message: problem };
    return s.check?.ok ? { ok: true } : null;
  });

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-large-title">Add a person</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Take {steps.length} photos from slightly different angles, one person in frame.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="p-4 sm:p-5">
            <CameraCapture
              steps={steps}
              slots={slots.map((s) => s?.dataUrl ?? null)}
              onCapture={capture}
              onRetake={retake}
              marks={marks}
              hint={liveHint(live)}
              videoRef={videoRef}
            />
            <canvas ref={checkCanvasRef} className="hidden" />
            {bad > 0 && <p className="text-body text-destructive">Tap × on a photo marked in red to retake it.</p>}
          </Card>

          <Card className="h-fit">
            <CardContent>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  save();
                }}
                className="flex flex-col gap-5"
              >
                <div className="flex flex-col gap-2">
                  <Label htmlFor="name" className="text-footnote font-medium text-muted-foreground">
                    Name
                  </Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Miguel"
                    autoComplete="off"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <Label htmlFor="relationship" className="text-footnote font-medium text-muted-foreground">
                    Relationship to the patient
                  </Label>
                  <Input
                    id="relationship"
                    value={relationship}
                    onChange={(e) => setRelationship(e.target.value)}
                    placeholder="grandson"
                    autoComplete="off"
                  />
                  <div className="flex flex-wrap gap-1.5 pt-1">
                    {RELATIONSHIPS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => setRelationship(r)}
                        className={cn(
                          "h-8 rounded-full border px-3 text-footnote font-medium transition-colors duration-150 outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
                          relationship === r
                            ? "border-primary bg-primary/10 text-primary"
                            : "bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        {r}
                      </button>
                    ))}
                  </div>
                </div>

                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors duration-150",
                    glasses ? "border-primary bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={glasses}
                    onChange={(e) => setGlasses(e.target.checked)}
                    className="mt-0.5 size-5 shrink-0 accent-[var(--primary)]"
                  />
                  <span className="flex-1">
                    <span className="flex items-center gap-1.5 text-body font-medium">
                      <Glasses className="size-4 text-muted-foreground" /> Sometimes wears glasses
                    </span>
                    <span className="mt-0.5 block text-footnote text-muted-foreground">
                      Adds 2 photos with the other look, so they&apos;re recognized with and without them.
                    </span>
                  </span>
                </label>

                <Separator />

                <div className="flex items-center justify-between text-body">
                  <span className="text-muted-foreground">Photos</span>
                  <span className={cn("font-medium", taken.length >= MIN_PHOTOS ? "text-success" : "text-foreground")}>
                    {taken.length} of {steps.length}
                    {taken.length < MIN_PHOTOS && <span className="text-muted-foreground"> · {MIN_PHOTOS} needed</span>}
                  </span>
                </div>

                {error && (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-body text-destructive"
                  >
                    <AlertCircle className="mt-0.5 size-4 shrink-0" />
                    {error}
                  </p>
                )}

                {dups ? (
                  <DuplicatePanel
                    candidates={dups}
                    name={name.trim()}
                    busy={saving}
                    onAdd={addToExisting}
                    onDifferent={() => save(true)}
                    onCancel={() => setDups(null)}
                  />
                ) : (
                  <Button type="submit" size="lg" disabled={!canSave} className="w-full">
                    {saving ? "Saving…" : "Save person"}
                  </Button>
                )}

                <p className="flex items-start gap-2 text-footnote text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                  Good, even light on the face; avoid a bright window behind them. Photos stay on this computer.
                </p>
              </form>
            </CardContent>
          </Card>
        </div>

        <p className="mt-6 text-footnote text-muted-foreground">
          Already added someone who now looks different (glasses, new haircut)? Use <strong>Add photos</strong> on their
          card in{" "}
          <Link href="/caregiver" className="font-medium text-primary hover:underline">
            People
          </Link>
          .
        </p>
      </main>
    </>
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
    <div role="alert" className="flex flex-col gap-3 rounded-xl border border-warning/50 bg-warning/10 p-4">
      <p className="flex items-start gap-2 text-headline">
        <UserCheck className="mt-0.5 size-5 shrink-0 text-[#b25f00]" />
        {c.is_unknown
          ? `The camera has seen this face before, saved as ${c.name}.`
          : c.reason === "name"
            ? `Someone named ${c.name} is already saved.`
            : `This looks like ${who}, who is already saved.`}
      </p>
      <p className="text-body text-muted-foreground">
        Saving the same person twice splits their visits and memories. Is this the same person?
      </p>
      <Button type="button" onClick={() => onAdd(c)} disabled={busy} className="h-auto min-h-10 whitespace-normal py-2">
        {c.is_unknown
          ? `Yes — save as ${name || "this name"} and keep their visits`
          : `Yes — add these photos to ${c.name}`}
      </Button>
      <Button type="button" variant="outline" onClick={onDifferent} disabled={busy}>
        No — this is a different person
      </Button>
      <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
        Cancel
      </Button>
    </div>
  );
}

function withSlot(shots: (Shot | null)[], i: number, shot: Shot | null) {
  const copy = [...shots];
  while (copy.length <= i) copy.push(null);
  copy[i] = shot;
  return copy;
}

function liveHint(c: FrameCheck | null): CaptureHint | null {
  if (!c) return null;
  if (c.match && c.faces === 1) return { text: `Already saved as ${c.match.name}`, tone: "warn" };
  if (c.ok) return { text: "✓ Face found — ready", tone: "ok" };
  const reason = c.reason ?? "No face found";
  return { text: reason.charAt(0).toUpperCase() + reason.slice(1), tone: "info" };
}
