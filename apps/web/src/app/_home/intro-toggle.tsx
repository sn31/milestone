"use client";

import { Button } from "@/components/ui";
import { INTRO_KEY } from "./intro-key";

/**
 * Hides or brings back the first-run band on "/". The choice lives on <html data-intro> (CSS does the hiding, so the
 * server-rendered page never changes shape on hydration) and in localStorage for this viewer, read again in <head> on the
 * next load. Storage can throw (private mode, blocked site data); the band then simply comes back next time.
 */
export function IntroToggle({ to, className }: { to: "hidden" | "shown"; className?: string }) {
  const apply = () => {
    const root = document.documentElement;
    if (to === "hidden") root.dataset.intro = "hidden";
    else delete root.dataset.intro;
    try {
      if (to === "hidden") localStorage.setItem(INTRO_KEY, "hidden");
      else localStorage.removeItem(INTRO_KEY);
    } catch {
      // Not remembered; the page still works.
    }
    if (to === "shown") document.getElementById("intro")?.scrollIntoView({ block: "nearest" });
  };
  if (to === "hidden") {
    return (
      <Button variant="ghost" size="sm" onClick={apply} className={className} aria-label="Hide the introduction">
        Hide
        <svg aria-hidden viewBox="0 0 10 10" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2.2 2.2 L7.8 7.8 M7.8 2.2 L2.2 7.8" />
        </svg>
      </Button>
    );
  }
  return (
    <Button variant="ghost" onClick={apply} className={className}>
      How it works
    </Button>
  );
}
