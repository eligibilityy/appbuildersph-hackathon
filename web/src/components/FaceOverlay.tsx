"use client";

import { RefObject, useEffect, useRef } from "react";
import { FaceBox } from "@/lib/server";
import { drawTag, stepTags, syncTags, Tag, tagTargets } from "@/lib/nameTags";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  faces: FaceBox[];
  /** Size of the frame the server saw (boxes are in these pixel coordinates). */
  frameSize: { w: number; h: number };
  /** Set if the <video> is shown mirrored (scale-x -1), so tags stay on the right face. */
  mirrored?: boolean;
};

/** Full-size camera video with a floating name tag above each confirmed, known person.
 *  No boxes: the patient only ever sees a name, and only once recognition is confident. */
export default function FaceOverlay({ videoRef, faces, frameSize, mirrored = false }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, Tag>());
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const view = useRef({ frameSize, mirrored });
  view.current = { frameSize, mirrored };

  // Animation loop: runs only while at least one tag is on screen.
  const start = useRef(() => {});
  start.current = () => {
    if (raf.current !== null) return;
    last.current = performance.now();
    const tick = (now: number) => {
      const canvas = canvasRef.current;
      const video = videoRef.current;
      if (!canvas || !video) {
        raf.current = null;
        return;
      }
      stepTags(tags.current, now, now - last.current);
      last.current = now;

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
      const { frameSize: frame, mirrored: m } = view.current;
      for (const tag of tags.current.values()) drawTag(ctx, tag, frame, { w: cw, h: ch }, m);

      raf.current = tags.current.size > 0 ? requestAnimationFrame(tick) : null;
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    syncTags(tags.current, tagTargets(faces), performance.now());
    if (tags.current.size > 0) start.current();
  }, [faces]);

  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    },
    [],
  );

  return (
    <>
      <video
        ref={videoRef}
        className={`absolute inset-0 h-full w-full object-cover ${mirrored ? "-scale-x-100" : ""}`}
        muted
        playsInline
      />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </>
  );
}
