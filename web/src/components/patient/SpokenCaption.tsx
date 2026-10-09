"use client";

import { useEffect, useState } from "react";
import { Volume2 } from "lucide-react";

export type Spoken = { id: number; text: string };

/** Roughly how long the brief takes to say (Piper at a slightly slow pace), plus time to read it. */
function displayMs(text: string) {
  return Math.min(20_000, Math.max(4_000, 2_500 + text.length * 75));
}

/**
 * Large caption of what the app is saying to the patient. Shown even when there's no audio
 * (Piper not ready, or speakers off), so the reminder still reaches them. Hides by itself.
 */
export default function SpokenCaption({ spoken }: { spoken: Spoken | null }) {
  const [visible, setVisible] = useState<Spoken | null>(null);

  useEffect(() => {
    if (!spoken) return;
    setVisible(spoken);
    const id = setTimeout(() => setVisible((v) => (v?.id === spoken.id ? null : v)), displayMs(spoken.text));
    return () => clearTimeout(id);
  }, [spoken]);

  if (!visible) return null;
  return (
    // Sits in the bottom stack (above the name card), so it never covers the name tags floating over faces.
    <div className="pointer-events-none flex w-full justify-center" aria-live="polite">
      <p
        key={visible.id}
        className="flex max-w-3xl items-start gap-3 rounded-3xl border border-black/5 bg-card px-7 py-5 text-[26px] leading-snug font-semibold text-card-foreground animate-in fade-in-0 slide-in-from-bottom-2 duration-200"
      >
        <Volume2 className="mt-1.5 size-7 shrink-0 text-primary" aria-hidden />
        {visible.text}
      </p>
    </div>
  );
}
