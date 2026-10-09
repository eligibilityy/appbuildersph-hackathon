// Automatic enrollment capture state machine. Run from web/: npm test
// These use mocked frame checks: they prove the capture RULES, not real webcam head-pose accuracy.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSteps,
  cameraWanted,
  canSkip,
  captureReducer,
  initialState,
  instructionText,
  normalizeSignature,
  RULES,
  signatureDistance,
  type CaptureEvent,
  type CaptureState,
  type Observation,
} from "../src/lib/autoCapture.ts";

let sigSeed = 1;
/** A face signature that is clearly different from every other one made by this helper. */
function freshSig(): number[] {
  const seed = sigSeed++;
  return normalizeSignature(Array.from({ length: 256 }, (_, i) => Math.sin(i * (seed * 0.37 + 0.11)) * 100 + 128));
}

function obs(over: Partial<Observation> = {}): Observation {
  return {
    faces: 1,
    ok: true,
    reason: null,
    box: [240, 150, 400, 330], // 25% of the frame width, centred
    frame: [640, 480],
    pose: { yaw: 0, pitch: 0.6 },
    match: undefined as never,
    dataUrl: `frame-${sigSeed}`,
    signature: freshSig(),
    ...over,
  } as Observation;
}

/** Drive the machine: returns the new state and the clock. */
class Run {
  s: CaptureState = initialState();
  t = 1000;
  send(e: CaptureEvent) {
    this.s = captureReducer(this.s, e);
    return this;
  }
  start(glasses = false) {
    this.send({ type: "START", steps: buildSteps(glasses), now: this.t });
    return this.send({ type: "CAMERA_READY", now: this.t });
  }
  see(o: Observation | (() => Observation), n = 1) {
    for (let i = 0; i < n; i++) {
      this.t += 200;
      this.send({ type: "OBSERVE", obs: typeof o === "function" ? o() : o, now: this.t });
    }
    return this;
  }
  wait(ms: number) {
    this.t += ms;
    return this;
  }
  /** Hold a pose long enough for an automatic capture. */
  hold(over: Partial<Observation> = {}) {
    const o = obs(over);
    return this.see(o, RULES.STABLE_FRAMES);
  }
}

test("nothing is captured before the caregiver starts the scan", () => {
  const r = new Run();
  r.see(obs(), 10);
  assert.equal(r.s.phase, "idle");
  assert.equal(r.s.samples.length, 0);
  assert.equal(cameraWanted(r.s), false, "camera stays off until START");
  // Started, but the camera isn't ready yet: still nothing.
  r.send({ type: "START", steps: buildSteps(false), now: r.t }).see(obs(), 10);
  assert.equal(r.s.phase, "starting");
  assert.equal(r.s.samples.length, 0);
  assert.equal(cameraWanted(r.s), true);
});

test("a photo is taken only after the face is good and steady for STABLE_FRAMES checks", () => {
  const r = new Run().start();
  const o = obs();
  r.see(o, RULES.STABLE_FRAMES - 1);
  assert.equal(r.s.samples.length, 0);
  assert.equal(r.s.instruction, "VERIFYING");
  assert.equal(instructionText(r.s), "Hold still while we scan your face");
  r.see(o);
  assert.equal(r.s.samples.length, 1);
  assert.equal(r.s.samples[0].dataUrl, o.dataUrl, "the accepted photo is the exact frame the server checked");
  assert.equal(r.s.results[0], "captured");
  assert.equal(r.s.instruction, "CAPTURED");
});

test("poor frames are rejected with the right instruction", () => {
  const cases: [Partial<Observation>, string][] = [
    [{ faces: 0, box: null, pose: null }, "WAITING_FOR_FACE"],
    [{ faces: 2, box: null, pose: null }, "MULTIPLE_FACES"],
    [{ box: [300, 220, 360, 290] }, "MOVE_CLOSER"],
    [{ box: [60, 0, 580, 480] }, "MOVE_BACK"],
    [{ box: [20, 150, 180, 330] }, "CENTER_FACE"],
    [{ ok: false, reason: "too dark - add light in front of the face" }, "IMPROVE_LIGHTING"],
    [{ ok: false, reason: "too bright - avoid strong light" }, "IMPROVE_LIGHTING"],
    [{ ok: false, reason: "too blurry - hold still" }, "HOLD_STILL"],
    [{ ok: false, reason: "head tilted too far up or down" }, "LEVEL_HEAD"],
    [{ ok: false, reason: "head turned too far - face the camera more" }, "LOOK_STRAIGHT"],
    [{ pose: { yaw: 0.3, pitch: 0.6 } }, "LOOK_STRAIGHT"],
  ];
  for (const [over, expected] of cases) {
    const r = new Run().start();
    r.see(() => obs(over), 10);
    assert.equal(r.s.samples.length, 0, `captured despite ${expected}`);
    assert.equal(r.s.instruction, expected);
  }
});

