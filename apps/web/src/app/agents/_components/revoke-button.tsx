"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui";
import { thrownText } from "@/lib/api-client";
import { TOKEN_STORAGE_PREFIX } from "@/lib/agent/protocol";
import { revokeMandateRequest } from "./agents-api";

/** Revoke a mandate (two clicks: the first asks). The agent's next call is refused with mandate_revoked. */
export function RevokeButton({ id, agentName }: { id: string; agentName: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      const r = await revokeMandateRequest(id);
      if (!r.ok) return setError(r.error);
      try {
        sessionStorage.removeItem(TOKEN_STORAGE_PREFIX + id);
      } catch {
        // storage blocked
      }
      router.refresh();
    } catch (e) {
      setError(thrownText(e));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      {confirming ? (
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
            Keep
          </Button>
          <Button variant="danger" size="sm" onClick={revoke} disabled={busy} aria-label={`Confirm revoking ${agentName}`}>
            {busy ? "Revoking…" : "Revoke now"}
          </Button>
        </div>
      ) : (
        <Button variant="danger" size="sm" onClick={() => setConfirming(true)} aria-label={`Revoke ${agentName}`}>
          Revoke
        </Button>
      )}
      {error ? <p className="text-[12px] text-state-danger">{error}</p> : null}
    </div>
  );
}
