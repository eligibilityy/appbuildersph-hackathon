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
export type TagTarget = { key: string; personId: number; name: string; box: Box };
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
    out.push({ key, personId: f.person_id!, name: f.name!, box: [...f.box] as Box });
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

/** Readable but compact (the camera view is no longer full screen): scales with the face, within limits. */
export function tagFontPx(faceWidthPx: number): number {
  return Math.round(Math.min(40, Math.max(22, faceWidthPx * 0.24)));
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
 *  No box is drawn around the face itself. `selected` = its profile card is open (cyan outline). */
export function drawTag(ctx: Ctx, tag: Tag, frame: Size, view: Size, mirrored = false, selected = false): Placement {
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
  ctx.lineWidth = Math.max(2.5, fontPx * 0.08) * (selected ? 1.4 : 1);
  ctx.lineJoin = "round";
  ctx.strokeStyle = selected ? "rgba(34, 211, 238, 1)" : "rgba(255, 255, 255, 0.95)";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(tag.name, left + width / 2, top + height / 2 + fontPx * 0.04);
  ctx.restore();
  return p;
}

// --- Scanning state for faces that don't have a confirmed name (yet) ---
//
// "pending": the server hasn't confirmed who this is (person_id null) - it really is still matching.
// "unknown": checked and saved as an Unknown - shown neutrally, never with a name.
// There's no track id in the faces event, so scans follow faces by box overlap (IoU) between updates.

export type ScanKind = "pending" | "unknown";
export type Scan = { id: number; kind: ScanKind; box: Box; target: Box; alpha: number; lastSeen: number; resolving: boolean };

export const SCAN_HOLD_MS = 500;
const SCAN_FADE_MS = 250;
const MATCH_IOU = 0.2;
let nextScanId = 1;

export function iou(a: Box, b: Box): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (inter <= 0) return 0;
  return inter / ((a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter);
}

/** Apply a server update to the scans. A scan whose face became a confirmed person starts resolving
 *  (fades out quickly) while that person's name tag fades in. */
export function syncScans(scans: Scan[], faces: FaceBox[], now: number): Scan[] {
  const used = new Set<Scan>();
  const best = (box: Box) => {
    let pick: Scan | null = null;
    let score = MATCH_IOU;
    for (const s of scans) {
      if (used.has(s) || s.resolving) continue;
      const v = iou(s.target, box);
      if (v >= score) [pick, score] = [s, v];
    }
    return pick;
  };
  for (const f of faces) {
    const box = [...f.box] as Box;
    const scan = best(box);
    if (isNameable(f)) {
      if (scan) {
        scan.resolving = true;
        used.add(scan);
      }
      continue;
    }
    const kind: ScanKind = f.person_id !== null && f.is_unknown ? "unknown" : "pending";
    if (scan) {
      Object.assign(scan, { kind, target: box, lastSeen: now });
      used.add(scan);
    } else {
      const s: Scan = { id: nextScanId++, kind, box: [...box] as Box, target: box, alpha: 0, lastSeen: now, resolving: false };
      scans.push(s);
      used.add(s);
    }
  }
  return scans;
}

/** Advance scans by dt ms; returns the scans still visible. */
export function stepScans(scans: Scan[], now: number, dt: number): Scan[] {
  const k = 1 - Math.exp(-Math.max(0, dt) / GLIDE_MS);
  for (const s of scans) {
    for (let i = 0; i < 4; i++) s.box[i] += (s.target[i] - s.box[i]) * k;
    const present = !s.resolving && now - s.lastSeen <= SCAN_HOLD_MS;
    s.alpha = present ? Math.min(1, s.alpha + dt / TAG_FADE_IN_MS) : Math.max(0, s.alpha - dt / SCAN_FADE_MS);
  }
  return scans.filter((s) => s.alpha > 0 || (!s.resolving && now - s.lastSeen <= SCAN_HOLD_MS));
}
