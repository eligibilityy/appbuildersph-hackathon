"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { serverUrl } from "@/lib/server";

/** Polls the local server's /health so any page can show whether it's reachable. */
export function useServerOnline(intervalMs = 5000) {
  const [online, setOnline] = useState<boolean | null>(null);
  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch(`${serverUrl()}/health`, { cache: "no-store" });
        if (!stopped) setOnline(res.ok);
      } catch {
        if (!stopped) setOnline(false);
      }
    };
    check();
    const id = setInterval(check, intervalMs);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [intervalMs]);
  return online;
}

/** Small pill: green dot "Connected" / red dot "Offline". */
export default function ConnectionStatus({ online, className }: { online: boolean | null; className?: string }) {
  const label = online === null ? "Connecting…" : online ? "Connected" : "Server offline";
  return (
    <span
      role="status"
      className={cn(
        "inline-flex h-8 items-center gap-2 rounded-full border bg-card px-3 text-footnote font-medium text-muted-foreground",
        className,
      )}
    >
      <span
        className={cn(
          "size-2 rounded-full",
          online === null ? "bg-tertiary-foreground" : online ? "bg-success" : "bg-destructive",
        )}
      />
      {label}
    </span>
  );
}
