"use client";

import { useEffect, useRef, useState } from "react";
import { CameraOff, Check, RotateCcw, ScanFace, SkipForward, WifiOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import {
  CaptureEvent,
  CaptureState,
  RULES,
  canSkip,
  cameraWanted,
  currentStep,
  instructionText,
  normalizeSignature,
  turnHint,
} from "@/lib/autoCapture";
import { dataUrlToBlob, faceGrey, grabFrame, useCamera } from "@/lib/camera";
import { drawEnrollScan, drawGuideOval } from "@/lib/holo";
import { Box, mapBox } from "@/lib/nameTags";
import { useReducedMotion } from "@/lib/useReducedMotion";
import { cn } from "@/lib/utils";

const CHECK_INTERVAL_MS = 180; // ~5 checks per second, one at a time
const MIRRORED = true; // the preview is mirrored so people can position themselves naturally
const FIX_ME = new Set(["MULTIPLE_FACES", "IMPROVE_LIGHTING", "MOVE_CLOSER", "MOVE_BACK", "CENTER_FACE", "TURN_LESS", "LEVEL_HEAD"]);

type Props = {
  state: CaptureState;
  dispatch: (e: CaptureEvent) => void;
  /** Idle: start button + why it's disabled. */
  canStart: boolean;
  startHint?: string;
  onStart: () => void;
};

/**
 * Hands-free enrollment camera. While scanning, it checks a frame ~5x per second on the local server
 * (/enroll/check) and feeds the result to the capture state machine, which takes photos by itself.
 * The camera is only on while starting/scanning.
 */
export default function AutoEnrollCamera({ state, dispatch, canStart, startHint, onStart }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const wanted = cameraWanted(state);
  const camError = useCamera(videoRef, wanted);
  const reducedMotion = useReducedMotion();
  const [serverDown, setServerDown] = useState(false);
  const [match, setMatch] = useState<string | null>(null);
  const live = useRef({ state, reducedMotion });
  live.current = { state, reducedMotion };

  useEffect(() => {
    if (camError && wanted) dispatch({ type: "CAMERA_ERROR", message: cameraMessage(camError) });
  }, [camError, wanted, dispatch]);

  // Starting: wait until the video actually has frames.
  useEffect(() => {
    if (state.phase !== "starting") return;
    const id = setInterval(() => {
      const v = videoRef.current;
      if (v && v.videoWidth > 0 && v.readyState >= 2) dispatch({ type: "CAMERA_READY", now: performance.now() });
    }, 100);
    return () => clearInterval(id);
  }, [state.phase, dispatch]);

  // Scanning: check one frame at a time and feed it to the state machine.
  useEffect(() => {
    if (state.phase !== "scanning") return;
    let stop = false;
    (async () => {
      while (!stop) {
        const t0 = performance.now();
        const video = videoRef.current;
        const canvas = grabRef.current;
        const f = video && canvas ? grabFrame(video, canvas, 640, 0.85) : null;
        if (f && canvas) {
          try {
            const check = await api.checkFrame(dataUrlToBlob(f.dataUrl));
            if (stop) break;
            setServerDown(false);
            setMatch(check.match && check.faces === 1 ? (check.match.name ?? "someone saved") : null);
            const grey = check.faces === 1 && check.box ? faceGrey(canvas, check.box) : null;
            dispatch({
              type: "OBSERVE",
              now: performance.now(),
              obs: {
                faces: check.faces,
                ok: check.ok,
                reason: check.reason,
                box: check.box,
                pose: check.pose,
                frame: check.frame,
                dataUrl: f.dataUrl,
                signature: grey ? normalizeSignature(grey) : null,
              },
            });
          } catch {
            if (stop) break;
            setServerDown(true); // no checks -> no captures; nothing is taken blindly
          }
        }
        await new Promise((r) => setTimeout(r, Math.max(16, CHECK_INTERVAL_MS - (performance.now() - t0))));
      }
    })();
    return () => {
      stop = true;
    };
  }, [state.phase, dispatch]);

  // Holographic overlay, animated only while the camera is on.
  useEffect(() => {
    if (!wanted) return;
    let raf = 0;
    const smooth: { box: Box | null } = { box: null };
    let last = performance.now();
    const tick = (now: number) => {
      const canvas = overlayRef.current;
      const video = videoRef.current;
      if (canvas && video) {
        const { state: s, reducedMotion: rm } = live.current;
        const cw = video.clientWidth;
        const ch = video.clientHeight;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
          canvas.width = Math.round(cw * dpr);
          canvas.height = Math.round(ch * dpr);
        }
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        if (s.phase === "scanning" && s.face) {
          const target = mapBox(s.face.box, { w: s.face.frame[0], h: s.face.frame[1] }, { w: cw, h: ch }, MIRRORED);
          const k = 1 - Math.exp(-(now - last) / 90);
          smooth.box = smooth.box ? (smooth.box.map((v, i) => v + (target[i] - v) * k) as Box) : target;
          const total = s.steps.length - s.results.filter((r) => r === "skipped").length;
          drawEnrollScan(ctx, smooth.box, {
            t: now,
            progress: total ? s.samples.length / total : 0,
            verifying: s.instruction === "VERIFYING" ? s.stable / RULES.STABLE_FRAMES : 0,
            capturedAgo: s.capturedAt ? now - s.capturedAt : Infinity,
            turn: turnHint(s),
            mirrored: MIRRORED,
            warn: FIX_ME.has(s.instruction),
            reducedMotion: rm,
          });
        } else {
          smooth.box = null;
          drawGuideOval(ctx, cw, ch);
        }
      }
      last = now;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [wanted]);

  const cur = currentStep(state);
  const total = state.steps.length;
  const instruction = instructionText(state);
  const warn = state.phase === "scanning" && FIX_ME.has(state.instruction);

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-neutral-950">
        <video
          ref={videoRef}
          className={cn("h-full w-full -scale-x-100 object-cover transition-opacity duration-300", wanted ? "opacity-100" : "opacity-0")}
          muted
          playsInline
        />
        <canvas ref={grabRef} className="hidden" />
        <canvas ref={overlayRef} className="pointer-events-none absolute inset-0 h-full w-full" />

        {/* Instruction + step dots */}
        {wanted && (
          <div className="absolute inset-x-0 top-0 flex flex-col items-center gap-2 p-4">
            <div className="flex w-full max-w-xs gap-1" aria-hidden>
              {state.results.map((r, i) => (
                <span
                  key={i}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors duration-300",
                    r === "captured" ? "bg-teal-300" : r === "skipped" ? "bg-white/40" : i === cur ? "bg-cyan-200/70" : "bg-white/20",
                  )}
                />
              ))}
            </div>
            <div
              role="status"
              aria-live="polite"
              className={cn(
                "max-w-[90%] rounded-full px-5 py-2 text-center text-[19px] leading-6 font-semibold shadow-lg backdrop-blur-sm transition-colors duration-300",
                state.instruction === "CAPTURED" && state.phase === "scanning"
                  ? "bg-teal-400/90 text-black"
                  : warn
                    ? "bg-amber-300/95 text-black"
                    : "bg-black/60 text-white",
              )}
            >
              {state.instruction === "CAPTURED" && state.phase === "scanning" && <Check className="mr-1.5 inline size-5 align-[-3px]" />}
              {instruction}
            </div>
          </div>
        )}

        {wanted && (serverDown || match) && (
          <div className="absolute inset-x-0 bottom-4 flex justify-center px-4">
            <div
              className={cn(
                "flex items-center gap-2 rounded-full px-4 py-1.5 text-body font-semibold",
                serverDown ? "bg-white/90 text-black" : "bg-amber-300 text-black",
              )}
            >
              {serverDown ? (
                <>
                  <WifiOff className="size-4" /> Can&apos;t reach the local face server — paused
                </>
              ) : (
                <>Looks like {match}, who is already saved</>
              )}
            </div>
          </div>
        )}

        {/* Idle: the camera is off until the caregiver starts the scan. */}
        {state.phase === "idle" && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
            <div className="flex max-w-sm flex-col items-center gap-4">
              <span className="grid size-16 place-items-center rounded-full bg-cyan-400/15 ring-1 ring-cyan-300/40">
                <ScanFace className="size-8 text-cyan-200" />
              </span>
              <div>
                <p className="text-title">Automatic face scan</p>
                <p className="mt-1 text-body text-white/70">
                  The camera takes the photos by itself while the person follows the on-screen prompts: look straight,
                  turn slightly left, then right. Nothing is saved until the scan finishes.
                </p>
              </div>
              <Button size="lg" onClick={onStart} disabled={!canStart} className="min-w-48">
                <ScanFace /> Start face scan
              </Button>
              {!canStart && startHint && <p className="text-footnote text-white/60">{startHint}</p>}
            </div>
          </div>
        )}

        {(state.phase === "complete" || state.phase === "saving" || state.phase === "done") && (
          <div className="absolute inset-0 grid place-items-center bg-neutral-950 p-6">
            <div className="grid w-full max-w-md grid-cols-3 gap-2">
              {state.samples.map((s, i) => (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={s.dataUrl} alt={`Face photo ${i + 1}`} className="aspect-square w-full -scale-x-100 rounded-xl object-cover ring-2 ring-teal-300/70" />
              ))}
            </div>
          </div>
        )}

        {state.phase === "error" && (
          <div className="absolute inset-0 grid place-items-center p-6 text-center text-white">
            <div className="flex max-w-xs flex-col items-center gap-3">
              <CameraOff className="size-8 opacity-80" />
              <p className="text-headline">{state.error}</p>
              <Button variant="secondary" onClick={onStart}>
                <RotateCcw /> Try again
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Photos taken so far (validated by the server before they were accepted). */}
      {state.phase !== "idle" && state.phase !== "error" && (
        <div className="flex flex-wrap items-center gap-2">
          {state.steps.map((step, i) => {
            const sampleIdx = state.samples.findIndex((s) => s.step === i);
            const sample = sampleIdx >= 0 ? state.samples[sampleIdx] : null;
            const r = state.results[i];
            return (
              <div
                key={i}
                title={step.prompt}
                className={cn(
                  "group relative size-16 overflow-hidden rounded-xl",
                  sample ? "ring-2 ring-teal-400" : "border border-dashed border-input",
                  i === cur && state.phase === "scanning" && "border-solid border-primary ring-3 ring-primary/15",
                )}
              >
                {sample ? (
                  <>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={sample.dataUrl} alt={`Photo ${i + 1}`} className="h-full w-full -scale-x-100 object-cover" />
                    {(state.phase === "scanning" || state.phase === "complete") && (
                      <button
                        type="button"
                        onClick={() => dispatch({ type: "RETAKE", sample: sampleIdx, now: performance.now() })}
                        aria-label={`Retake photo ${i + 1}: ${step.prompt}`}
                        className="absolute inset-0 grid place-items-center bg-black/55 text-white opacity-0 transition-opacity duration-150 outline-none group-hover:opacity-100 focus-visible:opacity-100"
                      >
                        <RotateCcw className="size-5" />
                      </button>
                    )}
                  </>
                ) : (
                  <span className="grid h-full place-items-center text-footnote text-tertiary-foreground">
                    {r === "skipped" ? "skipped" : i + 1}
                  </span>
                )}
              </div>
            );
          })}
          {state.phase === "scanning" && canSkip(state) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => dispatch({ type: "SKIP", now: performance.now() })}
              className="text-muted-foreground"
            >
              <SkipForward /> Skip this angle
            </Button>
          )}
        </div>
      )}
      {state.phase === "scanning" && (
        <p className="text-footnote text-muted-foreground">
          Face samples: {state.samples.length} of {total - state.results.filter((r) => r === "skipped").length} · photos are
          taken automatically when the face is steady, sharp and in position
        </p>
      )}
    </div>
  );
}

function cameraMessage(raw: string): string {
  if (/denied|NotAllowed/i.test(raw)) return "Camera access was blocked. Allow the camera in the browser, then try again.";
  if (/NotFound|Requested device not found/i.test(raw)) return "No camera found. Connect a webcam, then try again.";
  if (/NotReadable|in use|Could not start/i.test(raw)) return "The camera is busy in another app. Close it, then try again.";
  return `Camera unavailable: ${raw}`;
}
