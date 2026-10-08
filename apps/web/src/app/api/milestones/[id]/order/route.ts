import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { audit, milestones, recordOpResult, requestIdFor } from "@milestone/core";
import { createOrder } from "@milestone/money";
import { getDb } from "@/lib/db";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { isContractClient, jsonError, loadMilestone, paypalErrorResponse } from "../../_shared";

/**
 * Creates (or replays) the PayPal order that funds one milestone. Called by the JS SDK's createOrder.
 * The PayPal-Request-Id comes from paypal_ops ("order", milestoneId), so repeated clicks get the same order back.
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

  const base = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, "");
  const back = `${base}/contracts/${c.id}`;
  const requestId = await requestIdFor(db, "order", m.id);

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
    await audit(db, { actor: actor.userId, event: "milestone.order_created", milestoneId: m.id, contractId: c.id, detail: { orderId } });
  }
  return NextResponse.json({ orderId }, { headers: { "Cache-Control": "no-store" } });
}
