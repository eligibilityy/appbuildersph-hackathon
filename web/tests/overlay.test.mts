// Patient overlay: scan visuals follow the real recognition state, tags open the right profile,
// and the profile card shows only saved data. Run from web/: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { drawTag, stepScans, syncScans, syncTags, tagTargets, type Ctx, type Scan, type Tag } from "../src/lib/nameTags.ts";
import { NO_DESCRIPTION, profileView } from "../src/lib/profile.ts";
import type { FaceBox } from "../src/lib/server.ts";
import type { PersonDetail } from "../src/lib/api.ts";

const FRAME = { w: 640, h: 480 };
const VIEW = { w: 1280, h: 960 };
const pending = (box: FaceBox["box"]): FaceBox => ({ box, person_id: null, name: null, relationship: null, is_unknown: null, score: 0.3 });
const unknown = (box: FaceBox["box"]): FaceBox => ({ box, person_id: 9, name: "Unknown #1", relationship: null, is_unknown: true, score: 0.6 });
const known = (box: FaceBox["box"], id = 1, name = "Miguel"): FaceBox => ({ box, person_id: id, name, relationship: "grandson", is_unknown: false, score: 0.7 });

function animate(scans: Scan[], from: number, to: number) {
  let s = scans;
  for (let t = from + 16; t <= to; t += 16) s = stepScans(s, t, 16);
  return s;
}

test("a face not confirmed yet gets a scan, never a name tag", () => {
  const faces = [pending([200, 150, 300, 270])];
  const scans = syncScans([], faces, 0);
  assert.equal(scans.length, 1);
  assert.equal(scans[0].kind, "pending");
  assert.equal(tagTargets(faces).length, 0);
});

test("an Unknown face gets the neutral scan state, not a name", () => {
  const scans = syncScans([], [unknown([200, 150, 300, 270])], 0);
  assert.equal(scans[0].kind, "unknown");
  assert.equal(tagTargets([unknown([200, 150, 300, 270])]).length, 0);
});

test("when the server confirms the person, the scan resolves and the name tag takes over", () => {
  let scans = syncScans([], [pending([200, 150, 300, 270])], 0);
  scans = animate(scans, 0, 300);
  assert.ok(scans[0].alpha > 0.9);
  const confirmed = [known([204, 152, 304, 272])];
  scans = syncScans(scans, confirmed, 300);
  assert.equal(scans[0].resolving, true);
  const tags = syncTags(new Map<string, Tag>(), tagTargets(confirmed), 300);
  assert.equal(tags.size, 1);
  scans = animate(scans, 300, 700);
  assert.equal(scans.length, 0, "scan gone shortly after confirmation");
});

test("scans stay on their own faces when two people are scanned at once", () => {
  let scans = syncScans([], [pending([40, 150, 140, 270]), pending([480, 150, 580, 270])], 0);
  const [a, b] = scans.map((s) => s.id);
  // both move a little; the update lists them in the opposite order
  scans = syncScans(scans, [pending([488, 152, 588, 272]), pending([46, 150, 146, 270])], 200);
  assert.equal(scans.length, 2);
  const left = scans.find((s) => s.id === a)!;
  const right = scans.find((s) => s.id === b)!;
  assert.deepEqual(left.target, [46, 150, 146, 270]);
  assert.deepEqual(right.target, [488, 152, 588, 272]);
});

test("stale scans are cleaned up when the face leaves", () => {
  let scans = syncScans([], [pending([200, 150, 300, 270])], 0);
  scans = animate(scans, 0, 300);
  scans = animate(scans, 300, 1400); // no more updates
  assert.equal(scans.length, 0);
});

test("each name tag carries its own person id (so a click opens the right profile)", () => {
  const targets = tagTargets([known([40, 150, 140, 270], 1, "Miguel"), known([480, 150, 580, 270], 2, "Ana")]);
  assert.deepEqual(targets.map((t) => [t.name, t.personId]), [["Miguel", 1], ["Ana", 2]]);
});

test("the selected tag is outlined in cyan; others stay white; still no face box", () => {
  const calls: { fn: string; style?: unknown }[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get: (t, p: string) =>
      p in t ? t[p] : p === "measureText" ? (s: string) => ({ width: s.length * 20 }) : (...a: unknown[]) => calls.push({ fn: p, style: a.length ? undefined : t.strokeStyle }),
    set: (t, p: string, v) => ((t[p] = v), true),
  }) as unknown as Ctx;
  const tags = syncTags(new Map<string, Tag>(), tagTargets([known([200, 150, 300, 270])]), 0);
  const tag = tags.get("p1")!;
  tag.alpha = 1;
  drawTag(ctx, tag, FRAME, VIEW, false, true);
  assert.equal(state.strokeStyle, "rgba(34, 211, 238, 1)");
  drawTag(ctx, tag, FRAME, VIEW, false, false);
  assert.equal(state.strokeStyle, "rgba(255, 255, 255, 0.95)");
  assert.equal(calls.some((c) => ["strokeRect", "rect", "fillRect"].includes(c.fn)), false);
});

function detail(over: Partial<PersonDetail> = {}): PersonDetail {
  return {
    id: 1, name: "Miguel Santos", relationship: "grandson", notes: null, is_unknown: 0, name_source: "enrolled",
    created_at: "2026-10-09T10:00:00", visits: [], facts: [], embedding_count: 5, ...over,
  };
}

test("profile card: missing description shows the friendly message, never made-up text", () => {
  const v = profileView(detail());
  assert.equal(v.description, null);
  assert.equal(v.descriptionText, NO_DESCRIPTION);
  assert.equal(profileView(detail({ notes: "   " })).description, null);
  assert.equal(v.lastVisitAt, null);
  assert.deepEqual(v.facts, []);
});

test("profile card: name, relationship and description stay in their own fields", () => {
  const v = profileView(detail({ notes: "Enjoys basketball." }));
  assert.equal(v.name, "Miguel Santos");
  assert.equal(v.relationship, "Grandson");
  assert.equal(v.description, "Enjoys basketball.");
  assert.equal(v.descriptionText, "Enjoys basketball.");
});

test("profile card: last visit is the latest FINISHED visit; at most 3 facts", () => {
  const v = profileView(detail({
    visits: [
      { id: 3, person_id: 1, started_at: "2026-10-09T12:00:00", ended_at: null, transcript: null, summary: null, processed: 0 },
      { id: 1, person_id: 1, started_at: "2026-10-07T09:00:00", ended_at: "2026-10-07T09:30:00", transcript: null, summary: null, processed: 1 },
      { id: 2, person_id: 1, started_at: "2026-10-08T09:00:00", ended_at: "2026-10-08T09:30:00", transcript: null, summary: null, processed: 1 },
    ],
    facts: ["a", "b", "c", "d"].map((f, i) => ({ id: i, person_id: 1, visit_id: 1, fact: f, created_at: "" })),
  }));
  assert.equal(v.lastVisitAt, "2026-10-08T09:00:00");
  assert.deepEqual(v.facts, ["a", "b", "c"]);
});
