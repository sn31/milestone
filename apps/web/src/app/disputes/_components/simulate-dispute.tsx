"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Field, StateGlyph, inputClass } from "@/components/ui";
import { postJson, thrownText } from "@/lib/api-client";

const REASONS = [
  { value: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", label: "Not as described" },
  { value: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", label: "Not received" },
  { value: "UNAUTHORISED", label: "Unauthorised payment" },
];

/** Demo control (simulated PayPal only): the buyer opens a dispute against a paid milestone's capture. */
export function SimulateDispute({ options }: { options: Array<{ milestoneId: string; label: string }> }) {
  const router = useRouter();
  const [milestoneId, setMilestoneId] = useState(options[0]?.milestoneId ?? "");
  const [reason, setReason] = useState(REASONS[0]!.value);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "released" | "danger"; text: string } | null>(null);
  const [polling, setPolling] = useState(0);

  // The webhook lands ~1.5 s after the dispute opens and the draft a moment later: refresh a few times.
  useEffect(() => {
    if (polling === 0) return;
    const t = setTimeout(() => {
      router.refresh();
      setPolling((n) => (n >= 6 ? 0 : n + 1));
    }, 1500);
    return () => clearTimeout(t);
  }, [polling, router]);

  async function open() {
    setBusy(true);
    setNote(null);
    try {
      const res = await postJson<{ disputeId?: string; created?: boolean }>("/api/disputes/dev", { milestoneId, reason });
      const body = res.body;
      if (!res.ok || !body?.disputeId) {
        setNote({ tone: "danger", text: res.error });
        return;
      }
      setNote({ tone: "released", text: body.created ? `Dispute ${body.disputeId} opened. PayPal's webhook arrives in a moment.` : `Dispute ${body.disputeId} is already open for this payment.` });
      setPolling(1);
    } catch (e) {
      setNote({ tone: "danger", text: thrownText(e) });
    } finally {
      setBusy(false);
    }
  }

  if (options.length === 0) return <p className="text-[13px] text-fg-muted">No paid milestone without an open dispute.</p>;
  return (
    <div className="grid gap-4">
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] sm:items-end">
        <Field label="Paid milestone" htmlFor="sim-dispute-milestone">
          <select id="sim-dispute-milestone" className={inputClass} value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
            {options.map((o) => (
              <option key={o.milestoneId} value={o.milestoneId}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Buyer's reason" htmlFor="sim-dispute-reason">
          <select id="sim-dispute-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)}>
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Button variant="secondary" disabled={busy || !milestoneId} onClick={open}>
          {busy ? "Opening..." : "Open a dispute"}
        </Button>
      </div>
      {note ? (
        <p data-tone={note.tone} role="status" className="flex items-baseline gap-2 text-[13px] text-fg-muted">
          <StateGlyph glyph={note.tone === "danger" ? "cross" : "check"} className="text-tone" />
          <span className="min-w-0">{note.text}</span>
        </p>
      ) : null}
    </div>
  );
}
