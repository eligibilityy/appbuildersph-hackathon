"use client";

import { RefObject, useCallback, useEffect, useRef } from "react";
import { FaceBox } from "@/lib/server";

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  faces: FaceBox[];
  /** Size of the frame the server saw (boxes are in these pixel coordinates). */
  frameSize: { w: number; h: number };
};

/** Full-size camera video with face boxes + names drawn on a canvas on top. */
export default function FaceOverlay({ videoRef, faces, frameSize }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const cw = video.clientWidth;
    const ch = video.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== cw * dpr || canvas.height !== ch * dpr) {
      canvas.width = cw * dpr;
      canvas.height = ch * dpr;
    }
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    // Map frame coords -> displayed coords for an object-cover video.
    const s = Math.max(cw / frameSize.w, ch / frameSize.h);
    const ox = (cw - frameSize.w * s) / 2;
    const oy = (ch - frameSize.h * s) / 2;

    for (const f of faces) {
      const [x1, y1, x2, y2] = f.box;
      const x = ox + x1 * s;
      const y = oy + y1 * s;
      const w = (x2 - x1) * s;
      const h = (y2 - y1) * s;
      // green = known, amber = Unknown #N, grey = not confirmed yet
      const known = f.person_id !== null && !f.is_unknown;
      const color = known ? "#22c55e" : f.person_id !== null ? "#f59e0b" : "#94a3b8";
      ctx.lineWidth = 4;
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);

      const label = f.person_id === null ? "…" : (f.name ?? "Unknown");
      ctx.font = "600 22px system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 32, tw + 16, 32);
      ctx.fillStyle = "#000";
      ctx.fillText(label, x + 8, y - 9);
    }
  }, [faces, frameSize, videoRef]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  return (
    <>
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted playsInline />
      <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" />
    </>
  );
}
