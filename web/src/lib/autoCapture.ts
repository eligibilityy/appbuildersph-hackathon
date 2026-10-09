// Guided automatic enrollment capture: a pure state machine (no React, no DOM), unit-tested with `npm test`.
//
// The browser checks a camera frame every ~200 ms with POST /enroll/check (real local detection: face
// count, box, strict quality gate, head pose from the 5 facial landmarks). Each result is fed in as an
// OBSERVE event. A photo is taken automatically only when ALL of these hold for STABLE_FRAMES checks
// in a row: scanning was explicitly started, exactly one face, big enough and centred, passes the
// server's quality gate, head pose matches the current step, not moving, and not a near-copy of a photo
// already taken. The accepted photo is the exact frame the server checked.
//
// Phases (the suggested states, mapped):
//   idle        nothing runs; the camera is off (capture can't happen before START)
//   starting    INITIALIZING_CAMERA
//   scanning    WAITING_FOR_FACE / CENTER_FACE / MOVE_CLOSER / IMPROVE_LIGHTING / LOOK_STRAIGHT /
//               TURN_LEFT / TURN_RIGHT / RETURN_TO_CENTER / VERIFYING / CAPTURED (see `instruction`)
//   complete    all photos taken, camera off, waiting to save (or for a duplicate decision)
//   saving      PROCESSING_ENROLLMENT
//   done        ENROLLMENT_COMPLETE
//   error       ENROLLMENT_ERROR (camera failed) - RETRY starts over
import type { FrameCheck } from "./api";

export type Box = [number, number, number, number];
export type Pose = "straight" | "left" | "right";
export type CaptureStep = { pose: Pose; prompt: string; variant?: "smile" | "glasses" };
export type Phase = "idle" | "starting" | "scanning" | "complete" | "saving" | "done" | "error";
export type Instruction =
  | "WAITING_FOR_FACE"
  | "MULTIPLE_FACES"
  | "CENTER_FACE"
  | "MOVE_CLOSER"
  | "MOVE_BACK"
  | "IMPROVE_LIGHTING"
  | "HOLD_STILL"
  | "LEVEL_HEAD"
  | "LOOK_STRAIGHT"
  | "TURN_LEFT"
  | "TURN_RIGHT"
  | "TURN_LESS"
  | "RETURN_TO_CENTER"
  | "VARY_LOOK"
  | "SWITCH_GLASSES"
  | "VERIFYING"
  | "CAPTURED";

/** One checked camera frame. `signature` is a contrast-normalised 16x16 grey thumbnail of the face. */
export type Observation = Pick<FrameCheck, "faces" | "ok" | "reason" | "box" | "pose" | "frame"> & {
  dataUrl: string;
  signature: number[] | null;
};
export type Sample = { dataUrl: string; step: number; signature: number[] | null };
export type StepResult = "pending" | "captured" | "skipped";

export type CaptureState = {
  phase: Phase;
  steps: CaptureStep[];
  results: StepResult[];
  samples: Sample[];
  instruction: Instruction;
  stable: number; // consecutive eligible checks
  lastCenter: [number, number] | null; // face centre at the previous check (fraction of frame)
  needCenter: boolean; // after a head turn, come back to the centre before the next photo
  cooldownUntil: number;
  capturedAt: number; // for the "captured" flash
  face: { box: Box; frame: [number, number] } | null; // last seen face, for the overlay
  error: string | null;
};

export type CaptureEvent =
  | { type: "START"; steps: CaptureStep[]; now: number }
  | { type: "CAMERA_READY"; now: number }
  | { type: "CAMERA_ERROR"; message: string }
  | { type: "OBSERVE"; obs: Observation; now: number }
  | { type: "SKIP"; now: number }
  | { type: "RETAKE"; sample: number; now: number }
  | { type: "CANCEL" }
  | { type: "SAVE_START" }
  | { type: "SAVED" }
  | { type: "SAVE_FAILED"; message: string; retakeSamples?: number[]; now: number };

