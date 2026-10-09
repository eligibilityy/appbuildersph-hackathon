"use client";

import { useState } from "react";
import { toast } from "sonner";
import CameraCapture from "@/components/CameraCapture";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { dataUrlToBlob } from "@/lib/camera";
import { Person } from "@/lib/server";

const STEPS = ["Look straight at the camera", "Turn your head slightly left", "Turn your head slightly right"];

type Props = { person: Person; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void };

/** More photos for someone already known — e.g. they now wear glasses or have a new haircut. */
export default function AddPhotosDialog({ person, open, onOpenChange, onSaved }: Props) {
  const [photos, setPhotos] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const label = person.is_unknown ? "this person" : person.name;

  async function save() {
    setSaving(true);
    try {
      const { added } = await api.addPhotos(person.id, photos.map(dataUrlToBlob));
      toast.success(`Added ${added} photo${added === 1 ? "" : "s"} to ${label}`);
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error("Couldn't add photos", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-title">Add photos of {label}</DialogTitle>
          <DialogDescription>
            Useful when they look different now — glasses, a new haircut. Only {label} should be in frame.
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open, so the camera turns off when the dialog closes. */}
        {open && <CameraCapture steps={STEPS} onChange={setPhotos} />}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={photos.length === 0 || saving}>
            {saving
              ? "Saving…"
              : photos.length
                ? `Add ${photos.length} photo${photos.length === 1 ? "" : "s"}`
                : "Add photos"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
