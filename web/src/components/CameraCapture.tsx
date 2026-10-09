"use client";

import { RefObject, useCallback, useEffect, useRef, useState } from "react";
import { Check, CameraOff, X } from "lucide-react";
import { grabFrame, useCamera } from "@/lib/camera";
import { cn } from "@/lib/utils";

/** Per-photo verdict shown on the thumbnail: green ring when ok, red ring + reason when not. */
export type PhotoMark = { ok: boolean; message?: string | null };

/** Live guidance bubble above the shutter, e.g. "Face found - ready". */
export type CaptureHint = { text: string; tone: "ok" | "warn" | "info" };

type Props = {
  /** One instruction per photo slot, e.g. "Look straight at the camera". */
  steps: string[];
  /** Uncontrolled mode: called with the captured photos (JPEG data URLs, slot order) whenever they change. */
  onChange?: (photos: string[]) => void;
  /** Uncontrolled mode: change this value to clear all photos (e.g. after saving). */
  resetKey?: number;

  /** Controlled mode: the parent owns the photos. Pass `slots` + `onCapture` + `onRetake`. */
  slots?: (string | null)[];
  onCapture?: (index: number, dataUrl: string) => void;
  onRetake?: (index: number) => void;

  /** Optional verdict per slot (same indexes as `steps`). */
  marks?: (PhotoMark | null | undefined)[];
  /** Optional live guidance shown over the preview. */
  hint?: CaptureHint | null;
  /** Optional: pass a ref to read frames from the live preview (e.g. for live checks). */
  videoRef?: RefObject<HTMLVideoElement | null>;
  className?: string;
};

const HINT_TONE: Record<CaptureHint["tone"], string> = {
  ok: "bg-success text-white",
  warn: "bg-warning text-black",
  info: "bg-white/90 text-black",
};

/**
 * Guided photo capture, in the spirit of iOS Face ID setup: live mirrored preview, the current
 * instruction, a progress bar, a round shutter button, and a strip of shots you can retake.
 */
