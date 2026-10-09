// Name tag logic tests. Run from web/:  npm test   (Node >= 22.18 runs TypeScript directly)
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  drawTag,
  isNameable,
  mapBox,
  placeTag,
  stepTags,
  syncTags,
  TAG_FADE_OUT_MS,
  TAG_HOLD_MS,
  tagTargets,
  type Box,
  type Ctx,
  type Tag,
} from "../src/lib/nameTags.ts";
import type { FaceBox } from "../src/lib/server.ts";

const FRAME = { w: 640, h: 480 };
const VIEW = { w: 1280, h: 960 };

function face(over: Partial<FaceBox>): FaceBox {
  return { box: [200, 150, 300, 270], person_id: 1, name: "Miguel", relationship: "grandson",
    is_unknown: false, score: 0.7, ...over };
}

/** Records every canvas call so we can check what was (and wasn't) drawn. */
function recorder() {
  const calls: { fn: string; args: unknown[] }[] = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === "measureText") return (s: string) => ({ width: s.length * 20 });
      return (...args: unknown[]) => calls.push({ fn: prop, args });
    },
    set(target, prop: string, value) {
      target[prop] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as Ctx, calls };
}

function run(tags: Map<string, Tag>, from: number, to: number, step = 16) {
  for (let t = from + step; t <= to; t += step) stepTags(tags, t, step);
}

test("only confirmed, known people get a tag", () => {
  assert.equal(isNameable(face({})), true);
  assert.equal(isNameable(face({ person_id: null, name: null, is_unknown: null })), false); // not sure yet
  assert.equal(isNameable(face({ is_unknown: true, name: "Unknown #2" })), false); // never shown to the patient
  const targets = tagTargets([face({}), face({ person_id: 5, is_unknown: true, name: "Unknown #1" }),
    face({ person_id: null, name: null })]);
  assert.deepEqual(targets.map((t) => t.name), ["Miguel"]);
});

test("a confirmed person's tag shows only the name and draws no box around the face", () => {
  const tags = syncTags(new Map(), tagTargets([face({})]), 0);
  run(tags, 0, 500);
  const { ctx, calls } = recorder();
  const p = drawTag(ctx, tags.get("p1")!, FRAME, VIEW);
  const texts = calls.filter((c) => c.fn === "fillText").map((c) => c.args[0]);
  assert.deepEqual(texts, ["Miguel"]); // no relationship, no score, no "Unknown"
  for (const banned of ["strokeRect", "rect", "fillRect", "roundRect"]) {
    assert.equal(calls.some((c) => c.fn === banned), false, `${banned} was called`);
  }
  // The tag never overlaps the face (eyes/mouth stay visible).
  const [, fy1, , fy2] = mapBox([200, 150, 300, 270], FRAME, VIEW);
  assert.ok(p.top + p.height <= fy1 || p.top >= fy2, "tag overlaps the face");
});

test("tag sits above the head, or under the chin when there's no room above", () => {
  const above = placeTag([400, 300, 600, 540], 120, 40, VIEW);
  assert.equal(above.below, false);
  assert.ok(above.top + above.height < 300);
  const below = placeTag([400, 10, 600, 250], 120, 40, VIEW);
  assert.equal(below.below, true);
  assert.ok(below.top > 250);
  const edge = placeTag([0, 300, 80, 400], 300, 40, VIEW); // face at the screen edge: tag stays on screen
  assert.ok(edge.left >= 0 && edge.left + edge.width <= VIEW.w);
});

test("multiple people each keep their own name tag at their own face", () => {
  const faces = [
    face({ box: [40, 150, 140, 270], person_id: 1, name: "Miguel" }),
    face({ box: [480, 150, 580, 270], person_id: 2, name: "Ana" }),
  ];
  const tags = syncTags(new Map(), tagTargets(faces), 0);
  run(tags, 0, 400);
  assert.equal(tags.size, 2);
  const left = mapBox(tags.get("p1")!.box, FRAME, VIEW);
  const right = mapBox(tags.get("p2")!.box, FRAME, VIEW);
  assert.ok(left[0] < right[0]);
  assert.equal(tags.get("p1")!.name, "Miguel");
  assert.equal(tags.get("p2")!.name, "Ana");
  // They swap places: each name follows its own person (keyed by person_id), not the screen position.
  syncTags(tags, tagTargets([
    face({ box: [480, 150, 580, 270], person_id: 1, name: "Miguel" }),
    face({ box: [40, 150, 140, 270], person_id: 2, name: "Ana" }),
  ]), 400);
  run(tags, 400, 1400);
  assert.ok(mapBox(tags.get("p1")!.box, FRAME, VIEW)[0] > mapBox(tags.get("p2")!.box, FRAME, VIEW)[0]);
});

test("tag survives a brief detection dropout without flickering", () => {
  const tags = syncTags(new Map(), tagTargets([face({})]), 0);
  run(tags, 0, 400);
  syncTags(tags, tagTargets([face({})]), 400); // last frame that saw the face
  assert.equal(tags.get("p1")!.alpha, 1);
  run(tags, 400, 400 + TAG_HOLD_MS - 50); // a few missed frames
  assert.equal(tags.get("p1")!.alpha, 1, "tag faded during a short gap");
});

test("stale tags fade out and are removed after the face leaves", () => {
  const tags = syncTags(new Map(), tagTargets([face({}), face({ person_id: 2, name: "Ana", box: [400, 100, 500, 220] })]), 0);
  run(tags, 0, 400);
  syncTags(tags, tagTargets([face({ person_id: 2, name: "Ana", box: [400, 100, 500, 220] })]), 400); // Miguel left
  run(tags, 400, 400 + TAG_HOLD_MS + TAG_FADE_OUT_MS + 100);
  assert.equal(tags.has("p1"), false, "stale tag still on screen");
  assert.equal(tags.has("p2"), false); // Ana got no further updates either
});

test("tag glides toward a moving face instead of jumping", () => {
  const tags = syncTags(new Map(), tagTargets([face({ box: [100, 150, 200, 270] })]), 0);
  syncTags(tags, tagTargets([face({ box: [300, 150, 400, 270] })]), 16);
  stepTags(tags, 32, 16);
  const x = tags.get("p1")!.box[0];
  assert.ok(x > 100 && x < 300, `expected an in-between position, got ${x}`);
  run(tags, 32, 1000);
  assert.ok(Math.abs(tags.get("p1")!.box[0] - 300) < 1);
});

test("frame -> screen mapping handles object-cover cropping and mirroring", () => {
  const b: Box = [0, 0, 640, 480];
  // 4:3 frame in a 16:9 view: scaled by 2, cropped top and bottom by 120 px
  assert.deepEqual(mapBox(b, FRAME, { w: 1280, h: 720 }), [0, -120, 1280, 840]);
  // 4:3 frame in a tall view: cropped left and right
  const [x1, , x2] = mapBox([320, 0, 320, 0], FRAME, { w: 600, h: 900 });
  assert.equal(x1, 300);
  assert.equal(x2, 300);
  // mirrored: a face on the left of the frame is drawn on the right
  const m = mapBox([0, 0, 100, 100], FRAME, VIEW, true);
  assert.deepEqual(m, [1280 - 200, 0, 1280, 200]);
});

test("identity changes on a tracked face update the label in place", () => {
  const tags = syncTags(new Map(), tagTargets([face({ name: "Miguel" })]), 0);
  syncTags(tags, tagTargets([face({ name: "Miguel Santos" })]), 100);
  assert.equal(tags.get("p1")!.name, "Miguel Santos");
  assert.equal(tags.size, 1);
});
