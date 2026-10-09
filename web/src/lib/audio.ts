"use client";

// Speech playback for the patient view. Owner: voice & audio member.
// isSpeaking() lets the mic code skip sending audio while our own voice plays (+500 ms),
// so the app never transcribes itself.
import { serverUrl } from "@/lib/server";

const TAIL_MS = 500;
let speakingUntil = 0;
let current: HTMLAudioElement | null = null;

export function playSpeech(audioUrl: string) {
  current?.pause();
  const audio = new Audio(`${serverUrl()}${audioUrl}`);
  current = audio;
  speakingUntil = Number.POSITIVE_INFINITY;
  const done = () => {
    if (current === audio) speakingUntil = Date.now() + TAIL_MS;
  };
  audio.onended = done;
  audio.onerror = done;
  audio.play().catch(done); // autoplay can be blocked until the user clicks once
}

export function isSpeaking() {
  return Date.now() < speakingUntil;
}

// TODO (block 2): mic capture — getUserMedia({audio: {echoCancellation, noiseSuppression}}),
// AudioContext({sampleRate: 16000}) + AudioWorklet -> PCM16 mono ~100 ms chunks -> ws.send(buffer),
// skipped while isSpeaking().