/** Tunables. Pose numbers are the landmark yaw ratio from the server (see engine.check_frame). */
export const RULES = {
  MIN_SAMPLES: 3,
  STABLE_FRAMES: 3, // ~0.6 s at one check per ~200 ms
  COOLDOWN_MS: 900,
  GLASSES_PAUSE_MS: 3500, // time to put glasses on / take them off
  MIN_FACE_W: 0.16, // face box width as a fraction of the frame width
  MAX_FACE_W: 0.55,
  MAX_OFF_CENTER_X: 0.17,
  MAX_OFF_CENTER_Y: 0.2,
  MAX_MOVE: 0.04, // face centre movement between checks (fraction of frame width)
  STRAIGHT_MAX_YAW: 0.12,
  TURN_MIN_YAW: 0.18, // the server's strict gate rejects > 0.5, so turns stay "slight"
  CENTER_YAW: 0.15,
  // Mean abs difference of normalised 16x16 face thumbnails. Measured on the real detector's crops:
  // re-encoded / shifted / brighter copies 0.03-0.06; 6 degree head tilt 0.22; glasses 0.31.
  NEAR_DUPLICATE: 0.12,
};

export function buildSteps(glasses: boolean): CaptureStep[] {
  const steps: CaptureStep[] = [
    { pose: "straight", prompt: "Look straight at the camera" },
    { pose: "left", prompt: "Slowly turn your head to your left" },
    { pose: "right", prompt: "Now slowly turn your head to your right" },
    { pose: "straight", prompt: "Look straight and smile", variant: "smile" },
  ];
  if (glasses) {
    steps.push(
      { pose: "straight", prompt: "Switch your glasses (put them on or take them off), then look straight", variant: "glasses" },
      { pose: "left", prompt: "Keep the glasses switched and turn slightly to your left", variant: "glasses" },
    );
  }
  return steps;
}

export function initialState(): CaptureState {
  return {
    phase: "idle",
    steps: [],
    results: [],
    samples: [],
    instruction: "WAITING_FOR_FACE",
    stable: 0,
    lastCenter: null,
    needCenter: false,
    cooldownUntil: 0,
    capturedAt: 0,
    face: null,
    error: null,
  };
}

/** The camera should be on only while starting or scanning. */
export function cameraWanted(s: CaptureState): boolean {
  return s.phase === "starting" || s.phase === "scanning";
}

export function currentStep(s: CaptureState): number {
  return s.results.indexOf("pending");
}

/** Skipping is allowed only while enough steps remain to reach MIN_SAMPLES. */
export function canSkip(s: CaptureState): boolean {
  const cur = currentStep(s);
  if (s.phase !== "scanning" || cur < 0) return false;
  const pendingAfter = s.results.filter((r, i) => r === "pending" && i !== cur).length;
  return s.samples.length + pendingAfter >= RULES.MIN_SAMPLES;
}

export function captureReducer(s: CaptureState, e: CaptureEvent): CaptureState {
  switch (e.type) {
    case "START":
      return {
        ...initialState(),
        phase: "starting",
        steps: e.steps,
        results: e.steps.map(() => "pending"),
      };
    case "CAMERA_READY":
      return s.phase === "starting" ? { ...s, phase: "scanning", instruction: "WAITING_FOR_FACE" } : s;
    case "CAMERA_ERROR":
      return s.phase === "starting" || s.phase === "scanning"
        ? { ...s, phase: "error", error: e.message, samples: [], face: null }
        : s;
    case "CANCEL":
      return initialState(); // photos taken so far are discarded
    case "OBSERVE":
      return observe(s, e.obs, e.now);
    case "SKIP": {
      if (!canSkip(s)) return s;
      const results = [...s.results];
      results[currentStep(s)] = "skipped";
      return advance({ ...s, results, needCenter: false }, e.now);
    }
    case "RETAKE": {
      const sample = s.samples[e.sample];
      if (!sample || !(s.phase === "scanning" || s.phase === "complete")) return s;
      return reopen(s, [e.sample], e.now);
    }
    case "SAVE_START":
      return s.phase === "complete" ? { ...s, phase: "saving", error: null } : s;
    case "SAVED":
      return s.phase === "saving" ? { ...s, phase: "done", error: null } : s;
    case "SAVE_FAILED": {
      if (s.phase !== "saving") return s;
      if (e.retakeSamples?.length) return { ...reopen({ ...s, phase: "complete" }, e.retakeSamples, e.now), error: e.message };
      return { ...s, phase: "complete", error: e.message };
    }
  }
}

