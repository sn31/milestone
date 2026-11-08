import { eq } from "drizzle-orm";
import { AUDIT_EVENTS, AUP_REFUSAL_TEXT, OP_KINDS, audit, auditAupRefusal, aupGateNow, milestones, recordOpResult, requestIdFor } from "@milestone/core";
import { createOrder } from "@milestone/money";
import { ensureAup } from "@/lib/aup";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { paypal } from "@/lib/paypal";
import { getActor, isContractClient } from "@/lib/session";
import { loadMilestone, paypalErrorResponse } from "../../_shared";

/**
 * Creates (or replays) the PayPal order that funds one milestone. Called by the JS SDK's createOrder.
 * The PayPal-Request-Id comes from paypal_ops ("order", milestoneId), so repeated clicks get the same order back.
 * Refused (409, reason aup_*) while the contract's PayPal Acceptable Use Policy check is not clear.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  const { milestone: m, contract: c } = found;

  if (!isContractClient(actor, c)) return jsonError("only the contract's client can fund a milestone", 403);
  if (c.status !== "active") return jsonError(`contract is ${c.status}; both parties must approve before funding`, 409);
  if (m.status !== "draft") return jsonError(`milestone is already ${m.status}`, 409);
  // PayPal Acceptable Use Policy: re-check a contract whose text changed since its last check, then refuse anything
  // but clear, keywords only or cleared by an operator. No order is created, so nothing can be captured.
  await ensureAup(db, c.id, actor.userId);
  const aup = await aupGateNow(db, c.id);
  if ("refused" in aup) {
    await auditAupRefusal(db, { actor: actor.userId, contractId: c.id, milestoneId: m.id, action: "fund", reason: aup.refused, via: "order_route" });
    return jsonError(`cannot fund: ${AUP_REFUSAL_TEXT[aup.refused]}`, 409, { reason: aup.refused });
  }

  const base = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const back = `${base}/contracts/${c.id}`;
  const requestId = await requestIdFor(db, OP_KINDS.order, m.id);

  let orderId: string;
  try {
    const order = await createOrder(paypal(), {
      amountMinor: m.amountMinor,
      currency: c.currency,
      referenceId: m.id,
      description: `${c.title}: ${m.title}`.slice(0, 127),
      returnUrl: `${back}?funding=returned`,
      cancelUrl: `${back}?funding=cancelled`,
      requestId,
    });
    orderId = order.id;
    await recordOpResult(db, requestId, { status: "succeeded", paypalId: order.id, response: order });
  } catch (e) {
    await recordOpResult(db, requestId, { status: "failed", response: { error: e instanceof Error ? e.message : String(e) } });
    return paypalErrorResponse(e);
  }

  if (m.paypalOrderId !== orderId) {
    await db.update(milestones).set({ paypalOrderId: orderId }).where(eq(milestones.id, m.id));
    await audit(db, { actor: actor.userId, event: AUDIT_EVENTS.milestoneOrderCreated, milestoneId: m.id, contractId: c.id, detail: { orderId } });
  }
  return json({ orderId });
}
