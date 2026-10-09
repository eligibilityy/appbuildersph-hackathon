"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/api";
import { Person } from "@/lib/server";

type Props = { person: Person; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => void };

/** Name + relationship form. Naming an Unknown makes them a known person. */
export default function EditPersonDialog({ person, open, onOpenChange, onSaved }: Props) {
  const [name, setName] = useState("");
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setName(person.is_unknown ? "" : (person.name ?? ""));
      setRelationship(person.relationship ?? "");
    }
  }, [open, person]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await api.updatePerson(person.id, { name: name.trim(), relationship: relationship.trim() });
      toast.success(person.is_unknown ? `Saved as ${name.trim()}` : "Changes saved");
      onOpenChange(false);
      onSaved();
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle className="text-title">
              {person.is_unknown ? "Who is this?" : `Edit ${person.name}`}
            </DialogTitle>
            <DialogDescription>
              {person.is_unknown
                ? "Give them a name so the app can introduce them to the patient."
                : "This is how the app introduces them to the patient."}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`name-${person.id}`} className="text-footnote font-medium text-muted-foreground">
              Name
            </Label>
            <Input
              id={`name-${person.id}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Miguel"
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={`rel-${person.id}`} className="text-footnote font-medium text-muted-foreground">
              Relationship to the patient
            </Label>
            <Input
              id={`rel-${person.id}`}
              value={relationship}
              onChange={(e) => setRelationship(e.target.value)}
              placeholder="grandson"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
