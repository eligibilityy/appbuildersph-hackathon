"use client";

import { useState } from "react";
import { Camera, MoreHorizontal, Pencil, Trash2 } from "lucide-react";
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
  onSave: (p: Person, name: string, relationship: string) => void;
  onDelete: (p: Person) => void;
  onSelect: (p: Person) => void;
};

// TODO (block 1, frontend): on Unknown cards, add "This is…" <select> of known people -> api.merge();
// on known cards, add "Add photos" (camera capture, like /enroll) -> api.addPhotos().
export default function PersonCard({ p, version, onSave, onDelete, onSelect }: Props) {
  const [name, setName] = useState(p.is_unknown ? "" : (p.name ?? ""));
  const [relationship, setRelationship] = useState(p.relationship ?? "");

  return (
    <li className={`rounded-lg border p-4 ${p.is_unknown ? "border-amber-400 bg-amber-50" : ""}`}>
      <button
        type="button"
        onClick={() => onSelect(p)}
        className="mb-3 flex w-full min-w-0 items-start gap-4 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        aria-label={`View details for ${p.name ?? "unnamed person"}`}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={api.thumbUrl(p.id, version)}
          alt=""
          className="h-24 w-24 shrink-0 rounded-md bg-neutral-200 object-cover"
        />
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold">{p.name ?? "Unnamed"}</span>
            {p.is_unknown ? <Badge className="bg-amber-200">needs a name</Badge> : null}
            {p.name_source === "auto" ? <Badge className="bg-blue-100">auto-named, please confirm</Badge> : null}
          </span>
          <span className="text-sm text-neutral-600">
            {p.relationship ?? "Relationship not recorded"}
          </span>
          <span className="text-sm text-neutral-600">
            Registered: {formatShortDate(p.registered_at)}
          </span>
          <span className="text-sm text-blue-800 underline">View details and appearance history</span>
        </span>
      </button>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="text-sm text-neutral-600">
          {p.visit_count ?? 0} visit(s){p.last_seen_at ? ` · last seen ${formatShortDate(p.last_seen_at)}` : ""}
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`More actions for ${p.name ?? "this person"}`}>
              <MoreHorizontal className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-44">
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

function Badge({ children, className }: { children: React.ReactNode; className: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs ${className}`}>{children}</span>;
}

function formatShortDate(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
