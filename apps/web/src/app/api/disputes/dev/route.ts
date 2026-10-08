import { openSimulatedDispute } from "@milestone/money";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { formBody, notSimulated } from "../../dev/paypal/_guard";

export const dynamic = "force-dynamic";

/**
 * Demo: the buyer opens a dispute against a milestone's capture in simulated PayPal, which sends
 * CUSTOMER.DISPUTE.CREATED to the webhook ~1.5 s later (the copilot takes it from there). Simulated mode only.
 * Body (JSON or form): { "milestoneId": "mst_3", "reason"?: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED" }.
 */
export async function POST(req: Request) {
  const blocked = notSimulated();
  if (blocked) return blocked;
  const body = await formBody(req);
  const milestoneId = typeof body?.milestoneId === "string" ? body.milestoneId.trim() : "";
  if (!milestoneId) return jsonError("milestoneId is required", 400);
  const db = getDb();
  const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!m) return jsonError("milestone not found", 404);
  if (!m.paypalCaptureId) return jsonError("the milestone has no captured payment to dispute", 409);
  const c = await db.query.contracts.findFirst({ columns: { currency: true }, where: (t, { eq }) => eq(t.id, m.contractId) });
  const reason = typeof body?.reason === "string" && /^[A-Z_]{3,64}$/.test(body.reason) ? body.reason : undefined;
  const opened = openSimulatedDispute({ captureId: m.paypalCaptureId, amountMinor: m.amountMinor, currency: c?.currency ?? "USD", ...(reason ? { reason } : {}) });
  return json({ ...opened, milestoneId });
}