/** Drop some samples and go back to scanning for their steps. */
function reopen(s: CaptureState, sampleIdx: number[], now: number): CaptureState {
  const drop = new Set(sampleIdx);
  const results = [...s.results];
  for (const i of drop) if (s.samples[i]) results[s.samples[i].step] = "pending";
  const samples = s.samples.filter((_, i) => !drop.has(i));
  return {
    ...s,
    phase: "starting", // turn the camera back on
    results,
    samples,
    stable: 0,
    needCenter: false,
    lastCenter: null,
    cooldownUntil: now,
    instruction: "WAITING_FOR_FACE",
  };
}

/** Move to the next pending step (or finish). */
function advance(s: CaptureState, now: number): CaptureState {
  const next = s.results.indexOf("pending");
  if (next < 0) return { ...s, phase: "complete", face: null, stable: 0 };
  const prev = s.steps[next - 1];
  const switching = s.steps[next].variant === "glasses" && prev?.variant !== "glasses";
  return {
    ...s,
    stable: 0,
    lastCenter: null,
    cooldownUntil: Math.max(s.cooldownUntil, switching ? now + RULES.GLASSES_PAUSE_MS : now),
  };
}

function observe(s: CaptureState, obs: Observation, now: number): CaptureState {
  if (s.phase !== "scanning") return s; // never capture unless scanning was explicitly started
  const face = obs.faces === 1 && obs.box && obs.frame ? { box: obs.box, frame: obs.frame } : null;
  const cur = currentStep(s);
  if (cur < 0) return s;
  const step = s.steps[cur];

  if (now < s.cooldownUntil) {
    const justCaptured = now - s.capturedAt < RULES.COOLDOWN_MS;
    const instruction = justCaptured ? "CAPTURED" : step.variant === "glasses" ? "SWITCH_GLASSES" : "HOLD_STILL";
    return { ...s, face, instruction, stable: 0, lastCenter: null };
  }

  const verdict = assess(s, step, obs);
  const center = face ? centerOf(face.box, face.frame) : null;
  const needCenter = verdict.needCenter;
  if (!verdict.eligible) {
    return { ...s, face, needCenter, instruction: verdict.instruction, stable: 0, lastCenter: center };
  }
  const moved = s.lastCenter && center ? Math.hypot(center[0] - s.lastCenter[0], center[1] - s.lastCenter[1]) : 0;
  if (moved > RULES.MAX_MOVE) {
    return { ...s, face, needCenter, instruction: "HOLD_STILL", stable: 0, lastCenter: center };
  }
  const stable = s.stable + 1;
  if (stable < RULES.STABLE_FRAMES) {
    return { ...s, face, needCenter, instruction: "VERIFYING", stable, lastCenter: center };
  }

  // Capture this exact (server-checked) frame.
  const results = [...s.results];
  results[cur] = "captured";
  const captured: CaptureState = {
    ...s,
    face,
    results,
    samples: [...s.samples, { dataUrl: obs.dataUrl, step: cur, signature: obs.signature }],
    instruction: "CAPTURED",
    needCenter: step.pose !== "straight",
    capturedAt: now,
    cooldownUntil: now + RULES.COOLDOWN_MS,
  };
  return advance(captured, now);
}

type Verdict = { eligible: boolean; instruction: Instruction; needCenter: boolean };

/** Why this frame can't be taken for this step (or that it can). Order = what to fix first. */
export function assess(s: CaptureState, step: CaptureStep, obs: Observation): Verdict {
  let needCenter = s.needCenter;
  const no = (instruction: Instruction): Verdict => ({ eligible: false, instruction, needCenter });
  if (obs.faces === 0 || !obs.box || !obs.frame) return obs.faces > 1 ? no("MULTIPLE_FACES") : no("WAITING_FOR_FACE");
  if (obs.faces > 1) return no("MULTIPLE_FACES");

  const fw = (obs.box[2] - obs.box[0]) / obs.frame[0];
  if (fw < RULES.MIN_FACE_W) return no("MOVE_CLOSER");
  if (fw > RULES.MAX_FACE_W) return no("MOVE_BACK");
  const [cx, cy] = centerOf(obs.box, obs.frame);
  if (Math.abs(cx - 0.5) > RULES.MAX_OFF_CENTER_X || Math.abs(cy - 0.5) > RULES.MAX_OFF_CENTER_Y) {
    return no("CENTER_FACE");
  }
  if (!obs.pose) return no("WAITING_FOR_FACE");
  const yaw = obs.pose.yaw;

  if (!obs.ok) {
    const r = (obs.reason ?? "").toLowerCase();
    if (r.includes("dark") || r.includes("bright")) return no("IMPROVE_LIGHTING");
    if (r.includes("blurry")) return no("HOLD_STILL");
    if (r.includes("small")) return no("MOVE_CLOSER");
    if (r.includes("tilted")) return no("LEVEL_HEAD");
    if (r.includes("turned")) return no(step.pose === "straight" ? "LOOK_STRAIGHT" : "TURN_LESS");
    return no("WAITING_FOR_FACE");
  }

  if (needCenter) {
    if (Math.abs(yaw) > RULES.CENTER_YAW) return no("RETURN_TO_CENTER");
    needCenter = false;
  }
  // yaw > 0: turned to the person's own left (see engine.check_frame).
  if (step.pose === "straight" && Math.abs(yaw) > RULES.STRAIGHT_MAX_YAW) return no("LOOK_STRAIGHT");
  if (step.pose === "left" && yaw < RULES.TURN_MIN_YAW) return no("TURN_LEFT");
  if (step.pose === "right" && yaw > -RULES.TURN_MIN_YAW) return no("TURN_RIGHT");

  if (obs.signature && s.samples.some((p) => p.signature && signatureDistance(p.signature, obs.signature!) < RULES.NEAR_DUPLICATE)) {
    return no(step.variant === "glasses" ? "SWITCH_GLASSES" : "VARY_LOOK");
  }
  return { eligible: true, instruction: "VERIFYING", needCenter };
}

