"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** While the PayPal AUP check runs in the worker, re-render the page every few seconds (for two minutes at most). */
export function AupRefresh({ everyMs = 3000, forMs = 120_000 }: { everyMs?: number; forMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const started = Date.now();
    const t = setInterval(() => {
      if (Date.now() - started > forMs) clearInterval(t);
      else router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, forMs]);
  return null;
}