test("another face entering the frame pauses capture and restarts the steadiness count", () => {
  const r = new Run().start();
  const o = obs();
  r.see(o, RULES.STABLE_FRAMES - 1);
  r.see(obs({ faces: 2, box: null, pose: null }));
  assert.equal(r.s.instruction, "MULTIPLE_FACES");
  assert.equal(instructionText(r.s), "Paused — only one person in view, please");
  r.see(o);
  assert.equal(r.s.samples.length, 0, "count restarted after the second face");
  r.see(o, RULES.STABLE_FRAMES);
  assert.equal(r.s.samples.length, 1);
});

test("a moving face isn't captured", () => {
  const r = new Run().start();
  let dx = 30; // jitters left/right by ~5% of the frame between checks
  r.see(() => obs({ box: [240 + (dx = -dx), 150, 400 + dx, 330] }), 6);
  assert.equal(r.s.samples.length, 0);
  assert.equal(r.s.instruction, "HOLD_STILL");
});

test("holding the same pose doesn't produce repeated captures", () => {
  const r = new Run().start();
  const o = obs();
  r.see(o, RULES.STABLE_FRAMES);
  assert.equal(r.s.samples.length, 1);
  r.see(o, 4); // still in cooldown
  assert.equal(r.s.instruction, "CAPTURED");
  r.wait(RULES.COOLDOWN_MS).see(o, 20); // next step wants a left turn: a still, straight face isn't taken
  assert.equal(r.s.samples.length, 1);
  assert.equal(r.s.instruction, "TURN_LEFT");
});

test("instructions progress: straight -> left -> back to centre -> right -> centre -> smile -> done", () => {
  const r = new Run().start();
  assert.equal(instructionText(r.s), "Position your face in the oval");
  r.hold();
  r.wait(RULES.COOLDOWN_MS).see(obs());
  assert.equal(instructionText(r.s), "Slowly turn your head to your left");
  r.hold({ pose: { yaw: 0.28, pitch: 0.6 } }); // person's own left
  assert.equal(r.s.samples.length, 2);

  r.wait(RULES.COOLDOWN_MS).see(obs({ pose: { yaw: 0.28, pitch: 0.6 } }));
  assert.equal(r.s.instruction, "RETURN_TO_CENTER", "must come back to the centre between turns");
  r.see(obs({ pose: { yaw: 0.02, pitch: 0.6 } }));
  assert.equal(instructionText(r.s), "Now slowly turn your head to your right");
  r.see(obs({ pose: { yaw: 0.6, pitch: 0.6 }, ok: false, reason: "head turned too far - face the camera more" }));
  assert.equal(r.s.instruction, "TURN_LESS");
  r.hold({ pose: { yaw: -0.3, pitch: 0.6 } });
  assert.equal(r.s.samples.length, 3);

  r.wait(RULES.COOLDOWN_MS).see(obs({ pose: { yaw: -0.3, pitch: 0.6 } }));
  assert.equal(r.s.instruction, "RETURN_TO_CENTER");
  r.hold();
  assert.equal(r.s.samples.length, 4);
  assert.equal(r.s.phase, "complete");
  assert.equal(cameraWanted(r.s), false, "camera released when all photos are taken");
  assert.deepEqual(r.s.samples.map((s) => s.step), [0, 1, 2, 3]);
});

