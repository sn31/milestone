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
      if (!res.ok) setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `request failed (${res.status})`);
      else router.refresh();
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
      className={`rounded px-3 py-1.5 text-sm disabled:opacity-50 ${primary ? "bg-zinc-900 text-white" : "border border-zinc-300"}`}
    >
      {busy === action ? "Working..." : label}
    </button>
  );

  const buttons: React.ReactNode[] = [];
  if (props.status === "review") buttons.push(btn("approve", "Approve now", true), btn("veto", "Veto"));
  else {
    if (props.decisionAction === "partial") buttons.push(btn("confirm_partial", "Release partial", true));
    if (props.decisionAction === "ask_client") buttons.push(btn("approve", "Approve full", true));
    buttons.push(btn("hold", "Hold"));
    if (props.decisionAction === "ask_client") buttons.splice(1, 0, btn("confirm_partial", "Release partial"));
  }

  return (
    <div className="mt-3 space-y-2 rounded border border-zinc-200 p-3 text-sm">
      {props.status === "review" ? (
        <p>
          Review window: {props.reviewEndsAt && now !== null ? timeLeft(new Date(props.reviewEndsAt).getTime() - now) : "..."}. Funds release automatically when it closes unless the client vetoes.
        </p>
      ) : (
        <p>
          The agent recommends: <span className="font-medium">{(props.decisionAction ?? "ask client").replace("_", " ")}</span>
          {props.amountLabel ? <> with a proposed amount of <span className="font-medium">{props.amountLabel}</span></> : null}.
          {props.reason ? <span className="block text-zinc-600">{props.reason}</span> : null}
        </p>
      )}
      {props.isClient ? <div className="flex flex-wrap gap-2">{buttons}</div> : <p className="text-zinc-500">Waiting for the client.</p>}
      {error ? <p role="alert" className="text-red-700">{error}</p> : null}
    </div>
  );
}
