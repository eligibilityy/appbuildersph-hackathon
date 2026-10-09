"use client";

import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { onMicLevel } from "@/lib/audio";
import { cn } from "@/lib/utils";

const BARS = [0.15, 0.35, 0.55, 0.75]; // level each bar lights up at
const DECAY = 0.85; // per update: the meter falls smoothly instead of flickering

/**
 * Small caregiver-facing chip: is the mic hearing anything, and is the audio being kept for transcription?
 * The server only keeps audio while a visit is open (someone is in view), so "Listening" means words will
 * end up in captions; "Waiting for a face" means the mic works but nothing is transcribed yet.
 */
export default function MicMeter({ visitOpen, failed }: { visitOpen: boolean; failed: boolean }) {
  const [level, setLevel] = useState(0);
  const [paused, setPaused] = useState(false);
  const peak = useRef(0);

  useEffect(
    () =>
      onMicLevel(({ level: l, sending }) => {
        peak.current = Math.max(l, peak.current * DECAY);
        setLevel(peak.current);
        setPaused(!sending);
      }),
    [],
  );

  if (failed) {
    return (
      <span
        role="status"
        title="Allow microphone access to record conversations."
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-warning/40 bg-card px-3 text-footnote font-medium text-[#a35d00]"
      >
        <MicOff className="size-3.5" /> Mic off
      </span>
    );
  }

  const label = paused ? "Paused while speaking" : visitOpen ? "Listening" : "Mic on · waiting for a face";
  return (
    <span
      role="status"
      aria-label={`Microphone: ${label}`}
      title={
        visitOpen
          ? "Someone is in view: what's said is transcribed into their visit."
          : "The mic works. Speech is only transcribed while someone is in view."
      }
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-footnote font-medium",
        visitOpen && !paused ? "border-success/40 text-[#1f7a35]" : "text-muted-foreground",
      )}
    >
      <Mic className="size-3.5" />
      <span className="flex h-3.5 items-end gap-[3px]" aria-hidden>
        {BARS.map((at, i) => (
          <span
            key={i}
            className={cn(
              "w-[3px] rounded-full transition-colors duration-100",
              level >= at ? (visitOpen && !paused ? "bg-success" : "bg-primary") : "bg-border",
            )}
            style={{ height: `${40 + i * 20}%` }}
          />
        ))}
      </span>
      {label}
    </span>
  );
}
