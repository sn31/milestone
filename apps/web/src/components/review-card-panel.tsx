"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, CountdownRing, DUR, EASE, Eyebrow, Panel, StateGlyph, type ButtonVariant } from "@/components/ui";

type Action = "approve" | "veto" | "confirm_partial" | "hold";

// A one-second clock shared by every panel. 0 on the server, so the first paint makes no time claims.
function subscribe(cb: () => void) {
  const id = setInterval(cb, 1000);
  return () => clearInterval(id);
}
const clientNow = () => Math.floor(Date.now() / 1000) * 1000;
const serverNow = () => 0;

/** Human text for the 409 reasons the review route returns; falls back to the route's own error message. */
function refusalText(body: { error?: unknown; reason?: unknown; criteria?: unknown } | null, status: number): string {
  const error = typeof body?.error === "string" ? body.error : `request failed (${status})`;
  const reason = typeof body?.reason === "string" ? body.reason : null;
  if (!reason) return error;
  if (reason === "needs_operator") return "An earlier payout or refund for this milestone went wrong and needs an operator. Nothing more can be approved or stopped here.";
  if (reason === "review_window_closed") return "The review window has closed, so the release can no longer be vetoed.";
  if (reason === "required_criteria_not_passed") {
    const list = Array.isArray(body?.criteria) ? body.criteria.filter((c): c is string => typeof c === "string") : [];
    return list.length > 0 ? `Required criteria did not pass: ${list.join(", ")}.` : "Required criteria did not pass.";
  }
  if (/^(payout|refund)_(sent|succeeded|failed)$/.test(reason)) {
    const kind = reason.startsWith("payout") ? "payout" : "refund";
    return `The ${kind} has already been sent to PayPal, so it can no longer be changed or stopped.`;
  }
  return error;
}

export interface ReviewPanelProps {
  milestoneId: string;
  status: "review" | "needs_client";
  isClient: boolean;
  reviewEndsAt: string | null;
  /** Length of the whole review window in seconds, for the countdown ring. */
  windowSeconds: number;
  decisionAction: string | null;
  /** The decision's proposed payout in minor units (the share a partial would pay). */
  amountMinor?: number | null;
  /** That amount formatted, or null when there is none to show (no decision, or 0). */
  amountLabel: string | null;
  reason: string | null;
  /** Required criteria the delivery's verdict did not pass; the review route then refuses approve and confirm_partial. */
  requiredNotPassed?: string[];
}

interface Choice {
  action: Action;
  label: string;
  variant: ButtonVariant;
  /** What happens to the money, in one or two plain sentences. */
  consequence: ReactNode;
}

const RECOMMEND: Record<string, string> = {
  partial: "Release part of the payment",
  ask_client: "Your call",
  hold: "Hold the payment",
  release: "Release in full",
};

/**
 * Whether the client is offered "Release <amount>" (confirm_partial): only on a partial decision proposing a share above
 * zero. On ask_client the policy proposes no share (amountMinor 0), and the release job would turn a confirmed partial
 * of 0 into a full refund to the client, so the choices there are approve in full or hold.
 */
export function offersPartial(decisionAction: string | null, amountMinor: number | null | undefined): boolean {
  return decisionAction === "partial" && typeof amountMinor === "number" && Number.isFinite(amountMinor) && amountMinor > 0;
}

