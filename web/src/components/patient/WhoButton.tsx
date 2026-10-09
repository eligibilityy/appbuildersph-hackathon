"use client";

import { Volume2 } from "lucide-react";

/** The one control on the patient view: asks the app to say who's in front of the camera (also: spacebar). */
export default function WhoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-keyshortcuts="Space"
      className="inline-flex h-14 items-center gap-2.5 rounded-full bg-primary bg-primary-gradient px-7 text-[20px] font-semibold tracking-tight text-primary-foreground transition-transform duration-150 ease-out outline-none hover:brightness-110 focus-visible:ring-4 focus-visible:ring-primary/40 active:scale-[0.97]"
    >
      <Volume2 className="size-6" strokeWidth={2.25} aria-hidden />
      Who&apos;s this?
    </button>
  );
}
