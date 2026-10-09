"use client";

import { Volume2 } from "lucide-react";

/** The one big control on the patient view: asks the app to say who's in front of the camera. */
export default function WhoButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-20 items-center gap-3 rounded-full bg-primary px-12 text-[28px] font-semibold tracking-tight text-primary-foreground transition-transform duration-150 ease-out outline-none hover:bg-primary/90 focus-visible:ring-4 focus-visible:ring-white/70 active:scale-[0.97]"
    >
      <Volume2 className="size-8" strokeWidth={2.25} />
      Who&apos;s this?
    </button>
  );
}
