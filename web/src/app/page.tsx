"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import ConnectionStatus from "@/components/app/ConnectionStatus";
import FaceOverlay from "@/components/FaceOverlay";
import NameCard from "@/components/NameCard";
import CameraErrorCard from "@/components/patient/CameraErrorCard";
import WhoButton from "@/components/patient/WhoButton";
import { playSpeech } from "@/lib/audio";
import { grabFrame, useCamera } from "@/lib/camera";
import { FaceBox, ServerEvent, useServerSocket } from "@/lib/server";

const FPS = 5;
const CARD_HOLD_MS = 3000; // keep the name card up briefly after the face drops out, to avoid flicker

type Card = { name: string; relationship: string | null };

export default function PatientView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 640, h: 480 });
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const cardSeenAt = useRef(0);

  const camError = useCamera(videoRef);

  const onEvent = useCallback((e: ServerEvent) => {
    if (e.type === "faces") {
      setFaces(e.faces);
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
    } else if (e.type === "speak" && e.audio_url) {
      playSpeech(e.audio_url);
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
      setFrameSize((s) => (s.w === f.width && s.h === f.height ? s : { w: f.width, h: f.height }));
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

  return (
    <main className="fixed inset-0 select-none overflow-hidden bg-black text-white">
      <FaceOverlay videoRef={videoRef} faces={faces} frameSize={frameSize} />

      <ConnectionStatus online={connected} className="absolute left-4 top-4" />

      {camError && <CameraErrorCard message={camError} />}

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-6 p-8">
        {card && <NameCard name={card.name} relationship={card.relationship} />}
        <WhoButton onClick={replay} />
      </div>
    </main>
  );
}

function area(b: [number, number, number, number]) {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
