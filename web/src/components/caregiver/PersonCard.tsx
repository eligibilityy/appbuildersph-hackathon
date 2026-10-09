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
import { initials } from "@/lib/format";
import { Person } from "@/lib/server";

type Props = {
  p: Person;
  version: number; // bump to refresh the thumbnail
  knownPeople: Person[];
  onChanged: () => void;
  onSelect: () => void;
};

export default function PersonCard({ p, version, knownPeople, onChanged, onSelect }: Props) {
  const [editing, setEditing] = useState(false);
  const [addingPhotos, setAddingPhotos] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const isUnknown = Boolean(p.is_unknown);

  async function remove() {
    try {
      await api.deletePerson(p.id);
      toast.success(`${p.name ?? "Person"} deleted`);
      onChanged();
    } catch (err) {
      toast.error("Couldn't delete this person", { description: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <li className={`rounded-xl border bg-card p-4 ${isUnknown ? "border-amber-400 bg-amber-50" : ""}`}>
      <button
        type="button"
        onClick={onSelect}
        className="mb-3 flex w-full min-w-0 items-start gap-4 rounded-md text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        aria-label={`View details for ${p.name ?? "unnamed person"}`}
      >
        <Avatar size="lg" className="size-16">
          <AvatarImage src={api.thumbUrl(p.id, version)} alt="" />
          <AvatarFallback>{initials(p.name)}</AvatarFallback>
        </Avatar>
        <span className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-lg font-semibold">{p.name ?? "Unnamed"}</span>
            {isUnknown && <Badge variant="secondary">Needs a name</Badge>}
            {p.name_source === "auto" && <Badge variant="outline">Confirm name</Badge>}
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
              <Pencil /> {isUnknown ? "Name this person" : "Edit"}
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
          <button type="button" className="font-medium text-primary hover:underline" onClick={() => setEditing(true)}>
            Confirm or fix it
          </button>
        </p>
      )}

      {isUnknown && (
        <div className="flex flex-col gap-2">
          <MergeControl unknown={p} knownPeople={knownPeople} onMerged={onChanged} />
          <Button type="button" variant="outline" className="w-full" onClick={() => setEditing(true)}>
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

function formatShortDate(value: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Not available"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
