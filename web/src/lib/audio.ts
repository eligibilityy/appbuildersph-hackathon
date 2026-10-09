"use client";

import { serverUrl } from "@/lib/server";

const TAIL_MS = 500;
const BLOCKED_REPLAY_MS = 15_000; // after a tap unlocks sound, still play a brief this recent
let speakingUntil = 0;
let current: HTMLAudioElement | null = null;

// Chrome blocks sound until someone has clicked or pressed a key on the page (unless it was started
// with --autoplay-policy=no-user-gesture-required). Remember the blocked clip and play it on the
// first gesture, and let the page show a "turn on sound" hint meanwhile.
let blocked: { audio: HTMLAudioElement; at: number } | null = null;
const blockedListeners = new Set<(blocked: boolean) => void>();

function setBlocked(next: typeof blocked) {
  const changed = !!next !== !!blocked;
  blocked = next;
  if (changed) blockedListeners.forEach((fn) => fn(!!next));
}

/** Subscribe to "sound is blocked until a tap". Returns an unsubscribe function. */
export function onSoundBlocked(fn: (blocked: boolean) => void): () => void {
  blockedListeners.add(fn);
  fn(!!blocked);
  return () => blockedListeners.delete(fn);
}

/** Call from a click/keydown handler: plays the clip the browser blocked, if it's still recent. */
export function unlockSound() {
  if (!blocked) return;
  const { audio, at } = blocked;
  setBlocked(null);
  if (Date.now() - at < BLOCKED_REPLAY_MS && current === audio) playAudio(audio);
}

function playAudio(audio: HTMLAudioElement) {
  if (current !== audio) current?.pause();
  current = audio;
  speakingUntil = Number.POSITIVE_INFINITY;
  const done = () => {
    if (current === audio) speakingUntil = Date.now() + TAIL_MS;
  };
  audio.onended = done;
  audio.onerror = done;
  audio
    .play()
    .then(() => setBlocked(null))
    .catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "NotAllowedError") setBlocked({ audio, at: Date.now() });
      done();
    });
}

export function playSpeech(audioUrl: string) {
  playAudio(new Audio(`${serverUrl()}${audioUrl}`));
}

export function isSpeaking() {
  return Date.now() < speakingUntil;
}

/** Live mic level for a meter: 0..1, and whether the chunk went to the server (false while the app is
 *  speaking or the socket is down). Updates ~10 times a second while the mic is on. */
export type MicLevel = { level: number; sending: boolean };
const levelListeners = new Set<(m: MicLevel) => void>();

export function onMicLevel(fn: (m: MicLevel) => void): () => void {
  levelListeners.add(fn);
  return () => levelListeners.delete(fn);
}

/** RMS of a PCM16 chunk mapped from -60..-15 dBFS to 0..1 (speech near a laptop mic sits around the top). */
export function pcmLevel(chunk: Int16Array): number {
  if (!chunk.length) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 1) sum += chunk[i] * chunk[i];
  const rms = Math.sqrt(sum / chunk.length) / 32768;
  const db = 20 * Math.log10(Math.max(rms, 1e-6));
  return Math.min(1, Math.max(0, (db + 60) / 45));
}

/** Start local mic capture and stream PCM16LE mono chunks through the existing WebSocket. */
export async function startMicrophone(getSocket: () => WebSocket | null): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
  });
  const context = new AudioContext({ sampleRate: 16_000 });
  try {
    await context.audioWorklet.addModule("/pcm-capture-worklet.js");
    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, "pcm16-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
    });
    const silent = context.createGain();
    silent.gain.value = 0;
    worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const socket = getSocket();
      const sending =
        !isSpeaking() && !!socket && socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= 64_000;
      if (levelListeners.size) {
        const m = { level: pcmLevel(new Int16Array(event.data)), sending };
        levelListeners.forEach((fn) => fn(m));
      }
      if (sending) socket!.send(event.data);
    };
    source.connect(worklet);
    worklet.connect(silent);
    silent.connect(context.destination);

    return () => {
      worklet.port.onmessage = null;
      source.disconnect();
      worklet.disconnect();
      silent.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    };
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
    throw error;
  }
}
