"use client";

import { RefObject, useEffect, useRef, useState } from "react";
import { FaceBox } from "@/lib/server";
import { drawFaceScan } from "@/lib/holo";
import { drawTag, mapBox, Placement, Scan, stepScans, stepTags, syncScans, syncTags, Tag, tagTargets } from "@/lib/nameTags";
import { useReducedMotion } from "@/lib/useReducedMotion";

export type TagAnchor = { x: number; top: number; bottom: number };

type Props = {
  videoRef: RefObject<HTMLVideoElement | null>;
  faces: FaceBox[];
  /** Size of the frame the server saw (boxes are in these pixel coordinates). */
  frameSize: { w: number; h: number };
  /** Set if the <video> is shown mirrored (scale-x -1), so tags stay on the right face. */
  mirrored?: boolean;
  /** Person whose profile card is open (their tag gets a cyan outline). */
  selectedPersonId?: number | null;
  /** Click / Enter on a name tag. `anchor` is the tag's position in the overlay, for placing a card. */
  onSelectPerson?: (personId: number, anchor: TagAnchor) => void;
};

type TagButton = { key: string; personId: number; name: string };

/**
 * Full-size camera video + canvas overlay:
 *  - a face the server hasn't confirmed yet -> subtle holographic scan (no name),
 *  - a face saved as Unknown -> faint neutral outline (no name),
 *  - a confirmed, known person -> clickable name tag (the scan fades out as the tag fades in).
 * No boxes are drawn. Animation only runs while something is on screen.
 */
export default function FaceOverlay({ videoRef, faces, frameSize, mirrored = false, selectedPersonId = null, onSelectPerson }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tags = useRef(new Map<string, Tag>());
  const scans = useRef<Scan[]>([]);
  const placements = useRef(new Map<string, Placement>());
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const [tagButtons, setTagButtons] = useState<TagButton[]>([]);
  const buttonSig = useRef("");
  const raf = useRef<number | null>(null);
  const last = useRef(0);
  const reducedMotion = useReducedMotion();
  const view = useRef({ frameSize, mirrored, selectedPersonId, reducedMotion });
  view.current = { frameSize, mirrored, selectedPersonId, reducedMotion };

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
      const dt = now - last.current;
      last.current = now;
      stepTags(tags.current, now, dt);
      scans.current = stepScans(scans.current, now, dt);

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
      const { frameSize: frame, mirrored: m, selectedPersonId: sel, reducedMotion: rm } = view.current;
      const viewSize = { w: cw, h: ch };

      for (const s of scans.current) drawFaceScan(ctx, mapBox(s.box, frame, viewSize, m), s.kind, s.alpha, now, rm);

      placements.current.clear();
      for (const tag of tags.current.values()) {
        const p = drawTag(ctx, tag, frame, viewSize, m, tag.personId === sel);
        placements.current.set(tag.key, p);
        const el = buttons.current.get(tag.key);
        if (el) {
          el.style.transform = `translate(${p.left}px, ${p.top}px)`;
          el.style.width = `${p.width}px`;
          el.style.height = `${p.height}px`;
          el.style.pointerEvents = tag.alpha > 0.5 ? "auto" : "none";
        }
      }

      // Re-render the buttons only when the set of tags (or a name) changes.
      const list = [...tags.current.values()].map((t) => ({ key: t.key, personId: t.personId, name: t.name }));
      const sig = list.map((t) => `${t.key}:${t.name}`).join("|");
      if (sig !== buttonSig.current) {
        buttonSig.current = sig;
        setTagButtons(list);
      }

      raf.current = tags.current.size > 0 || scans.current.length > 0 ? requestAnimationFrame(tick) : null;
    };
    raf.current = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const now = performance.now();
    syncTags(tags.current, tagTargets(faces), now);
    syncScans(scans.current, faces, now);
    if (tags.current.size > 0 || scans.current.length > 0) start.current();
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
      <div className="pointer-events-none absolute inset-0">
        {tagButtons.map((t) => (
          <button
            key={t.key}
            ref={(el) => {
              if (el) buttons.current.set(t.key, el);
              else buttons.current.delete(t.key);
            }}
            type="button"
            data-name-tag
            aria-label={`Show ${t.name}'s profile`}
            aria-pressed={selectedPersonId === t.personId}
            onClick={() => {
              const p = placements.current.get(t.key);
              if (p) onSelectPerson?.(t.personId, { x: p.left + p.width / 2, top: p.top, bottom: p.top + p.height });
            }}
            className="absolute top-0 left-0 rounded-full outline-none focus-visible:ring-4 focus-visible:ring-cyan-300"
            style={{ pointerEvents: "none" }}
          />
        ))}
      </div>
    </>
  );
}
