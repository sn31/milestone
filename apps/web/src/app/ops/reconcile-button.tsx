"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, StateGlyph } from "@/components/ui";
import { postJson, thrownText } from "@/lib/api-client";

/**
 * Queues a reconciliation (POST /api/ops/reconcile) and refreshes the page until the worker records a new result
 * (the latest row's id changes), for up to 30 seconds. Moves no money: the job only reads PayPal's transactions.
 */
export function ReconcileButton({ latestId, disabled }: { latestId: string | null; disabled: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [waitingOn, setWaitingOn] = useState<string | null | undefined>(undefined);
  const [note, setNote] = useState<{ tone: "released" | "danger" | "funded"; text: string } | null>(null);

  const waiting = waitingOn !== undefined && waitingOn === latestId;

  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > 30_000) {
        clearInterval(timer);
        setWaitingOn(undefined);
        setNote({ tone: "danger", text: "Queued, but no result yet. Is the worker running? The result appears here when it is." });
        return;
      }
      router.refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [waiting, router]);

  async function run() {
    setBusy(true);
    setNote(null);
    try {
      const res = await postJson("/api/ops/reconcile");
      if (res.ok) {
        setWaitingOn(latestId);
        setNote({ tone: "funded", text: "Queued. The worker is reading PayPal's transactions." });
      } else setNote({ tone: "danger", text: res.error });
    } catch (e) {
      setNote({ tone: "danger", text: thrownText(e) });
    } finally {
      setBusy(false);
    }
  }

  const fresh = waitingOn !== undefined && waitingOn !== latestId;
  return (
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button variant="secondary" disabled={disabled || busy || waiting} onClick={run}>
        {busy || waiting ? "Reconciling..." : "Reconcile now"}
      </Button>
      {fresh ? (
        <p data-tone="released" role="status" className="flex items-baseline gap-2 text-[12px] text-fg-muted">
          <StateGlyph glyph="check" className="text-tone" />
          <span>Updated.</span>
        </p>
      ) : note ? (
        <p data-tone={note.tone} role="status" className="flex items-baseline gap-2 text-[12px] text-fg-muted">
          <StateGlyph glyph={note.tone === "danger" ? "cross" : "check"} className="text-tone" />
          <span className="min-w-0">{note.text}</span>
        </p>
      ) : null}
    </div>
  );
}