/** The client's choices on a milestone in review or needs_client, each with its consequence spelled out underneath. */
export function ReviewPanel(props: ReviewPanelProps) {
  const router = useRouter();
  const now = useSyncExternalStore(subscribe, clientNow, serverNow);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: Action) {
    setBusy(action);
    setError(null);
    try {
      const res = await fetch(`/api/milestones/${props.milestoneId}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (res.ok) {
        router.refresh();
        return;
      }
      setError(refusalText((await res.json().catch(() => null)) as Parameters<typeof refusalText>[0], res.status));
      // A 409 means the milestone moved on (payout sent, window closed): show the current state behind the message.
      if (res.status === 409) router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      setBusy(null);
    }
  }

  const amount = props.amountLabel;
  const endsAt = props.reviewEndsAt ? new Date(props.reviewEndsAt).getTime() : null;
  const known = now > 0;
  const closed = endsAt !== null && known && endsAt <= now;
  // Veto only while the window is known to be open (the route refuses it once reviewEndsAt has passed).
  const windowOpen = endsAt === null || (known && endsAt > now);
  // With a required criterion not passed the route refuses approve and confirm_partial, so only Hold is offered.
  const blocked = props.requiredNotPassed ?? [];
  const holdOnly = props.status === "needs_client" && blocked.length > 0;

  const choices: Choice[] = [];
  if (props.status === "review") {
    choices.push({
      action: "approve",
      label: "Approve now",
      variant: "primary",
      consequence: <>Pays {amount ?? "the milestone"} to the freelancer now instead of waiting for the window to close.</>,
    });
    if (windowOpen) {
      choices.push({
        action: "veto",
        label: "Veto release",
        variant: "danger",
        consequence: "Stops the automatic release. The money stays in escrow and the milestone moves to Held.",
      });
    }
  } else if (holdOnly) {
    choices.push({
      action: "hold",
      label: "Hold",
      variant: "primary",
      consequence: "Keeps the money in escrow and moves the milestone to Held. The freelancer can fix the work and resubmit.",
    });
  } else {
    const partial = offersPartial(props.decisionAction, props.amountMinor ?? null) && amount !== null;
    if (partial) {
      choices.push({
        action: "confirm_partial",
        label: `Release ${amount}`,
        variant: "primary",
        consequence: <>Pays {amount} to the freelancer and refunds the rest of the milestone to you.</>,
      });
    }
    // The route takes full approval on needs_client only when the agent asked the client.
    if (props.decisionAction === "ask_client") {
      choices.push({ action: "approve", label: "Approve in full", variant: "primary", consequence: "Pays the whole milestone to the freelancer." });
    }
    choices.push({
      action: "hold",
      label: "Hold",
      variant: props.decisionAction === "partial" || props.decisionAction === "ask_client" ? "danger" : "primary",
      consequence: "Keeps the money in escrow and moves the milestone to Held. The freelancer can resubmit.",
    });
  }

  const tone = props.status === "review" ? "review" : "needs";

  return (
    <Panel variant="sunken" tone={tone} className="mt-5">
      {props.status === "review" ? (
        <div className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-7">
          {props.reviewEndsAt ? (
            <CountdownRing endsAt={props.reviewEndsAt} totalSeconds={props.windowSeconds} label="until release" closedLabel="releasing" />
          ) : null}
          <div className="min-w-0">
            <Eyebrow>Review window</Eyebrow>
            <p className="type-display-s mt-3 text-fg">
              {closed ? "The window has closed. The release is being processed." : <>Releases on its own when the window closes</>}
            </p>
            <p className="mt-2 max-w-[56ch] text-[13px] leading-relaxed text-fg-muted">
              {closed
                ? "Nothing can be vetoed now; the payout goes to PayPal and is confirmed by its webhook."
                : <>The agent verified the work. {amount ?? "The payment"} moves from escrow to the freelancer unless the client vetoes first.</>}
            </p>
          </div>
        </div>
      ) : (
        <div className="min-w-0">
          <Eyebrow>The agent recommends</Eyebrow>
          <p className="type-display-s mt-3 text-fg">
            {RECOMMEND[props.decisionAction ?? "ask_client"] ?? "Your call"}
            {props.decisionAction === "partial" && amount ? (
              <>
                {": "}
                <span className="font-mono text-[0.85em] tracking-[-0.01em] text-tone tabular">{amount}</span>
              </>
            ) : null}
          </p>
          {props.reason ? <p className="mt-2 max-w-[64ch] text-[13px] leading-relaxed text-fg-muted">{props.reason}</p> : null}
        </div>
      )}

      {holdOnly ? (
        <div data-tone="held" className="mt-5 rounded-control border border-tone bg-tone-soft px-4 py-3">
          <p className="flex items-center gap-2 text-[13px] text-fg">
            <StateGlyph glyph="pause" className="text-tone" />
            Required criteria did not pass, so only Hold is available.
          </p>
          <ul className="mt-2 space-y-1 pl-[18px]">
            {blocked.map((c) => (
              <li key={c} className="font-mono text-[12px] leading-relaxed text-fg-muted">
                {c}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {props.isClient ? (
        <div className={`mt-6 grid gap-5 border-t border-hairline pt-5 ${choices.length >= 3 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {choices.map((c) => (
            <div key={c.action} className="grid content-start gap-2.5">
              <Button variant={c.variant} disabled={busy !== null} onClick={() => act(c.action)} className="w-full">
                {busy === c.action ? "Working..." : c.label}
              </Button>
              <p className="text-[12.5px] leading-relaxed text-fg-muted">{c.consequence}</p>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-6 flex items-center gap-2 border-t border-hairline pt-5 font-mono text-[12px] text-fg-faint">
          <span aria-hidden className={`size-1.5 rounded-full bg-tone ${props.status === "review" && !closed ? "animate-pulse-dot" : ""}`} />
          {props.status === "review" ? "The client can approve early or veto until the window closes." : "Waiting for the client to decide."}
        </p>
      )}

      <AnimatePresence>
        {error ? (
          <motion.p
            role="alert"
            data-tone="danger"
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DUR.quick, ease: EASE.glide }}
            className="mt-4 rounded-control border border-tone bg-tone-soft px-3 py-2 text-[13px] text-tone"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </Panel>
  );
}
