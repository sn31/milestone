"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { thrownText } from "@/lib/api-client";
import { setAutoFundRequest } from "./agents-api";

/** Turns a live mandate's auto-fund rule on or off (PATCH /api/agents/<id>). The caps stay as they are. */
export function AutoFundToggle({ id, on, agentName }: { id: string; on: boolean; agentName: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function flip() {
    setBusy(true);
    setError(null);
    try {
      const r = await setAutoFundRequest(id, !on);
      if (!r.ok) setError(r.error);
      else router.refresh();
    } catch (e) {
      setError(thrownText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="ghost" size="sm" onClick={flip} disabled={busy} aria-pressed={on} aria-label={`${on ? "Turn off" : "Turn on"} auto-fund for ${agentName}`}>
        {busy ? "Saving…" : on ? "Turn auto-fund off" : "Turn auto-fund on"}
      </Button>
      {error ? <span className="text-[12px] text-state-danger">{error}</span> : null}
    </span>
  );
}
