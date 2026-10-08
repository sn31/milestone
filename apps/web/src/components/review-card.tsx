"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Action = "approve" | "veto" | "confirm_partial" | "hold";

function timeLeft(ms: number): string {
  if (ms <= 0) return "window closed";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h left` : h ? `${h}h ${m}m left` : `${m}m ${s % 60}s left`;
}

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

export function ReviewCard(props: {
  milestoneId: string;
  status: "review" | "needs_client";
  isClient: boolean;
  reviewEndsAt: string | null;
  decisionAction: string | null;
  amountLabel: string | null;
  reason: string | null;
}) {
  const router = useRouter();
  const [now, setNow] = useState<number | null>(null);
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

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

  const btn = (action: Action, label: string, primary = false) => (
    <button
      key={action}
      type="button"
      disabled={busy !== null}
      onClick={() => act(action)}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium disabled:cursor-wait disabled:opacity-50 ${primary ? "bg-zinc-900 text-white shadow-sm hover:bg-zinc-700 dark:bg-white dark:text-zinc-900 dark:hover:bg-zinc-200" : "border border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800"}`}
    >
      {busy === action ? "Working..." : label}
    </button>
  );

  const endsAt = props.reviewEndsAt ? new Date(props.reviewEndsAt).getTime() : null;
  // Veto only while the window is known to be open (the route refuses it once reviewEndsAt has passed).
  const windowOpen = endsAt === null || (now !== null && endsAt > now);

  const buttons: React.ReactNode[] = [];
  if (props.status === "review") {
    buttons.push(btn("approve", "Approve now", true));
    if (windowOpen) buttons.push(btn("veto", "Veto"));
  } else {
    if (props.decisionAction === "partial") buttons.push(btn("confirm_partial", "Release partial", true));
    if (props.decisionAction === "ask_client") buttons.push(btn("approve", "Approve full", true));
    buttons.push(btn("hold", "Hold"));
    if (props.decisionAction === "ask_client") buttons.splice(1, 0, btn("confirm_partial", "Release partial"));
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-indigo-200 bg-indigo-50/60 p-4 text-sm dark:border-indigo-900 dark:bg-indigo-950/40">
      {props.status === "review" ? (
        <p>
          Review window: {endsAt !== null && now !== null ? timeLeft(endsAt - now) : "..."}.{" "}
          {endsAt !== null && now !== null && endsAt <= now ? "The window has closed; the release is being processed." : "Funds release automatically when it closes unless the client vetoes."}
        </p>
      ) : (
        <p>
          The agent recommends: <span className="font-medium">{(props.decisionAction ?? "ask client").replaceAll("_", " ")}</span>
          {props.amountLabel ? <> with a proposed amount of <span className="font-medium">{props.amountLabel}</span></> : null}.
          {props.reason ? <span className="mt-1 block text-zinc-600 dark:text-zinc-400">{props.reason}</span> : null}
        </p>
      )}
      {props.isClient ? <div className="flex flex-wrap gap-2">{buttons}</div> : <p className="text-zinc-500 dark:text-zinc-400">Waiting for the client to respond.</p>}
      {error ? <p role="alert" className="text-rose-700 dark:text-rose-400">{error}</p> : null}
    </div>
  );
}