function centerOf(box: Box, frame: [number, number]): [number, number] {
  return [(box[0] + box[2]) / 2 / frame[0], (box[1] + box[3]) / 2 / frame[1]];
}

/** Grey pixels (any length) -> zero-mean, unit-variance signature. */
export function normalizeSignature(grey: ArrayLike<number>): number[] {
  const n = grey.length;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += grey[i];
  mean /= n || 1;
  let v = 0;
  for (let i = 0; i < n; i++) v += (grey[i] - mean) ** 2;
  const sd = Math.sqrt(v / (n || 1)) + 1e-6;
  return Array.from({ length: n }, (_, i) => (grey[i] - mean) / sd);
}

export function signatureDistance(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return Infinity;
  let d = 0;
  for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]);
  return d / a.length;
}

const TEXT: Record<Instruction, string> = {
  WAITING_FOR_FACE: "Position your face in the oval",
  MULTIPLE_FACES: "Paused — only one person in view, please",
  CENTER_FACE: "Move your face to the center",
  MOVE_CLOSER: "Come a little closer",
  MOVE_BACK: "Move back a little",
  IMPROVE_LIGHTING: "More light on the face, please",
  HOLD_STILL: "Hold still",
  LEVEL_HEAD: "Keep your chin level",
  LOOK_STRAIGHT: "Look straight at the camera",
  TURN_LEFT: "Slowly turn your head to your left",
  TURN_RIGHT: "Slowly turn your head to your right",
  TURN_LESS: "Not quite so far — turn back a little",
  RETURN_TO_CENTER: "Return to the center",
  VARY_LOOK: "Smile, or move your head a little",
  SWITCH_GLASSES: "Switch your glasses (on or off)",
  VERIFYING: "Hold still while we scan your face",
  CAPTURED: "Face captured",
};

/** What to show the person right now. The step's own wording is used for its pose instruction. */
export function instructionText(s: CaptureState): string {
  switch (s.phase) {
    case "idle":
      return "Press Start to begin the face scan";
    case "starting":
      return "Starting the camera…";
    case "complete":
      return "All photos captured";
    case "saving":
      return "Saving…";
    case "done":
      return "Enrollment complete";
    case "error":
      return s.error ?? "Something went wrong";
  }
  const cur = currentStep(s);
  const step = cur >= 0 ? s.steps[cur] : null;
  const poseInstruction: Instruction | null = step
    ? step.pose === "straight" ? "LOOK_STRAIGHT" : step.pose === "left" ? "TURN_LEFT" : "TURN_RIGHT"
    : null;
  if (step && (s.instruction === poseInstruction || s.instruction === "SWITCH_GLASSES")) return step.prompt;
  return TEXT[s.instruction];
}

/** Which way to point the on-screen turn arrow (in the person's own terms). */
export function turnHint(s: CaptureState): "left" | "right" | null {
  if (s.phase !== "scanning") return null;
  if (s.instruction === "TURN_LEFT") return "left";
  if (s.instruction === "TURN_RIGHT") return "right";
  return null;
}
