import { eq } from "drizzle-orm";
import { milestones } from "@milestone/core";
import { approveSimulatedOrder } from "@milestone/money";
import { getDb } from "@/lib/db";
import { jsonError, noStore } from "@/lib/http";
import { notSimulated } from "../_guard";

export const dynamic = "force-dynamic";

/**
 * Simulated PayPal's checkout page: the order's approve link points here. Marks the order APPROVED and sends the
 * buyer back to the contract page with ?approved=<orderId>&milestone=<id>, where the fund button captures it.
 * The order's reference_id is the milestone id; its contract comes from the database.
 */
export async function GET(req: Request) {
  const blocked = notSimulated();
  if (blocked) return blocked;
  const url = new URL(req.url);
  const orderId = url.searchParams.get("order") ?? "";
  if (!orderId) return jsonError("order is required", 400);

  const order = approveSimulatedOrder(orderId);
  if (!order) return jsonError(`simulated order ${orderId} not found`, 404);
  const milestoneId = order.referenceId;
  if (!milestoneId) return jsonError("order has no reference_id", 409);

  const [m] = await getDb().select({ id: milestones.id, contractId: milestones.contractId }).from(milestones).where(eq(milestones.id, milestoneId)).limit(1);
  if (!m) return jsonError(`milestone ${milestoneId} not found`, 404);

  const base = (process.env.APP_URL || url.origin).replace(/\/+$/, "");
  const back = new URL(`${base}/contracts/${encodeURIComponent(m.contractId)}`);
  back.searchParams.set("approved", order.id);
  back.searchParams.set("milestone", m.id);
  return new Response(null, { status: 303, headers: { ...noStore, Location: back.toString() } });
}
