"use client";

import { serverUrl } from "@/lib/server";

const TAIL_MS = 500;
let speakingUntil = 0;
let current: HTMLAudioElement | null = null;

function playAudio(audio: HTMLAudioElement) {
  current?.pause();
  current = audio;
  speakingUntil = Number.POSITIVE_INFINITY;
  const done = () => {
    if (current === audio) speakingUntil = Date.now() + TAIL_MS;
  };
  audio.onended = done;
  audio.onerror = done;
  audio.play().catch(done);
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
