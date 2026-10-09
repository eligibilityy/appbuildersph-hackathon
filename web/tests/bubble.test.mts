// Speech bubble placement: next to the visitor's face, never covering it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placeBubble, speakerFace } from "../src/lib/bubble.ts";
import type { Box } from "../src/lib/nameTags.ts";

const VIEW = { w: 1280, h: 800 };
const SIZE = { w: 360, h: 120 };

function overlaps(face: Box, p: { left: number; top: number }, size = SIZE) {
  return p.left < face[2] && p.left + size.w > face[0] && p.top < face[3] && p.top + size.h > face[1];
}
function onScreen(p: { left: number; top: number }, size = SIZE) {
  return p.left >= 0 && p.top >= 0 && p.left + size.w <= VIEW.w && p.top + size.h <= VIEW.h;
}

test("bubble goes beside the face on the roomier side, without covering it", () => {
  const leftFace: Box = [200, 250, 400, 500];
  const p = placeBubble(leftFace, SIZE, VIEW)!;
  assert.equal(p.side, "right");
  assert.ok(!overlaps(leftFace, p) && onScreen(p));

  const rightFace: Box = [900, 250, 1100, 500];
  const q = placeBubble(rightFace, SIZE, VIEW)!;
  assert.equal(q.side, "left");
  assert.ok(!overlaps(rightFace, q) && onScreen(q));
});

test("a face filling the width puts the bubble under the chin, then above", () => {
  const wide: Box = [100, 100, 1180, 500];
  const p = placeBubble(wide, SIZE, VIEW)!;
  assert.equal(p.side, "below");
  assert.ok(!overlaps(wide, p) && onScreen(p));

  const low: Box = [100, 400, 1180, 780];
  const q = placeBubble(low, SIZE, VIEW)!;
  assert.equal(q.side, "above");
  assert.ok(!overlaps(low, q) && onScreen(q));
});

test("no spot that leaves the face visible -> null (caller docks the caption instead)", () => {
  assert.equal(placeBubble([0, 0, 1280, 800], SIZE, VIEW), null);
});

test("the tail points at the face and stays off the rounded corners", () => {
  const face: Box = [200, 20, 400, 200]; // near the top: bubble is clamped down, tail still aims at the face
  const p = placeBubble(face, SIZE, VIEW)!;
  assert.equal(p.side, "right");
  assert.ok(p.tail >= 22 && p.tail <= SIZE.h - 22);
});

test("speakerFace finds the visitor by id, or by the name the brief starts with", () => {
  const faces = [
    { person_id: 1, name: "Ana", is_unknown: false },
    { person_id: 2, name: "Miguel", is_unknown: false },
    { person_id: 3, name: "Unknown #1", is_unknown: true },
  ];
  assert.equal(speakerFace(faces, 2, "anything")?.name, "Miguel");
  assert.equal(speakerFace(faces, 9, "This is Miguel, your grandson."), null);
  assert.equal(speakerFace(faces, undefined, "This is Miguel, your grandson.")?.person_id, 2);
  assert.equal(speakerFace(faces, null, "Hello"), null);
});
