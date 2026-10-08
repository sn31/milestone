"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the server page every few seconds while something on it is live (a delivery being verified), so new
 * activity lines stream in and the station moves on by itself when the verdict lands. Stops after `maxMinutes` and
 * while the tab is hidden.
 */
export function LiveRefresh({ everyMs = 4000, maxMinutes = 10 }: { everyMs?: number; maxMinutes?: number }) {
  const router = useRouter();
  useEffect(() => {
    const until = Date.now() + maxMinutes * 60_000;
    const t = setInterval(() => {
      if (Date.now() > until) return clearInterval(t);
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, maxMinutes]);
  return null;
}
