"use client";

import { CameraOff } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Shown on the patient view when the webcam can't be opened. Written for a caregiver to act on. */
export default function CameraErrorCard({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 grid place-items-center p-6">
      <div className="flex max-w-md flex-col items-center gap-3 rounded-3xl border bg-card p-8 text-center text-card-foreground">
        <span className="grid size-14 place-items-center rounded-full bg-destructive/10">
          <CameraOff className="size-7 text-destructive" />
        </span>
        <h2 className="text-title">Camera unavailable</h2>
        <p className="text-body text-muted-foreground">
          Allow camera access in the browser (lock icon in the address bar) and close other apps using the webcam.
        </p>
        <p className="text-footnote text-tertiary-foreground">{message}</p>
        <Button size="lg" className="mt-2" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
