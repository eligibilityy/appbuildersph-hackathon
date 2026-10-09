"use client";

import Link from "next/link";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { AlertCircle, CircleCheck, Glasses, ShieldCheck, UserCheck, X } from "lucide-react";
import { toast } from "sonner";
import AppHeader from "@/components/app/AppHeader";
import AutoEnrollCamera from "@/components/AutoEnrollCamera";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, DuplicateCandidate } from "@/lib/api";
import { buildSteps, captureReducer, initialState, Sample } from "@/lib/autoCapture";
import { dataUrlToBlob } from "@/lib/camera";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

const RELATIONSHIPS = ["grandson", "granddaughter", "son", "daughter", "wife", "husband", "friend", "caregiver"];

type Saved = { id: number; name: string; notes: string };

export default function EnrollPage() {
  const [state, dispatch] = useReducer(captureReducer, undefined, initialState);
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [notes, setNotes] = useState("");
  const [glasses, setGlasses] = useState(false);
  const [dups, setDups] = useState<DuplicateCandidate[] | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);

  const phase = state.phase;
  const busy = phase === "saving";
  const scanning = phase === "starting" || phase === "scanning";
  const blobs = useCallback(() => state.samples.map((s) => dataUrlToBlob(s.dataUrl)), [state.samples]);

  function start() {
    if (!name.trim()) return;
    setDups(null);
    dispatch({ type: "START", steps: buildSteps(glasses), now: performance.now() });
  }

  function cancel() {
    dispatch({ type: "CANCEL" }); // stops the camera and discards the photos taken so far
    setDups(null);
  }

  function reset() {
    cancel();
    setSaved(null);
    setName("");
    setRelationship("");
    setNotes("");
    setGlasses(false);
  }

  const save = useCallback(
    async (force = false) => {
      if (!name.trim()) {
        dispatch({ type: "SAVE_START" });
        dispatch({ type: "SAVE_FAILED", message: "Enter a name to finish.", now: performance.now() });
        return;
      }
      setDups(null);
      dispatch({ type: "SAVE_START" });
      try {
        const person = await api.enroll(name.trim(), relationship.trim(), blobs(), force, notes.trim());
        dispatch({ type: "SAVED" });
        setSaved({ id: person.id, name: person.name ?? name.trim(), notes: notes.trim() });
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.candidates.length) {
          setDups(e.candidates);
          dispatch({ type: "SAVE_FAILED", message: e.message, now: performance.now() });
        } else if (e instanceof ApiError && e.photos.length) {
          // Retake just the photos the server rejected; the scan resumes by itself.
          dispatch({
            type: "SAVE_FAILED",
            message: `Some photos need retaking: ${e.message}`,
            retakeSamples: e.photos.map((p) => p.index),
            now: performance.now(),
          });
        } else {
          dispatch({ type: "SAVE_FAILED", message: e instanceof Error ? e.message : String(e), now: performance.now() });
        }
      }
    },
    [name, relationship, notes, blobs],
  );

  // All photos captured -> save automatically (once per set of photos).
  const savedFor = useRef<Sample[] | null>(null);
  useEffect(() => {
    if (phase !== "complete" || state.error || dups || savedFor.current === state.samples) return;
    savedFor.current = state.samples;
    save();
  }, [phase, state.error, state.samples, dups, save]);

  /** "Yes, it's them": add these photos to the existing person instead of creating a duplicate. */
  async function addToExisting(c: DuplicateCandidate) {
    dispatch({ type: "SAVE_START" });
    try {
      await api.addPhotos(c.id, blobs());
      if (c.is_unknown) {
        // A face the camera already saw as "Unknown #N": naming it keeps their visit history.
        await api.updatePerson(c.id, {
          name: name.trim(),
          relationship: relationship.trim() || null,
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        });
        toast.success(`${name.trim()} was added`, { description: `Kept the earlier visits recorded as ${c.name}.` });
        setSaved({ id: c.id, name: name.trim(), notes: notes.trim() });
      } else {
        toast.success(`Added ${state.samples.length} photos to ${c.name}`);
        setSaved({ id: c.id, name: c.name ?? name.trim(), notes: "" });
      }
      setDups(null);
      dispatch({ type: "SAVED" });
    } catch (e) {
      setDups(null);
      dispatch({ type: "SAVE_FAILED", message: e instanceof Error ? e.message : String(e), now: performance.now() });
    }
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-large-title">Add a person</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Fill in who they are, then start the face scan. Photos are taken automatically; one person in view.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="p-4 sm:p-5">
            <AutoEnrollCamera
              state={state}
              dispatch={dispatch}
              canStart={!!name.trim()}
              startHint="Enter their name first."
              onStart={start}
            />
          </Card>

          <Card className="h-fit">
            <CardContent>
              {phase === "done" && saved ? (
                <DonePanel saved={saved} onAnother={reset} />
              ) : (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (phase === "idle" || phase === "error") start();
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

                  <div className="flex flex-col gap-2">
                    <Label htmlFor="notes" className="text-footnote font-medium text-muted-foreground">
                      Description <span className="font-normal">(optional)</span>
                    </Label>
                    <Textarea
                      id="notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      placeholder="A few words to help remember them. You can add this later."
                      maxLength={2000}
                      rows={3}
                    />
                  </div>

                  <label
                    className={cn(
                      "flex items-start gap-3 rounded-xl border p-3 transition-colors duration-150",
                      scanning ? "opacity-60" : "cursor-pointer",
                      glasses ? "border-primary bg-primary/5" : !scanning && "hover:bg-muted",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={glasses}
                      disabled={scanning}
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
                    <span className="text-muted-foreground">Face samples</span>
                    <span className="font-medium">
                      {state.samples.length} of{" "}
                      {state.steps.length ? state.steps.length - state.results.filter((r) => r === "skipped").length : buildSteps(glasses).length}
                    </span>
                  </div>

                  {state.error && phase !== "error" && !dups && (
                    <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-body text-destructive">
                      <AlertCircle className="mt-0.5 size-4 shrink-0" />
                      {state.error}
                    </p>
                  )}

                  {dups ? (
                    <DuplicatePanel
                      candidates={dups}
                      name={name.trim()}
                      busy={busy}
                      onAdd={addToExisting}
                      onDifferent={() => save(true)}
                      onCancel={cancel}
                    />
                  ) : phase === "idle" || phase === "error" ? (
                    <Button type="submit" size="lg" disabled={!name.trim()} className="w-full">
                      Start face scan
                    </Button>
                  ) : phase === "complete" ? (
                    <Button type="button" size="lg" onClick={() => save()} className="w-full">
                      Try saving again
                    </Button>
                  ) : (
                    <Button type="button" size="lg" disabled className="w-full">
                      {busy ? "Saving…" : "Scanning…"}
                    </Button>
                  )}

                  {phase !== "idle" && !busy && (
                    <Button type="button" variant="outline" onClick={cancel} className="w-full">
                      <X /> Cancel
                    </Button>
                  )}

                  <p className="flex items-start gap-2 text-footnote text-muted-foreground">
                    <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                    The camera only runs during the scan. Photos stay on this computer, and cancelled scans are
                    discarded.
                  </p>
                </form>
              )}
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

/** After saving: confirm, and let the caregiver add or edit the optional description right away. */
function DonePanel({ saved, onAnother }: { saved: Saved; onAnother: () => void }) {
  const [notes, setNotes] = useState(saved.notes);
  const [savingNotes, setSavingNotes] = useState(false);
  const [stored, setStored] = useState(saved.notes);
  const [thumbVersion] = useState(() => Date.now());

  async function saveNotes() {
    setSavingNotes(true);
    try {
      await api.updatePerson(saved.id, { notes: notes.trim() || null });
      setStored(notes.trim());
      toast.success(notes.trim() ? "Description saved" : "Description cleared");
    } catch (e) {
      toast.error("Couldn't save the description", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setSavingNotes(false);
    }
  }

  return (
    <div className="flex flex-col gap-5" role="status">
      <div className="flex items-center gap-3.5">
        <Avatar className="size-14">
          <AvatarImage src={api.thumbUrl(saved.id, thumbVersion)} alt="" className="object-cover" />
          <AvatarFallback className="bg-secondary text-headline text-muted-foreground">{initials(saved.name)}</AvatarFallback>
        </Avatar>
        <div>
          <p className="flex items-center gap-1.5 text-title">
            <CircleCheck className="size-5 text-success" /> Enrollment complete
          </p>
          <p className="text-body text-muted-foreground">{saved.name} will be recognized on the patient view.</p>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="done-notes" className="text-footnote font-medium text-muted-foreground">
          Description <span className="font-normal">(optional)</span>
        </Label>
        <Textarea id="done-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} rows={3} />
        <Button type="button" variant="outline" onClick={saveNotes} disabled={savingNotes || notes.trim() === stored}>
          {savingNotes ? "Saving…" : "Save description"}
        </Button>
      </div>
      <Separator />
      <Button type="button" size="lg" onClick={onAnother}>
        Add another person
      </Button>
      <Button asChild variant="ghost">
        <Link href="/caregiver">Go to People</Link>
      </Button>
    </div>
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
        Cancel and discard the photos
      </Button>
    </div>
  );
}
