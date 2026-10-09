// Floating name tags for the patient view: pure logic (no React), so it can be unit-tested with
// `npm test`. FaceOverlay owns the canvas and the animation loop; everything else lives here.
//
// Rules:
//  - Only confirmed, known people get a tag (no Unknowns, no "not sure yet" faces).
//  - One tag per person, keyed by person_id, so names never jump between faces.
//  - Positions are kept in FRAME pixels and mapped to the screen at draw time, so a window resize
//    or a different video aspect ratio never misplaces a tag.
//  - Tags glide to new positions, survive a few missed detections, then fade out.
import type { FaceBox } from "./server";

export type Box = [number, number, number, number];
export type Size = { w: number; h: number };
export type TagTarget = { key: string; name: string; box: Box };
export type Tag = TagTarget & { target: Box; alpha: number; lastSeen: number };
export type Placement = {
  left: number;
  top: number;
  width: number;
  height: number;
  pointerX: number;
  below: boolean; // true when there's no room above the head, so the tag sits under the chin
};

export const TAG_HOLD_MS = 800; // keep a tag through a few missed frames (frames arrive at ~5 fps)
export const TAG_FADE_IN_MS = 180;
export const TAG_FADE_OUT_MS = 300;
const GLIDE_MS = 90; // time constant for smoothing positions between server updates
const EDGE = 8; // keep tags this far from the screen edge

/** Only confirmed, known people are named on the patient view. */
export function isNameable(f: FaceBox): boolean {
  return f.person_id !== null && !f.is_unknown && !!f.name;
}

/** Frame pixels -> view pixels for an `object-cover` video (optionally mirrored). */
export function mapBox(box: Box, frame: Size, view: Size, mirrored = false): Box {
  const s = Math.max(view.w / frame.w, view.h / frame.h);
  const ox = (view.w - frame.w * s) / 2;
  const oy = (view.h - frame.h * s) / 2;
  let x1 = ox + box[0] * s;
  let x2 = ox + box[2] * s;
  if (mirrored) [x1, x2] = [view.w - x2, view.w - x1];
  return [x1, oy + box[1] * s, x2, oy + box[3] * s];
}

/** Faces from one server event -> the tags that should be on screen. */
export function tagTargets(faces: FaceBox[]): TagTarget[] {
  const out: TagTarget[] = [];
  const seen = new Map<string, number>();
  for (const f of faces) {
    if (!isNameable(f)) continue;
    let key = `p${f.person_id}`;
    const n = seen.get(key) ?? 0; // same person twice (e.g. a photo of them): keep both, distinct keys
    seen.set(key, n + 1);
    if (n) key += `#${n}`;
    out.push({ key, name: f.name!, box: [...f.box] as Box });
  }
  return out;
}

/** Apply a server update: move existing tags' targets, add new tags (invisible, fading in). */
export function syncTags(tags: Map<string, Tag>, targets: TagTarget[], now: number): Map<string, Tag> {
  for (const t of targets) {
    const tag = tags.get(t.key);
    if (tag) {
      tag.target = t.box;
      tag.name = t.name;
      tag.lastSeen = now;
    } else {
      tags.set(t.key, { ...t, box: [...t.box] as Box, target: t.box, alpha: 0, lastSeen: now });
    }
  }
  return tags;
}

/** Advance the animation by dt ms: glide, fade, and drop tags whose face has gone. */
export function stepTags(tags: Map<string, Tag>, now: number, dt: number): void {
  const k = 1 - Math.exp(-Math.max(0, dt) / GLIDE_MS);
  for (const [key, tag] of tags) {
    for (let i = 0; i < 4; i++) tag.box[i] += (tag.target[i] - tag.box[i]) * k;
    const present = now - tag.lastSeen <= TAG_HOLD_MS;
    tag.alpha = present
      ? Math.min(1, tag.alpha + dt / TAG_FADE_IN_MS)
      : Math.max(0, tag.alpha - dt / TAG_FADE_OUT_MS);
    if (!present && tag.alpha <= 0) tags.delete(key);
  }
}

