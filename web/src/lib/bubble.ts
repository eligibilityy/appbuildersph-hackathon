// Where to put the "This is Miguel, your grandson…" speech bubble: next to the visitor's face,
// never on it. Pure logic (no React), unit-tested in tests/bubble.test.mts.
import type { Box, Size } from "./nameTags";

export type BubbleSide = "right" | "left" | "below" | "above";
export type BubblePlacement = {
  left: number;
  top: number;
  side: BubbleSide;
  /** Where the tail points along the bubble's edge (px from its left for above/below, from its top for left/right). */
  tail: number;
};

const GAP = 18; // between the face and the bubble (room for the tail)
const EDGE = 12; // keep this far from the screen edge
const TAIL_INSET = 22; // keep the tail away from the rounded corners

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Place a bubble of `size` beside `face` (both in the same pixel space, e.g. the viewport).
 * Prefers the side with more room, then below the chin; above the head is last because the name
 * tag usually sits there. Returns null when there is no spot that leaves the face uncovered.
 */
export function placeBubble(face: Box, size: Size, view: Size): BubblePlacement | null {
  const [x1, y1, x2, y2] = face;
  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const { w, h } = size;
  const roomRight = view.w - EDGE - (x2 + GAP);
  const roomLeft = x1 - GAP - EDGE;
  const roomBelow = view.h - EDGE - (y2 + GAP);
  const roomAbove = y1 - GAP - EDGE;

  const beside = (side: "right" | "left"): BubblePlacement => {
    // Line the bubble up with the eyes (upper part of the face box), within the screen.
    const top = clamp(y1 + (y2 - y1) * 0.2 - h * 0.25, EDGE, view.h - h - EDGE);
    const left = side === "right" ? x2 + GAP : x1 - GAP - w;
    return { left, top, side, tail: clamp(cy - top, TAIL_INSET, h - TAIL_INSET) };
  };
  const vertical = (side: "below" | "above"): BubblePlacement => {
    const left = clamp(cx - w / 2, EDGE, view.w - w - EDGE);
    const top = side === "below" ? y2 + GAP : y1 - GAP - h;
    return { left, top, side, tail: clamp(cx - left, TAIL_INSET, w - TAIL_INSET) };
  };

  const sides: ("right" | "left")[] = roomRight >= roomLeft ? ["right", "left"] : ["left", "right"];
  for (const side of sides) if ((side === "right" ? roomRight : roomLeft) >= w) return beside(side);
  if (roomBelow >= h) return vertical("below");
  if (roomAbove >= h) return vertical("above");
  return null;
}

/** The face this brief is about: by person_id, or (older servers) by the name the text starts with. */
export function speakerFace<T extends { person_id: number | null; name: string | null; is_unknown: boolean | null }>(
  faces: T[],
  personId: number | null | undefined,
  text: string,
): T | null {
  if (personId != null) return faces.find((f) => f.person_id === personId) ?? null;
  return faces.find((f) => f.name && !f.is_unknown && text.startsWith(`This is ${f.name}`)) ?? null;
}
