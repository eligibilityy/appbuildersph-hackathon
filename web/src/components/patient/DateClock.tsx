"use client";

import { useEffect, useState } from "react";

/** Day, date and time in large type: helps the patient stay oriented. Renders after mount (no SSR clock). */
export default function DateClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(id);
  }, []);

  if (!now) return <div className="h-[62px]" aria-hidden />;
  return (
    <div className="leading-tight">
      <div className="text-[20px] font-medium tracking-[-0.015em] text-white">
        {new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }).format(now)}
      </div>
      <div className="text-[16px] font-medium text-white/75">
        {new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(now)}
      </div>
    </div>
  );
}
