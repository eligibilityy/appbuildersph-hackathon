"use client";

import { useEffect } from "react";

/** Keep the screen on while this page is open (patient view runs unattended). No-op where unsupported. */
export function useWakeLock() {
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const request = async () => {
      if (stopped || document.visibilityState !== "visible" || !("wakeLock" in navigator)) return;
      try {
        lock = await navigator.wakeLock.request("screen");
      } catch {
        // Denied (battery saver, unsupported context): the screen just follows the OS timeout.
      }
    };
    request();
    // The browser drops the lock when the tab is hidden; take it again when it's back.
    document.addEventListener("visibilitychange", request);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", request);
      void lock?.release().catch(() => {});
    };
  }, []);
}
