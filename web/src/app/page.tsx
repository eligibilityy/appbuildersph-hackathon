"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Users, VolumeX } from "lucide-react";
import ConnectionStatus from "@/components/app/ConnectionStatus";
import FaceOverlay, { TagAnchor } from "@/components/FaceOverlay";
import CameraErrorCard from "@/components/patient/CameraErrorCard";
import DateClock from "@/components/patient/DateClock";
import MicMeter from "@/components/patient/MicMeter";
import PersonProfileCard from "@/components/patient/PersonProfileCard";
import SpeechBubble, { Spoken } from "@/components/patient/SpeechBubble";
import WhoButton from "@/components/patient/WhoButton";
import { onSoundBlocked, playSpeech, startMicrophone, unlockSound } from "@/lib/audio";
import { grabFrame, useCamera } from "@/lib/camera";
import { isNameable } from "@/lib/nameTags";
import { api } from "@/lib/api";
import { FaceBox, ServerEvent, serverUrl, useServerSocket } from "@/lib/server";
import { useWakeLock } from "@/lib/useWakeLock";
import { cn } from "@/lib/utils";

const FPS = 5;
const PROFILE_HOLD_MS = 8000; // close an open profile card once its person has been out of view this long

export default function PatientView() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const grabRef = useRef<HTMLCanvasElement | null>(null);
  const [frameSize, setFrameSize] = useState({ w: 640, h: 480 });
  const [faces, setFaces] = useState<FaceBox[]>([]);
  const facesRef = useRef<FaceBox[]>([]);
  const [selected, setSelected] = useState<{ personId: number; anchor: TagAnchor } | null>(null);
  const [profileVersion, setProfileVersion] = useState(0);
  const [spoken, setSpoken] = useState<Spoken | null>(null); // what the app is saying right now
  const [soundBlocked, setSoundBlocked] = useState(false);
  const [micOff, setMicOff] = useState(false);
  const [voiceMissing, setVoiceMissing] = useState(false);
  const [transcribing, setTranscribing] = useState(false); // server has live transcription on (FEATURE_AUDIO)
  const [openVisits, setOpenVisits] = useState<Set<number>>(new Set()); // the server keeps mic audio only while one is open
  const seenAt = useRef(new Map<number, number>()); // person_id -> last time a confirmed face was in view
  const selectedRef = useRef<number | null>(null);
  selectedRef.current = selected?.personId ?? null;

  const camError = useCamera(videoRef);
  useWakeLock();

  const onEvent = useCallback((e: ServerEvent) => {
    if (e.type === "faces") {
      setFaces(e.faces);
      facesRef.current = e.faces;
      const now = Date.now();
      for (const f of e.faces) if (f.person_id !== null && !f.is_unknown) seenAt.current.set(f.person_id, now);
    } else if (e.type === "speak") {
      // Always show the words; play the audio when the server could make it.
      if (e.text) setSpoken({ id: Date.now(), text: e.text, personId: e.person_id ?? null });
      if (e.audio_url) playSpeech(e.audio_url);
    } else if (e.type === "visit_start" || e.type === "visit_end") {
      setOpenVisits((prev) => {
        const next = new Set(prev);
        if (e.type === "visit_start") next.add(e.visit_id);
        else next.delete(e.visit_id);
        return next;
      });
    } else if (e.type === "memory_updated" && e.person_id === selectedRef.current) {
      setProfileVersion((v) => v + 1); // edited, merged or deleted elsewhere: refresh the open card
    }
  }, []);

  const { wsRef, connected } = useServerSocket(onEvent);

  // Can the server speak (Piper voice files present) and transcribe? Which visits are already open?
  // Checked on each (re)connect.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    fetch(`${serverUrl()}/health`, { cache: "no-store" })
      .then((r) => r.json())
      .then((h) => {
        if (cancelled) return;
        setVoiceMissing(h.voice === false);
        setTranscribing(h.features?.audio === true);
      })
      .catch(() => {});
    api
      .visits()
      .then((all) => !cancelled && setOpenVisits(new Set(all.filter((v) => !v.ended_at).map((v) => v.id))))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [connected]);

  // Browsers block sound until the page has been clicked once. Any tap or key turns it on.
  useEffect(() => onSoundBlocked(setSoundBlocked), []);
  useEffect(() => {
    window.addEventListener("pointerdown", unlockSound);
    window.addEventListener("keydown", unlockSound);
    return () => {
      window.removeEventListener("pointerdown", unlockSound);
      window.removeEventListener("keydown", unlockSound);
    };
  }, []);

  // The worklet streams mic PCM to the same local socket as the camera. It stops with this page.
  useEffect(() => {
    let cancelled = false;
    let stop: (() => void) | null = null;
    startMicrophone(() => wsRef.current)
      .then((cleanup) => {
        if (cancelled) cleanup();
        else stop = cleanup;
        setMicOff(false);
      })
      .catch((error) => {
        console.warn("[audio] microphone unavailable:", error);
        if (!cancelled) setMicOff(true);
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [wsRef]);

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

  // Close a profile whose person has left.
  useEffect(() => {
    const id = setInterval(() => {
      const sel = selectedRef.current;
      if (sel !== null && Date.now() - (seenAt.current.get(sel) ?? 0) > PROFILE_HOLD_MS) setSelected(null);
    }, 500);
    return () => clearInterval(id);
  }, []);

  // Tag positions are relative to the camera view; the profile card is placed in page coordinates.
  const selectPerson = useCallback((personId: number, anchor: TagAnchor) => {
    const r = panelRef.current?.getBoundingClientRect();
    const dx = r?.left ?? 0;
    const dy = r?.top ?? 0;
    setSelected((s) =>
      s?.personId === personId
        ? null
        : { personId, anchor: { x: anchor.x + dx, top: anchor.top + dy, bottom: anchor.bottom + dy } },
    );
  }, []);
  const closeProfile = useCallback(() => setSelected(null), []);

  const replay = useCallback(() => {
    // Nobody recognized in view: answer right away instead of staying silent.
    if (!facesRef.current.some(isNameable)) {
      setSpoken({ id: Date.now(), text: "I don't see anyone I know right now.", personId: null });
      return;
    }
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
    <main className="fixed inset-0 flex flex-col overflow-hidden bg-background text-foreground select-none">
      <header className="flex items-start justify-between gap-4 px-6 pt-5 pb-3">
        <DateClock />
        {/* Status for the caregiver, kept small: the patient doesn't need to act on it. */}
        <nav aria-label="Status and navigation" className="flex flex-wrap items-center justify-end gap-2">
          {soundBlocked && (
            <Chip as="button" tone="warning" onClick={unlockSound}>
              <VolumeX className="size-3.5" /> Tap to turn on sound
            </Chip>
          )}
          {voiceMissing && (
            <Chip tone="warning" title="Piper voice files are missing from /models. Briefs show as text only.">
              <VolumeX className="size-3.5" /> Voice off
            </Chip>
          )}
          {transcribing && <MicMeter visitOpen={openVisits.size > 0} failed={micOff} />}
          <ConnectionStatus online={connected} />
          <Link
            href="/caregiver"
            className="inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-footnote font-medium text-muted-foreground transition-colors duration-150 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <Users className="size-3.5" /> Caregiver
          </Link>
        </nav>
      </header>

      {/* The camera keeps a fixed 16:9 shape: as wide as fits, unless the height runs out first (cq units). */}
      <section
        aria-label="Camera"
        className="relative flex min-h-0 flex-1 items-center justify-center px-6 py-2 [container-type:size]"
      >
        <div
          ref={panelRef}
          className="relative aspect-video w-[min(100cqw,calc(100cqh*16/9))] max-w-4xl overflow-hidden rounded-[28px] bg-black ring-1 ring-black/10"
        >
          <FaceOverlay
            videoRef={videoRef}
            faces={faces}
            frameSize={frameSize}
            selectedPersonId={selected?.personId ?? null}
            onSelectPerson={selectPerson}
          />
        </div>
        {camError && <CameraErrorCard message={camError} />}
      </section>

      <footer className="flex justify-center px-6 pt-3 pb-6">
        <WhoButton onClick={replay} />
      </footer>

      <SpeechBubble spoken={spoken} faces={faces} frameSize={frameSize} panelRef={panelRef} />
      {selected && (
        <PersonProfileCard
          key={selected.personId}
          personId={selected.personId}
          anchor={selected.anchor}
          version={profileVersion}
          onClose={closeProfile}
        />
      )}
    </main>
  );
}

function Chip({
  as = "span",
  tone,
  className,
  ...props
}: { as?: "span" | "button"; tone?: "warning" } & React.HTMLAttributes<HTMLElement>) {
  const Tag = as;
  return (
    <Tag
      {...(as === "button" ? { type: "button" as const } : { role: "status" })}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border bg-card px-3 text-footnote font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        tone === "warning" ? "border-warning/40 text-[#a35d00]" : "text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
