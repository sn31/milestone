"use client";

import { useState } from "react";
import type { deliveries, milestones } from "@milestone/core";
import { EvidencePanel, toEvidenceItems } from "@/components/evidence-panel";

type DeliveryRow = typeof deliveries.$inferSelect;
type Decision = NonNullable<(typeof milestones.$inferSelect)["decision"]>;

interface CriterionRow {
  criterion_id: string;
  status: string;
  confidence: number;
  evidence_ids: string[];
  rationale: string;
}

const STATUS_STYLE: Record<string, string> = {
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  fail: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  unclear: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
};

const RESULT_STYLE: Record<string, string> = {
  pass: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  partial: "bg-teal-100 text-teal-800 dark:bg-teal-950 dark:text-teal-300",
  fail: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};
const NEUTRAL = "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300";

function rowsOf(verdict: DeliveryRow["verdict"]): CriterionRow[] {
  const list = verdict && (verdict as { criteria?: unknown }).criteria;
  return Array.isArray(list) ? (list as CriterionRow[]) : [];
}

/** Panels taller than this many rows start collapsed behind the "Evidence (n)" toggle. */
const OPEN_UP_TO = 3;

/**
 * The delivery's evidence (deliveries.evidence) in the AG Grid panel, behind an "Evidence (n)" toggle. Client-side
 * because toEvidenceItems lives in the client module evidence-panel.tsx; the grid is mounted only while open.
 */
function EvidenceSection({ evidence }: { evidence: unknown[] | null }) {
  const items = toEvidenceItems(evidence);
  const [open, setOpen] = useState(items.length <= OPEN_UP_TO);
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-sm font-medium text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white"
      >
        <span aria-hidden className="mr-1 inline-block w-3">{open ? "\u25BE" : "\u25B8"}</span>
        Evidence ({items.length})
      </button>
      {open ? <EvidencePanel items={items} /> : null}
    </div>
  );
}

export function VerdictView({
  delivery,
  decision,
  descriptions = {},
  showEvidence = false,
}: {
  delivery: DeliveryRow | null;
  decision: Decision | null;
  descriptions?: Record<string, string>;
  /** Show the delivery's evidence panel below the verdict and decision. */
  showEvidence?: boolean;
}) {
  if (!delivery) return <p className="mt-3 text-sm text-zinc-500 dark:text-zinc-400">No delivery yet.</p>;
  const rows = rowsOf(delivery.verdict);
  const result = delivery.result ?? (delivery.verifiedAt ? "no result" : "verifying");
  return (
    <div className="mt-3 space-y-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <span className="text-zinc-500 dark:text-zinc-400">Verifier result</span>
        <span className={`rounded px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${RESULT_STYLE[result] ?? NEUTRAL}`}>{result}</span>
        <span className="font-mono text-xs text-zinc-400">{delivery.ref}</span>
        {delivery.suspectedInjection ? (
          <span className="rounded bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-800 dark:bg-rose-950 dark:text-rose-300">suspected prompt injection</span>
        ) : null}
      </p>
      {rows.length > 0 ? (
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
          {rows.map((r) => (
            <li key={r.criterion_id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? NEUTRAL}`}>{r.status}</span>
                <span>{descriptions[r.criterion_id] ?? r.criterion_id}</span>
                <span className="text-xs text-zinc-500 tabular-nums dark:text-zinc-400">confidence {Math.round(r.confidence * 100)}%</span>
              </div>
              <p className="text-zinc-600 dark:text-zinc-400">{r.rationale}</p>
              {r.evidence_ids?.length ? <p className="font-mono text-xs text-zinc-500">evidence: {r.evidence_ids.join(", ")}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {decision ? (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900">
          <p>
            <span className="text-zinc-500 dark:text-zinc-400">Policy decision</span>{" "}
            <span className="font-medium">{decision.action.replaceAll("_", " ")}</span>
          </p>
          <p className="text-zinc-600 dark:text-zinc-400">{decision.reason}</p>
          {decision.ruleIds.length ? <p className="font-mono text-xs text-zinc-500">rules: {decision.ruleIds.join(", ")}</p> : null}
        </div>
      ) : null}
      {showEvidence ? <EvidenceSection evidence={delivery.evidence ?? null} /> : null}
    </div>
  );
}
