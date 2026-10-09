"use client";

import Link from "next/link";
import { useState } from "react";
import { AlertCircle, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import AppHeader from "@/components/app/AppHeader";
import CameraCapture from "@/components/CameraCapture";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { api } from "@/lib/api";
import { dataUrlToBlob } from "@/lib/camera";
import { cn } from "@/lib/utils";

const STEPS = [
  "Look straight at the camera",
  "Turn your head slightly left",
  "Turn your head slightly right",
  "Tilt your chin up a little",
  "Tilt your chin down a little",
];
const MIN_PHOTOS = 3;

const RELATIONSHIPS = ["grandson", "granddaughter", "son", "daughter", "wife", "husband", "friend", "caregiver"];

export default function EnrollPage() {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [resetKey, setResetKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && photos.length >= MIN_PHOTOS && !saving;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Enter a name.");
    if (photos.length < MIN_PHOTOS) return setError(`Take at least ${MIN_PHOTOS} photos.`);
    setSaving(true);
    setError(null);
    try {
      const person = await api.enroll(name.trim(), relationship.trim(), photos.map(dataUrlToBlob));
      toast.success(`${person.name} was added`, {
        description: "They'll be recognized on the patient view.",
        action: { label: "View people", onClick: () => (window.location.href = "/caregiver") },
      });
      setName("");
      setRelationship("");
      setResetKey((k) => k + 1);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      toast.error("Couldn't save", { description: msg });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <AppHeader />
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <div className="mb-6">
          <h1 className="text-large-title">Add a person</h1>
          <p className="mt-1 text-body text-muted-foreground">
            Take {STEPS.length} photos from slightly different angles, one person in frame.
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="p-4 sm:p-5">
            <CameraCapture steps={STEPS} onChange={setPhotos} resetKey={resetKey} />
          </Card>

          <Card className="h-fit">
            <CardContent>
              <form onSubmit={save} className="flex flex-col gap-5">
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

                <Separator />

                <div className="flex items-center justify-between text-body">
                  <span className="text-muted-foreground">Photos</span>
                  <span className={cn("font-medium", photos.length >= MIN_PHOTOS ? "text-success" : "text-foreground")}>
                    {photos.length} of {STEPS.length}
                    {photos.length < MIN_PHOTOS && (
                      <span className="text-muted-foreground"> · {MIN_PHOTOS} needed</span>
                    )}
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

                <Button type="submit" size="lg" disabled={!canSave} className="w-full">
                  {saving ? "Saving…" : "Save person"}
                </Button>

                <p className="flex items-start gap-2 text-footnote text-muted-foreground">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-success" />
                  Photos stay on this computer. Nothing is uploaded.
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