/** Large, readable: scales with the face, within limits. */
export function tagFontPx(faceWidthPx: number): number {
  return Math.round(Math.min(64, Math.max(34, faceWidthPx * 0.3)));
}

/** Where to draw a tag of the given text width for a face box (view pixels). Never overlaps the face. */
export function placeTag(face: Box, textW: number, fontPx: number, view: Size): Placement {
  const [x1, y1, x2, y2] = face;
  const height = Math.round(fontPx * 1.55);
  const width = Math.min(view.w - 2 * EDGE, textW + fontPx * 1.3);
  const gap = Math.max(10, (y2 - y1) * 0.1) + fontPx * 0.35; // room for the pointer
  const cx = (x1 + x2) / 2;
  let top = y1 - gap - height;
  let below = false;
  if (top < EDGE) {
    top = y2 + gap;
    below = true;
  }
  top = Math.min(top, view.h - height - EDGE);
  const left = Math.min(Math.max(cx - width / 2, EDGE), view.w - width - EDGE);
  const r = height / 2;
  const pointerX = Math.min(Math.max(cx, left + r), left + width - r);
  return { left, top, width, height, pointerX, below };
}

/** The subset of CanvasRenderingContext2D we draw with (so tests can pass a recorder). */
export type Ctx = Pick<
  CanvasRenderingContext2D,
  | "save" | "restore" | "beginPath" | "closePath" | "moveTo" | "lineTo" | "arcTo" | "fill" | "stroke"
  | "fillText" | "measureText" | "font" | "fillStyle" | "strokeStyle" | "lineWidth" | "lineJoin"
  | "globalAlpha" | "shadowColor" | "shadowBlur" | "shadowOffsetY" | "textBaseline" | "textAlign"
>;

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

/** Draw one name tag: a dark rounded pill with a white outline and a small pointer toward the face.
 *  No box is drawn around the face itself. */
export function drawTag(ctx: Ctx, tag: Tag, frame: Size, view: Size, mirrored = false): Placement {
  const face = mapBox(tag.box, frame, view, mirrored);
  let fontPx = tagFontPx(face[2] - face[0]);
  ctx.font = `700 ${fontPx}px ${FONT}`;
  let textW = ctx.measureText(tag.name).width;
  while (textW + fontPx * 1.3 > view.w - 2 * EDGE && fontPx > 18) {
    fontPx -= 2; // very long name on a narrow screen: shrink rather than clip
    ctx.font = `700 ${fontPx}px ${FONT}`;
    textW = ctx.measureText(tag.name).width;
  }
  const p = placeTag(face, textW, fontPx, view);
  const { left, top, width, height } = p;
  const r = height / 2;
  const ph = fontPx * 0.3; // pointer height
  const pw = fontPx * 0.32; // pointer half-width
  const tipY = p.below ? top - ph : top + height + ph;
  const baseY = p.below ? top : top + height;

  ctx.save();
  ctx.globalAlpha = tag.alpha;
  ctx.beginPath();
  ctx.moveTo(left + r, top);
  if (p.below) {
    ctx.lineTo(p.pointerX - pw, baseY);
    ctx.lineTo(p.pointerX, tipY);
    ctx.lineTo(p.pointerX + pw, baseY);
  }
  ctx.arcTo(left + width, top, left + width, top + height, r);
  ctx.arcTo(left + width, top + height, left, top + height, r);
  if (!p.below) {
    ctx.lineTo(p.pointerX + pw, baseY);
    ctx.lineTo(p.pointerX, tipY);
    ctx.lineTo(p.pointerX - pw, baseY);
  }
  ctx.arcTo(left, top + height, left, top, r);
  ctx.arcTo(left, top, left + width, top, r);
  ctx.closePath();
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "rgba(15, 23, 42, 0.92)"; // near-black: readable on light and dark backgrounds
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.lineWidth = Math.max(2.5, fontPx * 0.08);
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tag.name, left + width / 2, top + height / 2 + fontPx * 0.04);
  ctx.restore();
  return p;
}
