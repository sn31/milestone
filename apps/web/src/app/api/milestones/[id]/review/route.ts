import { NextResponse } from "next/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { audit, criteria, deliveries, enqueue, milestones, paypalOps, transition, type Db } from "@milestone/core";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { isContractClient, jsonError, loadMilestone } from "../../_shared";

const ACTIONS = ["approve", "veto", "confirm_partial", "hold"] as const;
type Action = (typeof ACTIONS)[number];

/** Which statuses each client action is allowed from. */
const ALLOWED: Record<Action, readonly string[]> = {
  approve: ["review", "needs_client"],
  veto: ["review"],
  confirm_partial: ["needs_client"],
  hold: ["needs_client"],
};

type Refusal = { error: string; status: number; extra?: Record<string, unknown> };
type Outcome = { refused: Refusal } | { queued: string } | { held: boolean };

/** The delivery the decision was made for (the verify job writes decision.deliveryId). */
function decisionDeliveryId(decision: unknown): string | null {
  const v = decision && typeof decision === "object" ? (decision as Record<string, unknown>).deliveryId : undefined;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Required criteria whose verdict is not a pass; a criterion the verdict does not mention counts as not passed. */
function requiredNotPassed(verdict: unknown, rows: ReadonlyArray<{ id: string; required: boolean; description: string }>): string[] {
  const list = verdict && typeof verdict === "object" ? (verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(list)) {
    for (const r of list) if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
  }
  return rows.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
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
    const t = tx as unknown as Db;
    const refuse = (error: string, status = 409, extra?: Record<string, unknown>): Outcome => ({ refused: { error, status, ...(extra ? { extra } : {}) } });
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, id)).for("update");
    if (!m) return refuse("milestone not found", 404);
    if (!ALLOWED[action].includes(m.status)) return refuse(`cannot ${action} while milestone is ${m.status}`);
    if (action === "approve" && m.status === "needs_client" && m.decision?.action !== "ask_client") {
      return refuse("full approval is only offered when the agent asked the client");
    }
    if (action === "confirm_partial" && m.decision?.action !== "partial" && m.decision?.action !== "ask_client") {
      return refuse("there is no proposed partial amount to confirm");
    }

    // Has a payout (any attempt) or the refund already been claimed or sent? Then nothing can stop or change it.
    const started = await tx
      .select({ kind: paypalOps.kind, status: paypalOps.status })
      .from(paypalOps)
      .where(
        and(
          inArray(paypalOps.status, ["sent", "succeeded"]),
          or(
            and(eq(paypalOps.kind, "payout"), or(eq(paypalOps.key, m.id), sql`starts_with(${paypalOps.key}, ${`${m.id}:`})`)),
            and(eq(paypalOps.kind, "refund"), eq(paypalOps.key, m.id)),
          ),
        ),
      )
      .limit(1);
    if (started[0]) {
      return refuse(`cannot ${action}: the ${started[0].kind} has already been sent to PayPal`, 409, { reason: `${started[0].kind}_${started[0].status}` });
    }
    const now = new Date();
    if (stops && m.reviewEndsAt && m.reviewEndsAt.getTime() <= now.getTime()) {
      return refuse(`cannot ${action}: the review window closed at ${m.reviewEndsAt.toISOString()}`, 409, { reason: "review_window_closed" });
    }

    const deliveryId = decisionDeliveryId(m.decision);
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
      await audit(t, { ...entry, milestoneId: m.id, contractId: c.id });
      return { queued: deliveryId! };
    }
    return { held: await transition(t, m.id, "held", entry) };
  });

  if ("refused" in outcome) return jsonError(outcome.refused.error, outcome.refused.status, outcome.refused.extra);
  if ("queued" in outcome) {
    // After commit, so the job sees the client's answer. Release job data: { milestoneId, deliveryId }.
    await enqueue("release", id, { deliveryId: outcome.queued }, { dedupe: `client-${action}-${outcome.queued}` });
    return NextResponse.json({ ok: true, queued: "release" }, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ ok: true, status: "held", changed: outcome.held }, { headers: { "Cache-Control": "no-store" } });
}