export default function CameraCapture({
  steps,
  onChange,
  resetKey = 0,
  slots: controlledSlots,
  onCapture,
  onRetake,
  marks,
  hint,
  videoRef: externalVideoRef,
  className,
}: Props) {
  const internalVideoRef = useRef<HTMLVideoElement>(null);
  const videoRef = externalVideoRef ?? internalVideoRef;
  const grabRef = useRef<HTMLCanvasElement>(null);
  const camError = useCamera(videoRef);
  const [flash, setFlash] = useState(false);

  // Uncontrolled photo state.
  const [ownSlots, setOwnSlots] = useState<(string | null)[]>(() => steps.map(() => null));
  useEffect(() => {
    setOwnSlots(Array.from({ length: steps.length }, () => null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);
  useEffect(() => {
    // Steps added or removed (e.g. glasses toggled): keep the photos already taken.
    setOwnSlots((s) => Array.from({ length: steps.length }, (_, i) => s[i] ?? null));
  }, [steps.length]);
  useEffect(() => {
    if (!controlledSlots) onChange?.(ownSlots.filter((s): s is string => s !== null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ownSlots]);

  const slots = controlledSlots ? steps.map((_, i) => controlledSlots[i] ?? null) : ownSlots;
  const current = slots.findIndex((s) => s === null); // -1 when every slot is filled
  const done = current === -1;
  const taken = slots.filter(Boolean).length;

  const capture = useCallback(() => {
    if (done || !videoRef.current || !grabRef.current) return;
    const f = grabFrame(videoRef.current, grabRef.current, 640, 0.9);
    if (!f) return;
    if (controlledSlots) onCapture?.(current, f.dataUrl);
    else setOwnSlots((s) => s.map((v, i) => (i === current ? f.dataUrl : v)));
    setFlash(true);
    setTimeout(() => setFlash(false), 120);
  }, [current, done, controlledSlots, onCapture, videoRef]);

  const remove = (i: number) => {
    if (controlledSlots) onRetake?.(i);
    else setOwnSlots((s) => s.map((v, j) => (j === i ? null : v)));
  };

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-neutral-900">
        {/* Mirrored so the person can position themselves; captured frames are not mirrored. */}
        <video ref={videoRef} className="h-full w-full -scale-x-100 object-cover" muted playsInline />
        <canvas ref={grabRef} className="hidden" />

        {/* Face guide */}
        {!camError && !done && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <div className="aspect-[3/4] h-[62%] rounded-[50%] border-2 border-dashed border-white/50" />
          </div>
        )}

        {/* Instruction */}
        {!camError && (
          <div className="absolute inset-x-0 top-0 flex flex-col items-center gap-2 p-4">
            <div className="flex w-full max-w-xs gap-1" aria-hidden>
              {slots.map((s, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-150",
                    s ? "bg-white" : i === current ? "bg-white/60" : "bg-white/25",
                  )}
                />
              ))}
            </div>
            <div className="rounded-full bg-black/55 px-4 py-2 text-center text-headline text-white" aria-live="polite">
              {done ? "All photos taken" : steps[current]}
            </div>
          </div>
        )}

        {/* Live hint + shutter */}
        {!camError && (
          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 p-4">
            {!done && hint && (
              <div
                role="status"
                className={cn("rounded-full px-4 py-1.5 text-body font-semibold", HINT_TONE[hint.tone])}
              >
                {hint.text}
              </div>
            )}
            <button
              type="button"
              onClick={capture}
              disabled={done || !!camError}
              aria-label={done ? "All photos taken" : `Take photo ${current + 1} of ${steps.length}`}
              className="grid size-[68px] place-items-center rounded-full border-4 border-white/90 transition-transform duration-150 outline-none focus-visible:ring-4 focus-visible:ring-primary/60 active:scale-95 disabled:opacity-60"
            >
              <span
                className={cn("grid size-[52px] place-items-center rounded-full", done ? "bg-success" : "bg-white")}
              >
                {done && <Check className="size-6 text-white" strokeWidth={3} />}
              </span>
            </button>
          </div>
        )}

        {flash && <div className="pointer-events-none absolute inset-0 bg-white/70" />}

        {camError && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
            <div className="flex max-w-xs flex-col items-center gap-2">
              <CameraOff className="size-8 opacity-80" />
              <p className="text-headline">Camera unavailable</p>
              <p className="text-footnote text-white/70">
                Allow camera access in the browser (lock icon in the address bar), and close other apps using the
                webcam.
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Shots — tap the x to retake one */}
      <div
        className="grid max-w-[560px] gap-2"
        style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 96px))` }}
      >
        {slots.map((s, i) => {
          const mark = s ? marks?.[i] : null;
          return (
            <div
              key={i}
              title={mark?.message ?? (s ? undefined : steps[i])}
              className={cn(
                "relative aspect-square overflow-hidden rounded-xl",
                s ? "bg-muted" : "border border-dashed border-input",
                i === current && "border-solid border-primary ring-3 ring-primary/15",
                mark?.ok === true && "ring-3 ring-success",
                mark?.ok === false && "ring-3 ring-destructive",
              )}
            >
              {s ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    onClick={() => remove(i)}
                    aria-label={`Retake photo ${i + 1}`}
                    className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white outline-none hover:bg-black/75 focus-visible:ring-3 focus-visible:ring-ring/60"
                  >
                    <X className="size-3.5" strokeWidth={2.5} />
                  </button>
                  {mark?.ok === false && mark.message && (
                    <span className="absolute inset-x-0 bottom-0 bg-destructive/90 px-1 py-0.5 text-[11px] leading-tight text-white">
                      {mark.message}
                    </span>
                  )}
                </>
              ) : (
                <span className="grid h-full place-items-center text-footnote text-tertiary-foreground">{i + 1}</span>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-footnote text-muted-foreground">
        {taken} of {steps.length} photos · tap × on a photo to retake it
      </p>
    </div>
  );
}
