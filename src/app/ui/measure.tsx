"use client";

import { useEffect, useState } from "react";
import type { Odds } from "@/lib/useRealtime";

/** Seconds since `since`, ticking while it is shown. */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <>{((now - since) / 1000).toFixed(1)}s</>;
}

/** The probability Jev gave one option, if it weighed it. */
export function share(odds: Odds[] | undefined, id: string): number | undefined {
  return odds?.find((o) => o.id === id)?.probability;
}

export function ms(seconds: number): string {
  return seconds < 1 ? `${Math.round(seconds * 1000)}ms` : `${seconds.toFixed(1)}s`;
}
