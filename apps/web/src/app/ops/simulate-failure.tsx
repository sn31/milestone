"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Field, StateGlyph, inputClass } from "@/components/ui";
import { postJson, thrownText } from "@/lib/api-client";

const REASONS = [
  { value: "RECEIVER_UNREGISTERED", label: "Receiver not registered" },
  { value: "RECEIVER_ACCOUNT_LOCKED", label: "Account locked" },
  { value: "RISK_DECLINE", label: "Declined on risk" },
];

/**
 * Demo control (simulated PayPal only): makes the next payout item for a milestone come back failed, once, so its
 * release stops here for an operator. Lives at the foot of the queue, apart from real cases.
 */
export function SimulatePayoutFailure({ options, armed }: { options: Array<{ milestoneId: string; label: string }>; armed: Array<{ senderItemId: string; reason: string }> }) {
  const router = useRouter();
  const [milestoneId, setMilestoneId] = useState(options[0]?.milestoneId ?? "");
  const [party, setParty] = useState<"freelancer" | "partner">("freelancer");
  const [reason, setReason] = useState(REASONS[0]!.value);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "released" | "danger"; text: string } | null>(null);

  async function arm() {
    setBusy(true);
    setNote(null);
    try {
      const res = await postJson("/api/dev/paypal/fail", { milestoneId, party, reason });
      setNote(res.ok ? { tone: "released", text: `Armed: the next ${party} payout for ${milestoneId} fails. Release it to see the case arrive here.` } : { tone: "danger", text: res.error });
      if (res.ok) router.refresh();
    } catch (e) {
      setNote({ tone: "danger", text: thrownText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      {options.length === 0 ? (
        <p className="text-[13px] text-fg-muted">No milestone is waiting to be paid out.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_minmax(0,14rem)_auto] sm:items-end">
          <Field label="Milestone" htmlFor="sim-fail-milestone">
            <select id="sim-fail-milestone" className={inputClass} value={milestoneId} onChange={(e) => setMilestoneId(e.target.value)}>
              {options.map((o) => (
                <option key={o.milestoneId} value={o.milestoneId}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Payee" htmlFor="sim-fail-party">
            <select id="sim-fail-party" className={inputClass} value={party} onChange={(e) => setParty(e.target.value as "freelancer" | "partner")}>
              <option value="freelancer">Freelancer</option>
              <option value="partner">Partner</option>
            </select>
          </Field>
          <Field label="PayPal answers" htmlFor="sim-fail-reason">
            <select id="sim-fail-reason" className={inputClass} value={reason} onChange={(e) => setReason(e.target.value)}>
              {REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          <Button variant="secondary" disabled={busy || !milestoneId} onClick={arm}>
            {busy ? "Arming..." : "Arm a failure"}
          </Button>
        </div>
      )}
      {armed.length ? (
        <p className="font-mono text-[11px] text-fg-faint">
          armed: {armed.map((a) => `${a.senderItemId} (${a.reason.toLowerCase().replace(/_/g, " ")})`).join(", ")}
        </p>
      ) : null}
      {note ? (
        <p data-tone={note.tone} role="status" className="flex items-baseline gap-2 text-[13px] text-fg-muted">
          <StateGlyph glyph={note.tone === "danger" ? "cross" : "check"} className="text-tone" />
          <span className="min-w-0">{note.text}</span>
        </p>
      ) : null}
    </div>
  );
}
