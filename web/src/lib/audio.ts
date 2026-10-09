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

export function playLocalRecording(dataUrl: string) {
  playAudio(new Audio(dataUrl));
}

export function isSpeaking() {
  return Date.now() < speakingUntil;
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
      if (isSpeaking() || !socket || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 64_000) return;
      socket.send(event.data);
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
