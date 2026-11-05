"use client";

import { Button } from "@/components/ui";

/**
 * Fills the composer with the placeholder brief, so a first-time visitor can draft the demo contract in one click instead
 * of mistaking the placeholder for text that is already there.
 */
export function UseExample({ title, scope }: { title: string; scope: string }) {
  const fill = () => {
    const t = document.getElementById("title") as HTMLInputElement | null;
    const s = document.getElementById("scope") as HTMLTextAreaElement | null;
    if (t && !t.value) t.value = title;
    if (s) {
      s.value = scope;
      s.focus();
      s.setSelectionRange(s.value.length, s.value.length);
    }
  };
  return (
    <Button variant="ghost" size="sm" onClick={fill} className="-my-1.5 -mr-2 shrink-0">
      Use the example
    </Button>
  );
}
