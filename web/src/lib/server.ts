"use client";

import { useEffect, useRef, useState } from "react";

// Backend runs on the same machine. Never point this at a remote host.
// Use 127.0.0.1, not "localhost": browsers send every cookie set on localhost (by any app, any
// port) to localhost:8000, and big ones (>~8 KB, e.g. auth cookies from other projects) make
// the WebSocket handshake fail with "431 Request Header Fields Too Large".
export function serverUrl(): string {
  return `http://127.0.0.1:${process.env.NEXT_PUBLIC_SERVER_PORT || "8000"}`;
}

export function wsUrl(): string {
  return serverUrl().replace(/^http/, "ws") + "/ws";
}

export type FaceBox = {
  box: [number, number, number, number];
  person_id: number | null;
  name: string | null;
  relationship: string | null;
  is_unknown: boolean | null;
  score: number;
};

export type ServerEvent =
  | { type: "faces"; faces: FaceBox[] }
  | { type: "visit_start"; visit_id: number; person_id: number }
  | { type: "visit_end"; visit_id: number; person_id: number }
  | { type: "speak"; text: string; audio_url: string | null; person_id?: number | null }
  | { type: "transcript"; visit_id: number; text: string }
  | { type: "memory_updated"; person_id: number }
  | { type: "appearance_updated"; person_id: number };

export type Person = {
  id: number;
  name: string | null;
  relationship: string | null;
  notes: string | null;
  is_unknown: number;
  name_source: string | null;
  created_at: string | null;
  registered_at: string | null;
  first_seen_at: string | null;
  last_seen_at: string | null;
  last_seen?: string | null;
  visit_count?: number;
};

/** WebSocket to the local server with auto-reconnect. */
export function useServerSocket(onEvent: (e: ServerEvent) => void) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlerRef = useRef(onEvent);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    handlerRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const ws = new WebSocket(wsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (m) => {
        if (typeof m.data === "string") handlerRef.current(JSON.parse(m.data));
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 1000);
      };
      ws.onerror = () => ws.close();
    };
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, []);

  return { wsRef, connected };
}
