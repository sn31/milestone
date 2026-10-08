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
  pass: "bg-emerald-100 text-emerald-800",
  fail: "bg-red-100 text-red-800",
  unclear: "bg-amber-100 text-amber-800",
};

function rowsOf(verdict: DeliveryRow["verdict"]): CriterionRow[] {
  const list = verdict && (verdict as { criteria?: unknown }).criteria;
  return Array.isArray(list) ? (list as CriterionRow[]) : [];
}

export function VerdictView({ delivery, decision, descriptions = {} }: { delivery: DeliveryRow | null; decision: Decision | null; descriptions?: Record<string, string> }) {
  if (!delivery) return <p className="mt-3 text-sm text-zinc-500">No delivery yet.</p>;
  const rows = rowsOf(delivery.verdict);
  return (
    <div className="mt-3 space-y-3 text-sm">
      <p>
        Result: <span className="font-medium">{delivery.result ?? (delivery.verifiedAt ? "no result" : "verifying")}</span>
        {delivery.suspectedInjection ? <span className="ml-2 text-red-700">suspected prompt injection</span> : null}
      </p>
      {rows.length > 0 ? (
        <ul className="divide-y divide-zinc-200 rounded border border-zinc-200">
          {rows.map((r) => (
            <li key={r.criterion_id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[r.status] ?? "bg-zinc-100 text-zinc-800"}`}>{r.status}</span>
                <span>{descriptions[r.criterion_id] ?? r.criterion_id}</span>
                <span className="text-xs text-zinc-500">confidence {Math.round(r.confidence * 100)}%</span>
              </div>
              <p className="text-zinc-600">{r.rationale}</p>
              {r.evidence_ids?.length ? <p className="font-mono text-xs text-zinc-500">evidence: {r.evidence_ids.join(", ")}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {decision ? (
        <div className="rounded border border-zinc-200 p-3">
          <p>
            Policy decision: <span className="font-medium">{decision.action.replace("_", " ")}</span>
          </p>
          <p className="text-zinc-600">{decision.reason}</p>
          {decision.ruleIds.length ? <p className="font-mono text-xs text-zinc-500">rules: {decision.ruleIds.join(", ")}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