test("a near-identical frame isn't accepted as a new sample", () => {
  const r = new Run().start();
  const sig = freshSig();
  r.hold({ signature: sig });
  r.wait(RULES.COOLDOWN_MS).hold({ pose: { yaw: 0.3, pitch: 0.6 } });
  r.wait(RULES.COOLDOWN_MS).see(obs()).hold({ pose: { yaw: -0.3, pitch: 0.6 } });
  r.wait(RULES.COOLDOWN_MS).see(obs()); // back at the centre for the "straight again (smile)" step
  assert.equal(r.s.results.join(), "captured,captured,captured,pending");
  const nearCopy = sig.map((v, i) => v + (i % 2 ? 0.02 : -0.02));
  assert.ok(signatureDistance(sig, nearCopy) < RULES.NEAR_DUPLICATE);
  r.see(() => obs({ signature: nearCopy }), 10);
  assert.equal(r.s.samples.length, 3, "near-copy of photo 1 rejected");
  assert.equal(r.s.instruction, "VARY_LOOK");
  assert.equal(instructionText(r.s), "Smile, or move your head a little");
  r.hold(); // a genuinely different look is accepted
  assert.equal(r.s.samples.length, 4);
});

test("skipping is limited so at least MIN_SAMPLES photos are always taken", () => {
  const r = new Run().start();
  assert.equal(canSkip(r.s), true);
  r.send({ type: "SKIP", now: r.t });
  assert.equal(canSkip(r.s), false, "4 steps, 1 skipped: the other 3 are all needed");
  r.send({ type: "SKIP", now: r.t });
  assert.equal(r.s.results.filter((x) => x === "skipped").length, 1);
});

test("glasses steps give time to switch glasses before capturing", () => {
  const r = new Run().start(true);
  assert.equal(r.s.steps.length, 6);
  r.hold();
  r.wait(RULES.COOLDOWN_MS).hold({ pose: { yaw: 0.3, pitch: 0.6 } });
  r.wait(RULES.COOLDOWN_MS).see(obs()).hold({ pose: { yaw: -0.3, pitch: 0.6 } });
  r.wait(RULES.COOLDOWN_MS).see(obs()).hold();
  assert.equal(r.s.samples.length, 4);
  r.see(obs(), 8); // ~1.6 s later: still the switching pause
  assert.equal(r.s.samples.length, 4);
  assert.equal(r.s.instruction, "SWITCH_GLASSES");
  r.wait(RULES.GLASSES_PAUSE_MS).hold();
  assert.equal(r.s.samples.length, 5);
});

test("cancel stops capture, discards the photos and turns the camera off", () => {
  const r = new Run().start();
  r.hold();
  assert.equal(r.s.samples.length, 1);
  r.send({ type: "CANCEL" });
  assert.equal(r.s.phase, "idle");
  assert.equal(r.s.samples.length, 0);
  assert.equal(cameraWanted(r.s), false);
  r.see(obs(), 10);
  assert.equal(r.s.samples.length, 0, "no capture after cancel");
});

test("camera failure shows an error and START retries", () => {
  const r = new Run();
  r.send({ type: "START", steps: buildSteps(false), now: r.t });
  r.send({ type: "CAMERA_ERROR", message: "Camera access was blocked." });
  assert.equal(r.s.phase, "error");
  assert.equal(instructionText(r.s), "Camera access was blocked.");
  assert.equal(cameraWanted(r.s), false);
  r.start();
  assert.equal(r.s.phase, "scanning");
});

test("save flow: rejected photos are retaken automatically, then saving succeeds", () => {
  const r = new Run().start();
  r.hold();
  r.wait(RULES.COOLDOWN_MS).hold({ pose: { yaw: 0.3, pitch: 0.6 } });
  r.wait(RULES.COOLDOWN_MS).see(obs()).hold({ pose: { yaw: -0.3, pitch: 0.6 } });
  r.wait(RULES.COOLDOWN_MS).see(obs()).hold();
  assert.equal(r.s.phase, "complete");
  r.send({ type: "SAVE_START" });
  assert.equal(r.s.phase, "saving");
  r.send({ type: "SAVE_FAILED", message: "Photo 2: too blurry", retakeSamples: [1], now: r.t });
  assert.equal(r.s.phase, "starting", "camera back on to retake");
  assert.equal(r.s.samples.length, 3);
  assert.equal(r.s.results[1], "pending");
  r.send({ type: "CAMERA_READY", now: r.t });
  r.wait(RULES.COOLDOWN_MS).hold({ pose: { yaw: 0.3, pitch: 0.6 } });
  assert.equal(r.s.phase, "complete");
  r.send({ type: "SAVE_START" }).send({ type: "SAVED" });
  assert.equal(r.s.phase, "done");
  assert.equal(instructionText(r.s), "Enrollment complete");
});
