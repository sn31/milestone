import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { captureAndFund, isContractClient, jsonError, loadMilestone, paypalErrorResponse } from "../../_shared";

function ok(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Captures the approved order (JS SDK onApprove) and moves the milestone to funded.
 * The capture-and-fund logic is shared with the CHECKOUT.ORDER.APPROVED webhook (see captureAndFund): the
 * PayPal-Request-Id is fixed per milestone, the milestone row is locked while the ledger is posted, and the
 * ledger transaction is skipped when one with this capture id already exists.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { orderId?: unknown } | null;
  const orderId = typeof body?.orderId === "string" ? body.orderId : "";
  if (!orderId) return jsonError("orderId is required", 400);

  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  if (!isContractClient(actor, found.contract)) return jsonError("only the contract's client can fund a milestone", 403);

  const r = await captureAndFund(db, id, orderId, actor.userId);
  switch (r.kind) {
    case "funded":
    case "already":
      // Already past draft: a repeated onApprove or a double click. Report the current state.
      return ok({ status: r.status, captureId: r.captureId });
    case "pending":
      return ok({ status: r.status, captureId: r.captureId, captureStatus: r.captureStatus }, 202);
    case "mismatch":
      return jsonError("captured amount does not match the milestone", 409, { captureId: r.captureId });
    case "rejected":
      return jsonError(r.error, r.httpStatus);
    case "paypal_error":
      return paypalErrorResponse(r.error);
  }
}
