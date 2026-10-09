// Holographic face-scan visuals (canvas). Pure drawing helpers, shared by the enrollment camera and the
// patient overlay. Every effect is tied to a real state: a face the detector found, a frame being
// checked, a photo actually captured, or an identity the server hasn't confirmed yet. No flashing or
// strobing: the scan line is a slow (2.8 s) sweep, and with reduced motion it doesn't move at all.
import type { Box } from "./nameTags";

export const HOLO = {
  cyan: "34, 211, 238", // rgb triplets so alpha can vary
  teal: "45, 212, 191",
  white: "255, 255, 255",
  amber: "251, 191, 36",
};

const SWEEP_MS = 2800;

export type Ellipse = { cx: number; cy: number; rx: number; ry: number };

/** A face-shaped oval around a (view-space) face box. Detector boxes are tight, so pad them. */
export function faceEllipse(b: Box, pad = 1): Ellipse {
  const w = b[2] - b[0];
  const h = b[3] - b[1];
  return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2 - h * 0.04, rx: w * 0.62 * pad, ry: h * 0.7 * pad };
}

/** 0..1 position of the scan line: a slow ease-in-out sweep down and back up. */
export function sweep(t: number): number {
  const p = (t % SWEEP_MS) / SWEEP_MS;
  return 0.5 - 0.5 * Math.cos(p * 2 * Math.PI);
}

type Ctx = CanvasRenderingContext2D;

function ellipsePath(ctx: Ctx, e: Ellipse) {
  ctx.beginPath();
  ctx.ellipse(e.cx, e.cy, Math.max(1, e.rx), Math.max(1, e.ry), 0, 0, Math.PI * 2);
}

