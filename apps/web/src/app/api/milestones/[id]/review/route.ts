import { and, eq, inArray } from "drizzle-orm";
import {
  OP_KINDS,
  RELEASABLE_STATUSES,
  asRecord,
  asString,
  audit,
  criteria,
  decisionDeliveryId,
  deliveries,
  enqueue,
  milestones,
  paypalOps,
  requiredNotPassed,
  transition,
  type MilestoneStatus,
} from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isContractClient } from "@/lib/session";
import { loadMilestone } from "../../_shared";

const ACTIONS = ["approve", "veto", "confirm_partial", "hold"] as const;
type Action = (typeof ACTIONS)[number];

/** Which statuses each client action is allowed from. */
const ALLOWED: Record<Action, ReadonlySet<MilestoneStatus>> = {
  approve: RELEASABLE_STATUSES,
  veto: new Set(["review"]),
  confirm_partial: new Set(["needs_client"]),
  hold: new Set(["needs_client"]),
};

type Refusal = { error: string; status: number; extra?: Record<string, unknown> };
type Outcome = { refused: Refusal } | { queued: string } | { held: boolean };

/** The delivery a claimed paypal_ops row was claimed for (the release job stores request.claim.deliveryId). */
function claimDeliveryId(request: unknown): string | null {
  return asString(asRecord(asRecord(request).claim).deliveryId);
}

/**
 * The client's answer during the review window or on a needs_client decision. approve/confirm_partial enqueue the
 * release job (it re-derives the outcome from the DB under the same row lock); veto/hold move the milestone to held.
 * Everything is decided under SELECT ... FOR UPDATE on the milestone row, the lock the release job takes before it
 * claims the payout, so a veto/hold either lands before the payout is claimed or is refused.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  const { contract: c } = found;
  if (!isContractClient(actor, c)) return jsonError("only the contract's client can respond", 403);

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = ACTIONS.find((a) => a === body?.action);
  if (!action) return jsonError(`action must be one of ${ACTIONS.join(", ")}`, 400);
  const stops = action === "veto" || action === "hold";

  const outcome = await db.transaction(async (tx): Promise<Outcome> => {
    const refuse = (error: string, status = 409, extra?: Record<string, unknown>): Outcome => ({ refused: { error, status, ...(extra ? { extra } : {}) } });
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, id)).for("update");
    if (!m) return refuse("milestone not found", 404);
    if (!ALLOWED[action].has(m.status)) return refuse(`cannot ${action} while milestone is ${m.status}`);
    if (action === "approve" && m.status === "needs_client" && m.decision?.action !== "ask_client") {
      return refuse("full approval is only offered when the agent asked the client");
    }
    if (action === "confirm_partial" && m.decision?.action !== "partial" && m.decision?.action !== "ask_client") {
      return refuse("there is no proposed partial amount to confirm");
    }

    // One payout attempt per milestone. An op claimed for this decision's delivery means the payout (or refund) has
    // started and nothing can stop or change it; an op claimed for any other delivery means an earlier attempt went
    // wrong and the milestone needs an operator (the release job refuses to run for it again).
    const deliveryId = decisionDeliveryId(m.decision);
    const claimed = await tx
      .select({ kind: paypalOps.kind, status: paypalOps.status, request: paypalOps.request })
      .from(paypalOps)
      .where(and(eq(paypalOps.key, m.id), inArray(paypalOps.kind, [OP_KINDS.payout, OP_KINDS.refund]), inArray(paypalOps.status, ["sent", "succeeded", "failed"])));
    if (claimed.length > 0) {
      const mine = claimed.find((o) => claimDeliveryId(o.request) === deliveryId);
      if (mine) return refuse(`cannot ${action}: the ${mine.kind} has already been sent to PayPal`, 409, { reason: `${mine.kind}_${mine.status}` });
      return refuse(`cannot ${action}: an earlier payout or refund for this milestone needs an operator`, 409, { reason: "needs_operator" });
    }
    const now = new Date();
    if (stops && m.reviewEndsAt && m.reviewEndsAt.getTime() <= now.getTime()) {
      return refuse(`cannot ${action}: the review window closed at ${m.reviewEndsAt.toISOString()}`, 409, { reason: "review_window_closed" });
    }

    if (!stops) {
      if (!deliveryId) return refuse("the decision is not tied to a delivery; re-run verification");
      const delivery = await tx.query.deliveries.findFirst({ where: eq(deliveries.id, deliveryId) });
      const rows = await tx.query.criteria.findMany({ where: eq(criteria.milestoneId, m.id) });
      const blocked = requiredNotPassed(delivery?.verdict, rows);
      if (blocked.length > 0) return refuse(`cannot ${action}: required criteria did not pass`, 409, { reason: "required_criteria_not_passed", criteria: blocked });
    }

    await tx.update(milestones).set({ clientResponse: action }).where(eq(milestones.id, m.id));
    const entry = { actor: actor.userId, event: `client.${action}`, detail: { status: m.status, deliveryId } };
    if (!stops) {
      await audit(tx, { ...entry, milestoneId: m.id, contractId: c.id });
      return { queued: deliveryId! };
    }
    return { held: await transition(tx, m.id, "held", entry) };
  });

  if ("refused" in outcome) return jsonError(outcome.refused.error, outcome.refused.status, outcome.refused.extra);
  if ("queued" in outcome) {
    // After commit, so the job sees the client's answer. Release job data: { milestoneId, deliveryId }.
    await enqueue("release", id, { deliveryId: outcome.queued }, { dedupe: `client-${action}-${outcome.queued}` });
    return json({ ok: true, queued: "release" });
  }
  return json({ ok: true, status: "held", changed: outcome.held });
}
