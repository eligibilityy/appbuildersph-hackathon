"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { grabFrame, useCamera } from "@/lib/camera";
import { FaceBox, ServerEvent, useServerSocket } from "@/lib/server";

const FPS = 5;
const CARD_HOLD_MS = 3000; // keep the name card up briefly after the face drops out, to avoid flicker

type Card = { name: string; relationship: string | null };

export default function PatientView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const frameSize = useRef({ w: 640, h: 480 });
  const facesRef = useRef<FaceBox[]>([]);
  const cardSeenAt = useRef(0);
  const [card, setCard] = useState<Card | null>(null);

  const camError = useCamera(videoRef);

  const onEvent = useCallback((e: ServerEvent) => {
    if (e.type === "faces") {
      facesRef.current = e.faces;
      drawOverlay();
      // Name card: the largest confirmed, known face.
      const known = e.faces
        .filter((f) => f.person_id !== null && !f.is_unknown && f.name)
        .sort((a, b) => area(b.box) - area(a.box))[0];
      if (known) {
        cardSeenAt.current = Date.now();
        setCard((c) =>
          c?.name === known.name && c?.relationship === known.relationship
            ? c
            : { name: known.name!, relationship: known.relationship },
        );
      }
    }
  }, []);

  const { wsRef, connected } = useServerSocket(onEvent);

  // Send ~5 fps JPEG frames.
  useEffect(() => {
    grabRef.current = document.createElement("canvas");
    const id = setInterval(() => {
      const ws = wsRef.current;
      const video = videoRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN || !video) return;
      if (ws.bufferedAmount > 1_000_000) return; // don't pile up frames
      const f = grabFrame(video, grabRef.current!);
      if (!f) return;
      frameSize.current = { w: f.width, h: f.height };
      ws.send(JSON.stringify({ type: "frame", ts: Date.now(), jpeg: f.dataUrl.split(",")[1] }));
    }, 1000 / FPS);
    return () => clearInterval(id);
  }, [wsRef]);

  // Hide the card once nobody known has been seen for a moment.
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - cardSeenAt.current > CARD_HOLD_MS) setCard(null);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Redraw on resize.
  useEffect(() => {
    const onResize = () => drawOverlay();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const replay = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "replay_brief" }));
  }, [wsRef]);

  // Spacebar = "Who's this?"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        replay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replay]);

  function drawOverlay() {
    const canvas = overlayRef.current;
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
    const { w: fw, h: fh } = frameSize.current;
    const s = Math.max(cw / fw, ch / fh);
    const ox = (cw - fw * s) / 2;
    const oy = (ch - fh * s) / 2;

    for (const f of facesRef.current) {
      const [x1, y1, x2, y2] = f.box;
      const x = ox + x1 * s;
      const y = oy + y1 * s;
      const w = (x2 - x1) * s;
      const h = (y2 - y1) * s;
      const known = f.person_id !== null && !f.is_unknown;
      const color = known ? "#22c55e" : f.person_id !== null ? "#f59e0b" : "#94a3b8";
      ctx.lineWidth = 4;
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);

      const label = f.person_id === null ? "…" : f.name ?? "Unknown";
      ctx.font = "600 22px system-ui, sans-serif";
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 32, tw + 16, 32);
      ctx.fillStyle = "#000";
      ctx.fillText(label, x + 8, y - 9);
    }
  }

  return (
    <main className="fixed inset-0 bg-black text-white overflow-hidden select-none">
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" muted playsInline />
      <canvas ref={overlayRef} className="absolute inset-0 h-full w-full pointer-events-none" />

      <div
        className={`absolute top-4 right-4 h-4 w-4 rounded-full ${connected ? "bg-green-500" : "bg-red-600"}`}
        title={connected ? "Connected" : "Not connected to local server"}
      />

      {camError && (
        <div className="absolute inset-x-0 top-1/3 mx-auto w-fit rounded-xl bg-red-700 px-6 py-4 text-2xl">
          Camera unavailable: {camError}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-6 p-8">
        {card && (
          <div className="rounded-3xl bg-white px-12 py-8 text-center text-black shadow-2xl">
            <div className="text-7xl font-bold leading-tight">{card.name}</div>
            {card.relationship && (
              <div className="mt-2 text-5xl text-neutral-700">your {card.relationship}</div>
            )}
          </div>
        )}
        <button
          onClick={replay}
          className="rounded-full bg-yellow-400 px-16 py-6 text-5xl font-bold text-black shadow-xl active:scale-95"
        >
          Who&apos;s this?
        </button>
      </div>
    </main>
  );
}

function area(b: [number, number, number, number]) {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
