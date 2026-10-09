"use client";

import { RefObject, useEffect, useState } from "react";

/** Attach the webcam to a <video>. With `enabled` false the camera is off (and released when it turns off). */
export function useCamera(videoRef: RefObject<HTMLVideoElement | null>, enabled = true) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    setError(null);
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (videoRef.current) {
          videoRef.current.srcObject = s;
          videoRef.current.play().catch(() => {});
        }
      })
      .catch((e) => setError(String(e?.message ?? e)));
    const video = videoRef.current;
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
      if (video && video.srcObject === stream) video.srcObject = null;
    };
  }, [videoRef, enabled]);

  return error;
}

/** Grab the current video frame as a JPEG, downscaled to at most maxWidth. */
export function grabFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxWidth = 640,
  quality = 0.7,
): { dataUrl: string; width: number; height: number } | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const scale = Math.min(1, maxWidth / vw);
  const width = Math.round(vw * scale);
  const height = Math.round(vh * scale);
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(video, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL("image/jpeg", quality), width, height };
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [head, b64] = dataUrl.split(",");
  const mime = head.match(/data:(.*?);/)?.[1] ?? "image/jpeg";
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

let sigCanvas: HTMLCanvasElement | null = null;

/** 16x16 grey thumbnail of the face region of a grabbed frame (box in that frame's pixels), for
 *  spotting near-identical enrollment photos. Stays in the browser; nothing is sent anywhere. */
export function faceGrey(frame: HTMLCanvasElement, box: [number, number, number, number], size = 16): number[] | null {
  const [x1, y1, x2, y2] = box.map((v) => Math.round(v));
  const w = Math.min(frame.width, x2) - Math.max(0, x1);
  const h = Math.min(frame.height, y2) - Math.max(0, y1);
  if (w < 4 || h < 4) return null;
  sigCanvas ??= document.createElement("canvas");
  sigCanvas.width = size;
  sigCanvas.height = size;
  const ctx = sigCanvas.getContext("2d", { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(frame, Math.max(0, x1), Math.max(0, y1), w, h, 0, 0, size, size);
  const px = ctx.getImageData(0, 0, size, size).data;
  const grey: number[] = [];
  for (let i = 0; i < px.length; i += 4) grey.push(0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]);
  return grey;
}
