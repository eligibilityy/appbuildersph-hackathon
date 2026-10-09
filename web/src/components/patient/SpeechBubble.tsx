"use client";

import { RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Volume2 } from "lucide-react";
import { BubblePlacement, placeBubble, speakerFace } from "@/lib/bubble";
import { Box, mapBox } from "@/lib/nameTags";
import { FaceBox } from "@/lib/server";
import { cn } from "@/lib/utils";

/** What the app is saying. `personId` = who it's about (null for messages not about a face). */
export type Spoken = { id: number; text: string; personId: number | null };

const FACE_LOST_HOLD_MS = 1200; // ride out a missed detection or two before docking the bubble

/** Roughly how long the brief takes to say (Piper at a slightly slow pace), plus time to read it. */
function displayMs(text: string) {
  return Math.min(20_000, Math.max(4_000, 2_500 + text.length * 75));
}

type Pos = { left: number; top: number; side: BubblePlacement["side"] | "dock"; tail: number };

/**
 * The words the app is saying, in a speech bubble beside the visitor's face (never on it), following
 * them as they move. With no face to point at, it docks at the bottom of the camera view. Shown even
 * without audio (voice not ready, speakers off), so the reminder still reaches the patient.
 */
export default function SpeechBubble({
  spoken,
  faces,
  frameSize,
  panelRef,
}: {
  spoken: Spoken | null;
  faces: FaceBox[];
  frameSize: { w: number; h: number };
  /** The camera view the face boxes are drawn in. */
  panelRef: RefObject<HTMLElement | null>;
}) {
  const [visible, setVisible] = useState<Spoken | null>(null);
  const [pos, setPos] = useState<Pos | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const lastFace = useRef<{ box: Box; at: number } | null>(null);
  const [viewport, setViewport] = useState(0); // bumps on resize

  useEffect(() => {
    if (!spoken) return;
    setVisible(spoken);
    lastFace.current = null;
    const id = setTimeout(() => setVisible((v) => (v?.id === spoken.id ? null : v)), displayMs(spoken.text));
    return () => clearTimeout(id);
  }, [spoken]);

  useEffect(() => {
    const onResize = () => setViewport((n) => n + 1);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    const panel = panelRef.current;
    if (!visible || !el || !panel) return;
    const rect = panel.getBoundingClientRect();
    const size = { w: el.offsetWidth, h: el.offsetHeight };
    const now = Date.now();

    const face = speakerFace(faces, visible.personId, visible.text);
    if (face) {
      const [x1, y1, x2, y2] = mapBox(face.box, frameSize, { w: rect.width, h: rect.height });
      lastFace.current = { box: [x1 + rect.left, y1 + rect.top, x2 + rect.left, y2 + rect.top], at: now };
    }
    const held = lastFace.current && now - lastFace.current.at < FACE_LOST_HOLD_MS ? lastFace.current.box : null;
    const placed = held ? placeBubble(held, size, { w: window.innerWidth, h: window.innerHeight }) : null;
    const next: Pos = placed ?? {
      left: rect.left + (rect.width - size.w) / 2,
      top: rect.bottom - size.h - 20,
      side: "dock",
      tail: 0,
    };
    setPos((p) =>
      p && Math.abs(p.left - next.left) < 1 && Math.abs(p.top - next.top) < 1 && p.side === next.side ? p : next,
    );
  }, [visible, faces, frameSize, panelRef, viewport]);

  if (!visible) return null;
  return (
    <div
      ref={ref}
      aria-live="polite"
      className={cn(
        "pointer-events-none fixed top-0 left-0 z-30 w-max max-w-[min(360px,calc(100vw-24px))]",
        "transition-transform duration-200 ease-out motion-reduce:transition-none",
        !pos && "invisible",
      )}
      style={{ transform: `translate3d(${pos?.left ?? 0}px, ${pos?.top ?? 0}px, 0)` }}
    >
      <p
        key={visible.id}
        className="relative flex items-start gap-2.5 rounded-2xl bg-card px-4 py-3 text-[20px] leading-snug font-semibold text-card-foreground shadow-[0_8px_28px_rgba(0,0,0,0.28)] ring-1 ring-black/5 animate-in fade-in-0 zoom-in-95 duration-200"
      >
        <Volume2 className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
        <span>{visible.text}</span>
        {pos && pos.side !== "dock" && <Tail side={pos.side} at={pos.tail} />}
      </p>
    </div>
  );
}

/** Small rotated square on the edge facing the visitor. */
function Tail({ side, at }: { side: BubblePlacement["side"]; at: number }) {
  const style =
    side === "right"
      ? { left: -6, top: at - 6 }
      : side === "left"
        ? { right: -6, top: at - 6 }
        : side === "below"
          ? { top: -6, left: at - 6 }
          : { bottom: -6, left: at - 6 };
  return <span aria-hidden className="absolute size-3 rotate-45 rounded-[2px] bg-card" style={style} />;
}
