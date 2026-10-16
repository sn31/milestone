import { enqueue } from "@milestone/core";
import { json, jsonError } from "@/lib/http";
import { getActor, isOperator } from "@/lib/session";

/**
 * POST /api/ops/reconcile: an operator asks for a reconciliation now. Enqueues the worker's "reconcile" job, which
 * reads PayPal's transactions through PayPal's MCP server (list_transactions, read-only) and records ops.reconciled.
 * One request per minute is queued; a repeat inside the minute is a no-op. Agents (any Authorization header) are refused:
 * operator actions are for people.
 */
export async function POST(req: Request) {
  if (req.headers.get("authorization")) return jsonError("operator actions are not open to agents", 403, { reason: "agent_not_allowed" });
  const actor = await getActor();
  if (!isOperator(actor)) return jsonError("only the partner or platform can reconcile", 403);
  const minute = new Date().toISOString().slice(0, 16);
  try {
    const jobId = await enqueue("reconcile", "ops", { trigger: actor.userId }, { dedupe: `reconcile-${minute}` });
    return json({ ok: true, queued: "reconcile", jobId: jobId ?? null });
  } catch (e) {
    console.error("reconcile enqueue failed", e);
    return jsonError("could not queue the reconciliation; is the worker running?", 503);
  }
}
