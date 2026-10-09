"use client";

import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import { Person } from "@/lib/server";

type Props = { unknown: Person; knownPeople: Person[]; onMerged: () => void };

/** "This is…" picker on an Unknown card: merges them into a known person after a confirmation. */
export default function MergeControl({ unknown, knownPeople, onMerged }: Props) {
  const [targetId, setTargetId] = useState<string>("");
  const [confirming, setConfirming] = useState(false);
  const [merging, setMerging] = useState(false);
  const target = knownPeople.find((p) => String(p.id) === targetId);

  if (knownPeople.length === 0) return null;

  async function merge() {
    if (!target) return;
    setMerging(true);
    try {
      await api.merge(unknown.id, target.id);
      toast.success(`Merged into ${target.name}`, {
        description: `${target.name} will now be recognized from these photos too.`,
      });
      setConfirming(false);
      onMerged();
    } catch (err) {
      toast.error("Couldn't merge", { description: err instanceof Error ? err.message : String(err) });
    } finally {
      setMerging(false);
    }
  }

  return (
    <div className="flex gap-2">
      <Select value={targetId} onValueChange={setTargetId}>
        <SelectTrigger className="h-10 min-w-0 flex-1 bg-card" aria-label={`Who is ${unknown.name}?`}>
          <SelectValue placeholder="This is…" />
        </SelectTrigger>
        <SelectContent>
          {knownPeople.map((p) => (
            <SelectItem key={p.id} value={String(p.id)}>
              {p.name}
              {p.relationship ? <span className="text-muted-foreground"> · {p.relationship}</span> : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="secondary" disabled={!target} onClick={() => setConfirming(true)}>
        Merge
      </Button>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Merge into {target?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              {unknown.name}&apos;s photos and visits will move to {target?.name}, and {unknown.name} will be removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault(); // keep the dialog open until the merge finishes
                merge();
              }}
              disabled={merging}
            >
              {merging ? "Merging…" : "Merge"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
