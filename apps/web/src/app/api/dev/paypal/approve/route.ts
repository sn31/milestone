import { eq } from "drizzle-orm";
import { milestones } from "@milestone/core";
import { approveSimulatedOrder } from "@milestone/money";
import { getDb } from "@/lib/db";
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
  if (!orderId) return Response.json({ error: "order is required" }, { status: 400 });

  const order = approveSimulatedOrder(orderId);
  if (!order) return Response.json({ error: `simulated order ${orderId} not found` }, { status: 404 });
  const milestoneId = order.referenceId;
  if (!milestoneId) return Response.json({ error: "order has no reference_id" }, { status: 409 });

  const [m] = await getDb().select({ id: milestones.id, contractId: milestones.contractId }).from(milestones).where(eq(milestones.id, milestoneId)).limit(1);
  if (!m) return Response.json({ error: `milestone ${milestoneId} not found` }, { status: 404 });

  const base = (process.env.APP_URL || url.origin).replace(/\/+$/, "");
  const back = new URL(`${base}/contracts/${encodeURIComponent(m.contractId)}`);
  back.searchParams.set("approved", order.id);
  back.searchParams.set("milestone", m.id);
  return new Response(null, { status: 303, headers: { Location: back.toString(), "Cache-Control": "no-store" } });
}
