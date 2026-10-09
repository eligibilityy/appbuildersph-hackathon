"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Users } from "lucide-react";
import ConnectionStatus from "@/components/app/ConnectionStatus";
import FaceOverlay, { TagAnchor } from "@/components/FaceOverlay";
import NameCard from "@/components/NameCard";
import CameraErrorCard from "@/components/patient/CameraErrorCard";
import PersonProfileCard from "@/components/patient/PersonProfileCard";
import SpokenCaption, { Spoken } from "@/components/patient/SpokenCaption";
import WhoButton from "@/components/patient/WhoButton";
import { playSpeech } from "@/lib/audio";
import { grabFrame, useCamera } from "@/lib/camera";
import { FaceBox, ServerEvent, useServerSocket } from "@/lib/server";

const FPS = 5;
const CARD_HOLD_MS = 3000; // keep the name card up briefly after the face drops out, to avoid flicker
const PROFILE_HOLD_MS = 8000; // close an open profile card once its person has been out of view this long

type Card = { name: string; relationship: string | null };

export default function PatientView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 640, h: 480 });
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const [card, setCard] = useState<Card | null>(null);
  const cardSeenAt = useRef(0);
  const [selected, setSelected] = useState<{ personId: number; anchor: TagAnchor } | null>(null);
  const [profileVersion, setProfileVersion] = useState(0);
  const [spoken, setSpoken] = useState<Spoken | null>(null); // what the app is saying right now
  const seenAt = useRef(new Map<number, number>()); // person_id -> last time a confirmed face was in view
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected?.personId ?? null;

  const camError = useCamera(videoRef);

  const onEvent = useCallback((e: ServerEvent) => {
    if (e.type === "faces") {
      setFaces(e.faces);
      const now = Date.now();
      for (const f of e.faces) if (f.person_id !== null && !f.is_unknown) seenAt.current.set(f.person_id, now);
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
    } else if (e.type === "speak") {
      // Always show the words; play the audio when the server could make it.
      if (e.text) setSpoken({ id: Date.now(), text: e.text });
      if (e.audio_url) playSpeech(e.audio_url);
    } else if (e.type === "memory_updated" && e.person_id === selectedRef.current) {
      setProfileVersion((v) => v + 1); // edited, merged or deleted elsewhere: refresh the open card
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

  // Hide the card once nobody known has been seen for a moment; close a profile whose person has left.
  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - cardSeenAt.current > CARD_HOLD_MS) setCard(null);
      const sel = selectedRef.current;
      if (sel !== null && Date.now() - (seenAt.current.get(sel) ?? 0) > PROFILE_HOLD_MS) setSelected(null);
    }, 500);
    return () => clearInterval(id);
  }, []);

  const selectPerson = useCallback((personId: number, anchor: TagAnchor) => {
    setSelected((s) => (s?.personId === personId ? null : { personId, anchor }));
  }, []);
  const closeProfile = useCallback(() => setSelected(null), []);

  const replay = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "replay_brief" }));
  }, [wsRef]);

  // Spacebar = "Who's this?"
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      // Leave Space alone in text fields, on focused buttons (name tags) and inside dialogs.
      if (t?.closest?.("input, textarea, select, button, [contenteditable], [role=dialog]")) return;
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
      <FaceOverlay
        videoRef={videoRef}
        faces={faces}
        frameSize={frameSize}
        selectedPersonId={selected?.personId ?? null}
        onSelectPerson={selectPerson}
      />
      {selected && (
        <PersonProfileCard
          key={selected.personId}
          personId={selected.personId}
          anchor={selected.anchor}
          version={profileVersion}
          onClose={closeProfile}
        />
      )}

      {/* Top bar: connection status + a way to the caregiver dashboard (kept small: the patient doesn't need it). */}
      <nav aria-label="View navigation" className="absolute left-4 top-4 z-20 flex flex-wrap items-center gap-2">
        <ConnectionStatus online={connected} />
        <Link
          href="/caregiver"
          className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-footnote font-medium text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Users className="size-3.5" /> Caregiver dashboard
        </Link>
      </nav>

      {camError && <CameraErrorCard message={camError} />}

      <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-6 p-8">
        <SpokenCaption spoken={spoken} />
        {card && <NameCard name={card.name} relationship={card.relationship} />}
        <WhoButton onClick={replay} />
      </div>
    </main>
  );
}

function area(b: [number, number, number, number]) {
  return (b[2] - b[0]) * (b[3] - b[1]);
}
