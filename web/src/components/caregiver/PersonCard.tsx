"use client";

import { useState } from "react";
import { Camera, ChevronRight, History, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import AddPhotosDialog from "@/components/caregiver/AddPhotosDialog";
import EditPersonDialog from "@/components/caregiver/EditPersonDialog";
import MergeControl from "@/components/caregiver/MergeControl";
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
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import { initials, timeAgo } from "@/lib/format";
import { Person } from "@/lib/server";
import { cn } from "@/lib/utils";

type Props = {
  p: Person;
  version: number; // bump to refresh the thumbnail
  knownPeople: Person[]; // merge targets for Unknown cards
  onChanged: () => void;
  /** Open the detail view (registration, appearance history, hourly monitoring). */
  onSelect: (p: Person) => void;
};

/** One person: iOS-contact-style card with an overflow menu; Unknowns also get "This is…" merge. */
export default function PersonCard({ p, version, knownPeople, onChanged, onSelect }: Props) {
  const [editing, setEditing] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const unknown = !!p.is_unknown;
  const lastSeen = timeAgo(p.last_seen_at ?? p.last_seen);
  const visits = p.visit_count ?? 0;

  async function remove() {
    try {
      await api.deletePerson(p.id);
      toast.success(`${p.name ?? "Person"} was deleted`);
      onChanged();
    } catch (err) {
      toast.error("Couldn't delete", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <li
      className={cn(
        "flex flex-col gap-3 rounded-2xl border bg-card p-4",
        unknown && "shadow-[inset_3px_0_0_var(--warning)]",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onSelect(p)}
          aria-label={`View details and appearance history for ${p.name ?? "this person"}`}
          className="group -m-1.5 flex min-w-0 flex-1 items-center gap-3.5 rounded-xl p-1.5 text-left transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Avatar className="size-14 shrink-0">
            <AvatarImage src={api.thumbUrl(p.id, version)} alt="" className="object-cover" />
            <AvatarFallback className="bg-secondary text-headline text-muted-foreground">
              {initials(p.name)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-headline">{p.name ?? "Unnamed"}</span>
              {p.name_source === "auto" && (
                <Badge className="shrink-0 rounded-full bg-primary/10 font-medium text-primary">Auto-named</Badge>
              )}
            </div>
            {unknown ? (
              <div className="text-body text-[#b25f00]">Needs a name</div>
            ) : (
              p.relationship && <div className="truncate text-body text-muted-foreground">{p.relationship}</div>
            )}
            <div className="mt-0.5 text-footnote text-tertiary-foreground">
              {lastSeen ? `Last seen ${lastSeen}` : "Not seen yet"}
              {visits > 0 && ` · ${visits} visit${visits === 1 ? "" : "s"}`}
            </div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-tertiary-foreground transition-transform duration-150 group-hover:translate-x-0.5" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`More actions for ${p.name ?? "this person"}`}>
              <MoreHorizontal className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
            <DropdownMenuItem onSelect={() => onSelect(p)}>
              <History /> View details
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setEditing(true)}>
              <Pencil /> {unknown ? "Name this person" : "Edit"}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setAddingPhotos(true)}>
              <Camera /> Add photos
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(true)}>
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {!unknown && p.notes?.trim() && (
        <p className="line-clamp-2 text-body text-muted-foreground" title={p.notes}>
          {p.notes}
        </p>
      )}

      {p.name_source === "auto" && (
        <p className="rounded-lg bg-primary/5 px-3 py-2 text-footnote text-muted-foreground">
          Name picked up from a conversation.{" "}
          <button className="font-medium text-primary hover:underline" onClick={() => setEditing(true)}>
            Confirm or fix it
          </button>
        </p>
      )}

      {unknown && (
        <div className="flex flex-col gap-2">
          <MergeControl unknown={p} knownPeople={knownPeople} onMerged={onChanged} />
          <Button variant="outline" className="w-full" onClick={() => setEditing(true)}>
            <Pencil /> It&apos;s someone new — name them
          </Button>
        </div>
      )}

      <EditPersonDialog person={p} open={editing} onOpenChange={setEditing} onSaved={onChanged} />
      <AddPhotosDialog person={p} open={addingPhotos} onOpenChange={setAddingPhotos} onSaved={onChanged} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {p.name ?? "this person"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Their photos, visits and memories are removed from this computer. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
