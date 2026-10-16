import { and, desc, eq, inArray } from "drizzle-orm";
import {
  OP_KINDS,
  RELEASABLE_STATUSES,
  agentMandates,
  asRecord,
  asString,
  audit,
  criteria,
  decisionDeliveryId,
  deliveries,
  enqueue,
  mandateAllows,
  milestones,
  paypalOps,
  requiredNotPassed,
  transition,
  type MandateAction,
  type MilestoneStatus,
} from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isContractClient, resolveAgentActor, type Actor, type AgentActor } from "@/lib/session";
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

/**
 * The mandate action an agent needs for each review action. confirm_partial has none: a partial release is a policy
 * "partial"/"ask_client" outcome that only the human client can accept, so an agent is always refused it.
 */
const AGENT_NEEDS: Record<Action, MandateAction | null> = { approve: "approve", veto: "hold", hold: "hold", confirm_partial: null };

/** The rule id of the policy's own release decision (decide(): every criterion passed at or above the threshold). */
const POLICY_RELEASE_RULE = "P6";

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
 *
 * Agents: with "Authorization: Bearer <token>" the caller is the mandate's agent acting as the mandate's user (401
 * invalid_token, 403 mandate_expired / mandate_revoked when the token is not live). An agent's approve is accepted
 * only while the milestone is in review on the policy's release decision (P6) for the current delivery, with every
 * required criterion passed and the amount within the mandate's cap (403 mandate_missing_action / mandate_cap_exceeded,
 * 409 not_release_decision / required_criteria_not_passed otherwise); veto and hold need "hold" in the mandate;
 * confirm_partial is never an agent's (409 not_release_decision). Accepted and refused agent actions are audited
 * with actor agentActor(mandate). Humans (no Authorization header) are unchanged.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  // An agent presents "Authorization: Bearer <token>" and acts as its mandate's user; humans keep the cookie identity.
  const resolved = await resolveAgentActor(req, db);
  if (resolved && "refused" in resolved) return jsonError(resolved.refused.error, resolved.refused.status, { reason: resolved.refused.reason });
  const agent: AgentActor | null = resolved?.agent ?? null;
  const actor: Actor = agent ?? (await getActor());
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

    if (agent) {
      // An agent can only make a release the policy already decided happen sooner, never one it would not.
      const needs = AGENT_NEEDS[action];
      if (!needs) return refuse(`an agent cannot ${action}: only the client can accept a partial release`, 409, { reason: "not_release_decision" });
      // Re-read the mandate under FOR SHARE: a concurrent revoke either lands first (refused here) or waits for this commit.
      const [mandate] = await tx.select().from(agentMandates).where(eq(agentMandates.id, agent.mandate.id)).for("share");
      if (!mandate) return refuse("the mandate no longer exists", 403, { reason: "mandate_revoked" });
      const amount = needs === "approve" ? Math.max(m.amountMinor, m.decision?.amountMinor ?? 0) : undefined;
      const allowed = mandateAllows(mandate, needs, amount, { currency: c.currency });
      if ("refused" in allowed) {
        const extra = allowed.refused === "mandate_cap_exceeded" ? { amountMinor: amount, capMinor: mandate.approveCapMinor, currency: c.currency, mandateCurrency: mandate.currency } : {};
        return refuse(`the mandate does not cover ${action}`, 403, { reason: allowed.refused, ...extra });
      }
    }

    if (!ALLOWED[action].has(m.status)) return refuse(`cannot ${action} while milestone is ${m.status}`);

    if (agent && action === "approve") {
      // In review, on the policy's own release decision (P6), made for the milestone's current (latest) delivery.
      const decision = m.decision;
      const decided = decisionDeliveryId(decision);
      const [latest] = await tx.select({ id: deliveries.id }).from(deliveries).where(eq(deliveries.milestoneId, m.id)).orderBy(desc(deliveries.receivedAt)).limit(1);
      const isRelease = m.status === "review" && decision?.action === "release" && Array.isArray(decision.ruleIds) && decision.ruleIds.includes(POLICY_RELEASE_RULE);
      if (!isRelease || !decided || decided !== latest?.id) {
        return refuse("an agent may only approve the policy's release decision for the current delivery", 409, { reason: "not_release_decision" });
      }
    }
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
    const via = agent ? { via: "agent", mandateId: agent.mandate.id, agentName: agent.mandate.agentName, onBehalfOf: agent.userId } : {};
    const entry = { actor: agent ? agent.auditActor : actor.userId, event: `client.${action}`, detail: { status: m.status, deliveryId, ...via } };
    if (!stops) {
      await audit(tx, { ...entry, milestoneId: m.id, contractId: c.id });
      return { queued: deliveryId! };
    }
    return { held: await transition(tx, m.id, "held", entry) };
  });

  if ("refused" in outcome) {
    if (agent && outcome.refused.status !== 404) {
      // Refused agent attempts are on the record too.
      await audit(db, {
        actor: agent.auditActor,
        event: `agent.${action}_refused`,
        milestoneId: id,
        contractId: c.id,
        detail: { mandateId: agent.mandate.id, reason: outcome.refused.extra?.reason ?? null, error: outcome.refused.error },
      });
    }
    return jsonError(outcome.refused.error, outcome.refused.status, outcome.refused.extra);
  }
  if ("queued" in outcome) {
    // After commit, so the job sees the client's answer. Release job data: { milestoneId, deliveryId }.
    await enqueue("release", id, { deliveryId: outcome.queued }, { dedupe: `client-${action}-${outcome.queued}` });
    return json({ ok: true, queued: "release" });
  }
  return json({ ok: true, status: "held", changed: outcome.held });
}
