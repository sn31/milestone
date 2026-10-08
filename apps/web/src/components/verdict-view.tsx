import type { deliveries, milestones } from "@milestone/core";

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

export function VerdictView({ delivery, decision, descriptions = {} }: { delivery: DeliveryRow | null; decision: Decision | null; descriptions?: Record<string, string> }) {
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
    </div>
  );
}