/** Faint grid + moving scan band, clipped to the oval. */
function scanInside(ctx: Ctx, e: Ellipse, t: number, rgb: string, alpha: number, reducedMotion: boolean) {
  ctx.save();
  ellipsePath(ctx, e);
  ctx.clip();
  // fine dot grid
  ctx.fillStyle = `rgba(${rgb}, ${0.1 * alpha})`;
  const step = Math.max(10, Math.round(e.rx / 7));
  for (let y = e.cy - e.ry; y <= e.cy + e.ry; y += step) {
    for (let x = e.cx - e.rx; x <= e.cx + e.rx; x += step) ctx.fillRect(x, y, 1.5, 1.5);
  }
  if (!reducedMotion) {
    const y = e.cy - e.ry + sweep(t) * 2 * e.ry;
    const band = Math.max(18, e.ry * 0.22);
    const g = ctx.createLinearGradient(0, y - band, 0, y + 2);
    g.addColorStop(0, `rgba(${rgb}, 0)`);
    g.addColorStop(1, `rgba(${rgb}, ${0.28 * alpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(e.cx - e.rx, y - band, e.rx * 2, band + 2);
    ctx.fillStyle = `rgba(${rgb}, ${0.85 * alpha})`;
    ctx.fillRect(e.cx - e.rx, y, e.rx * 2, 1.5);
  }
  ctx.restore();
}

/** Glowing oval outline with four small ticks (top/right/bottom/left). */
function contour(ctx: Ctx, e: Ellipse, rgb: string, alpha: number, width = 2) {
  ctx.save();
  ctx.shadowColor = `rgba(${rgb}, ${0.8 * alpha})`;
  ctx.shadowBlur = 14;
  ctx.strokeStyle = `rgba(${rgb}, ${0.85 * alpha})`;
  ctx.lineWidth = width;
  ellipsePath(ctx, e);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.lineWidth = width + 1;
  const tick = Math.max(6, e.rx * 0.08);
  for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]] as const) {
    const x = e.cx + dx * e.rx;
    const y = e.cy + dy * e.ry;
    ctx.beginPath();
    ctx.moveTo(x + dx * 4, y + dy * 4);
    ctx.lineTo(x + dx * (4 + tick), y + dy * (4 + tick));
    ctx.stroke();
  }
  ctx.restore();
}

export type EnrollScanOpts = {
  t: number;
  progress: number; // captured / total
  verifying: number; // 0..1 how close to an automatic capture (stable frames)
  capturedAgo: number; // ms since the last capture (Infinity if none)
  turn: "left" | "right" | null; // in the person's own terms
  mirrored: boolean; // preview is mirrored, so "their left" is screen-left
  warn: boolean; // something to fix (amber)
  reducedMotion: boolean;
};

/** Enrollment: oval + scan sweep around the detected face, progress arc, capture pulse, turn arrows. */
export function drawEnrollScan(ctx: Ctx, face: Box, o: EnrollScanOpts) {
  const e = faceEllipse(face, 1.05);
  const rgb = o.warn ? HOLO.amber : HOLO.cyan;
  scanInside(ctx, e, o.t, rgb, o.warn ? 0.5 : 1, o.reducedMotion);
  contour(ctx, e, rgb, 1);

  // Progress of photos taken: a teal arc around the oval, starting at the top.
  const ring: Ellipse = { ...e, rx: e.rx + 9, ry: e.ry + 9 };
  ctx.save();
  ctx.strokeStyle = `rgba(${HOLO.white}, 0.18)`;
  ctx.lineWidth = 4;
  ellipsePath(ctx, ring);
  ctx.stroke();
  if (o.progress > 0) {
    ctx.strokeStyle = `rgba(${HOLO.teal}, 0.95)`;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.ellipse(ring.cx, ring.cy, ring.rx, ring.ry, 0, -Math.PI / 2, -Math.PI / 2 + Math.min(1, o.progress) * Math.PI * 2);
    ctx.stroke();
  }
  // "Hold still" fill-up while frames are being verified before an automatic capture.
  if (o.verifying > 0) {
    ctx.strokeStyle = `rgba(${HOLO.white}, 0.9)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(e.cx, e.cy, e.rx - 6, e.ry - 6, 0, -Math.PI / 2, -Math.PI / 2 + o.verifying * Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();

  // Capture confirmation: a soft teal glow that fades over 600 ms (one gentle pulse, not a flash).
  if (o.capturedAgo < 600) {
    const a = 1 - o.capturedAgo / 600;
    ctx.save();
    ellipsePath(ctx, e);
    ctx.fillStyle = `rgba(${HOLO.teal}, ${0.22 * a})`;
    ctx.fill();
    contour(ctx, e, HOLO.teal, a, 3);
    ctx.restore();
  }

  if (o.turn) {
    // Person's own left is screen-left in a mirrored preview.
    const screenDir = (o.turn === "left") === o.mirrored ? -1 : 1;
    const shift = o.reducedMotion ? 0 : (sweep(o.t) - 0.5) * 10;
    const x0 = e.cx + screenDir * (e.rx + 26 + shift);
    const s = Math.max(10, e.ry * 0.12);
    ctx.save();
    ctx.strokeStyle = `rgba(${HOLO.cyan}, 0.95)`;
    ctx.lineWidth = 4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (let i = 0; i < 2; i++) {
      const x = x0 + screenDir * i * s * 0.9;
      ctx.globalAlpha = i ? 0.55 : 1;
      ctx.beginPath();
      ctx.moveTo(x - screenDir * s * 0.5, e.cy - s);
      ctx.lineTo(x + screenDir * s * 0.5, e.cy);
      ctx.lineTo(x - screenDir * s * 0.5, e.cy + s);
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Enrollment, no face yet: a dashed guide oval in the middle of the view. */
export function drawGuideOval(ctx: Ctx, w: number, h: number) {
  const ry = h * 0.31;
  const e: Ellipse = { cx: w / 2, cy: h / 2, rx: ry * 0.75, ry };
  ctx.save();
  ctx.setLineDash([8, 8]);
  ctx.strokeStyle = `rgba(${HOLO.white}, 0.55)`;
  ctx.lineWidth = 2;
  ellipsePath(ctx, e);
  ctx.stroke();
  ctx.restore();
}

/** Patient view: a face that's being checked (pending) or checked and not known (unknown). */
export function drawFaceScan(ctx: Ctx, face: Box, kind: "pending" | "unknown", alpha: number, t: number, reducedMotion: boolean) {
  if (alpha <= 0) return;
  const e = faceEllipse(face);
  ctx.save();
  ctx.globalAlpha = alpha;
  if (kind === "pending") {
    scanInside(ctx, e, t, HOLO.cyan, 0.8, reducedMotion);
    contour(ctx, e, HOLO.cyan, 0.7, 1.5);
  } else {
    // Neutral: a faint, still outline. No sweep, no name, nothing that looks like "recognised".
    ctx.setLineDash([3, 7]);
    ctx.strokeStyle = `rgba(${HOLO.white}, 0.35)`;
    ctx.lineWidth = 1.5;
    ellipsePath(ctx, e);
    ctx.stroke();
  }
  ctx.restore();
}
