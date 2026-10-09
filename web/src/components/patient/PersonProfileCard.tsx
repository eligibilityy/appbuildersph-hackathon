"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Pencil, X } from "lucide-react";
import EditPersonDialog from "@/components/caregiver/EditPersonDialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { TagAnchor } from "@/components/FaceOverlay";
import { api, ApiError, PersonDetail } from "@/lib/api";
import { initials, timeAgo } from "@/lib/format";
import { profileView } from "@/lib/profile";
import { cn } from "@/lib/utils";

type Props = {
  personId: number;
  anchor: TagAnchor;
  /** Bump to refetch (e.g. after a memory_updated event for this person). */
  version: number;
  onClose: () => void;
};

const WIDTH = 380;
const GAP = 14;

/** Compact profile card opened from a name tag. Shows only what's saved for that person. */
export default function PersonProfileCard({ personId, anchor, version, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [person, setPerson] = useState<PersonDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [reload, setReload] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .person(personId)
      .then((p) => !cancelled && setPerson(p))
      .catch((e) => {
        if (cancelled) return;
        setPerson(null);
        setError(e instanceof ApiError && e.status === 404 ? "This person is no longer saved." : "Couldn't load this profile.");
      });
    return () => {
      cancelled = true;
    };
  }, [personId, version, reload]);

  // Keep the card next to its name tag: below it if there's room, otherwise above; never off-screen.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.min(Math.max(anchor.x - w / 2, 16), vw - w - 16);
    let top = anchor.bottom + GAP;
    if (top + h > vh - 16) top = Math.max(16, anchor.top - GAP - h);
    setPos((p) => (p && p.left === left && p.top === top ? p : { left, top }));
  }, [anchor, person, error]);

  useEffect(() => closeRef.current?.focus(), [personId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !editing) onClose();
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      // Clicks on a name tag are handled by the tag itself (open another profile, or toggle this one).
      if (!editing && ref.current && !ref.current.contains(t) && !t.closest?.("[data-name-tag]")) onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown);
    };
  }, [onClose, editing]);

  const v = person ? profileView(person) : null;
  const lastVisit = v?.lastVisitAt ? timeAgo(v.lastVisitAt) : null;

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-labelledby={`profile-${personId}`}
      className={cn(
        "absolute z-20 flex flex-col gap-4 rounded-3xl bg-card p-5 text-card-foreground shadow-2xl ring-2 ring-cyan-300/80",
        "animate-in fade-in-0 zoom-in-95 duration-200",
        !pos && "invisible",
      )}
      style={{ width: `min(${WIDTH}px, calc(100vw - 32px))`, left: pos?.left ?? 0, top: pos?.top ?? 0 }}
    >
      <div className="flex items-start gap-3.5">
        <Avatar className="size-16 shrink-0">
          <AvatarImage src={api.thumbUrl(personId, version)} alt="" className="object-cover" />
          <AvatarFallback className="bg-secondary text-headline text-muted-foreground">{initials(v?.name)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 pt-0.5">
          {v ? (
            <>
              <h2 id={`profile-${personId}`} className="text-[26px] leading-8 font-bold tracking-[-0.01em] break-words">
                {v.name}
              </h2>
              {v.relationship && <p className="text-[19px] leading-6 text-muted-foreground">{v.relationship}</p>}
            </>
          ) : error ? (
            <h2 id={`profile-${personId}`} className="text-headline">
              {error}
            </h2>
          ) : (
            <div className="flex flex-col gap-2 pt-1" id={`profile-${personId}`} aria-label="Loading profile">
              <Skeleton className="h-6 w-40" />
              <Skeleton className="h-5 w-24" />
            </div>
          )}
        </div>
        <button
          ref={closeRef}
          type="button"
          onClick={onClose}
          aria-label="Close profile"
          className="-mt-1 -mr-1 grid size-11 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <X className="size-6" />
        </button>
      </div>

      {v && (
        <>
          <p className={cn("text-[18px] leading-7", v.description ? "text-foreground" : "text-muted-foreground italic")}>
            {v.descriptionText}
          </p>
          {v.facts.length > 0 && (
            <div>
              <p className="text-footnote font-medium text-muted-foreground">From your conversations</p>
              <ul className="mt-1 list-disc pl-5 text-body">
                {v.facts.map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-footnote text-muted-foreground">{lastVisit ? `Last visit ${lastVisit}` : ""}</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> {v.description ? "Edit" : "Add description"}
            </Button>
          </div>
          <EditPersonDialog
            person={person!}
            open={editing}
            onOpenChange={setEditing}
            onSaved={() => setReload((r) => r + 1)}
          />
        </>
      )}
    </div>
  );
}
