import { and, eq } from "drizzle-orm";
import { PayPalError, captureFunding, getOrder, moneyContextFor, type MoneyContext } from "@milestone/money";
import { defaultBranchHead } from "@milestone/verify";
import { OP_KINDS, VAULT_CHARGE_OP_KIND, asRecord, asString, fundMilestoneFromCapture, isCaptureInfo, loadMilestone, milestones, paypalOps, recordOpResult, requestIdFor, type CaptureInfo, type Db, type FundResult } from "@milestone/core";
import { jsonError } from "@/lib/http";
import { paypal } from "@/lib/paypal";

/** Loads a milestone with its contract (one relational query); null when either is missing. */
export { loadMilestone };

/** Only the contract's own client funds a milestone. Lives in lib/session; re-exported for existing importers. */
export { isContractClient } from "@/lib/session";

/** The process's PayPal client with request ids from paypal_ops through `db`. */
export function moneyContext(db: Db): MoneyContext {
  return moneyContextFor(db, paypal());
}

export function paypalErrorResponse(e: unknown) {
  if (e instanceof PayPalError) return jsonError(e.message, 502, { debugId: e.debugId ?? null });
  return jsonError(e instanceof Error ? e.message : "PayPal call failed", 502);
}

// ---------- Funding: shared by the capture route and the PayPal webhook ----------

/** The capture shape, the funding outcome and its guard live in @milestone/core; re-exported for existing importers. */
export { isCaptureInfo };
export type { CaptureInfo, FundResult };

/**
 * Funds a draft milestone from a capture through core's fundMilestoneFromCapture (the same booking the agent's
 * saved-PayPal charge uses): amount check, then under SELECT ... FOR UPDATE on the milestone row the capture id, the
 * client -> held ledger entry (skipped when one with this capture id exists) and draft -> funded. A PENDING capture
 * only records its id. Idempotent; safe to call from the route and the webhook concurrently.
 */
export function fundFromCapture(db: Db, milestoneId: string, capture: CaptureInfo, actor: string, orderId: string | null = null): Promise<FundResult> {
  return fundMilestoneFromCapture(db, milestoneId, capture, actor, { orderId, baselineSha: (c) => defaultBranchHead(c.repoFullName) });
}

/**
 * Captures the milestone's approved order and funds it. Used by the JS SDK's onApprove route and by the
 * CHECKOUT.ORDER.APPROVED webhook. The PayPal-Request-Id is fixed per milestone ("capture" op), the op row records
 * the outcome, and a milestone past draft is reported without calling PayPal.
 */
export async function captureAndFund(db: Db, milestoneId: string, orderId: string, actor = "paypal"): Promise<FundResult> {
  const found = await loadMilestone(db, milestoneId);
  if (!found) return { kind: "rejected", httpStatus: 404, error: "milestone not found" };
  const { milestone: m, contract: c } = found;
  if (m.status !== "draft") return { kind: "already", status: m.status, captureId: m.paypalCaptureId };
  if (c.status !== "active") return { kind: "rejected", httpStatus: 409, error: `contract is ${c.status}` };
  if (!m.paypalOrderId || m.paypalOrderId !== orderId) return { kind: "rejected", httpStatus: 409, error: "orderId does not match this milestone's order" };

  // The client's agent may be charging the saved PayPal for this milestone (fundFromVault holds the milestone row
  // FOR UPDATE while it checks for a capture op and claims its vault_charge op). Under the same row lock: refuse while
  // a vault charge exists that did not fail, else claim the capture op, which makes the agent's charge refuse
  // (capture_in_progress). Either way at most one of the two charges the client.
  const rid = await db.transaction(async (tx) => {
    await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.id, m.id)).for("update");
    const [vault] = await tx.select({ status: paypalOps.status }).from(paypalOps).where(and(eq(paypalOps.kind, VAULT_CHARGE_OP_KIND), eq(paypalOps.key, m.id)));
    if (vault && vault.status !== "failed") return null;
    return requestIdFor(tx, OP_KINDS.capture, m.id);
  });
  if (!rid) return { kind: "rejected", httpStatus: 409, error: "the client's agent is already funding this milestone from the saved PayPal" };
  let capture: CaptureInfo;
  try {
    ({ capture } = await captureFunding(moneyContext(db), m.id, orderId));
  } catch (e) {
    // Recover a capture that already happened (e.g. the first response was lost after PayPal's idempotency window).
    const order = await getOrder(paypal(), orderId).catch(() => null);
    const existing = order?.status === "COMPLETED" ? order.purchase_units?.[0]?.payments?.captures?.[0] : undefined;
    if (!existing) {
      await recordOpResult(db, rid, { status: "failed", response: { error: e instanceof Error ? e.message : String(e) } });
      return { kind: "paypal_error", error: e };
    }
    capture = existing;
  }
  await recordOpResult(db, rid, { status: "succeeded", paypalId: capture.id, response: capture });
  return fundFromCapture(db, m.id, capture, actor, orderId);
}

/** The order id a PAYMENT.CAPTURE.* resource names in supplementary_data.related_ids, if any. */
export function captureOrderId(resource: Record<string, unknown>): string | null {
  return asString(asRecord(asRecord(resource.supplementary_data).related_ids).order_id);
}

/** Resolves the milestone a PAYMENT.CAPTURE.* resource belongs to: reference_id, then the order id, then the capture id. */
export async function milestoneForCapture(db: Db, resource: Record<string, unknown>): Promise<string | null> {
  const units = resource.purchase_units;
  const ref = asString(Array.isArray(units) ? asRecord(units[0]).reference_id : undefined);
  if (ref) return ref;
  const orderId = captureOrderId(resource);
  if (orderId) {
    const m = await db.query.milestones.findFirst({ columns: { id: true }, where: (t) => eq(t.paypalOrderId, orderId) });
    if (m) return m.id;
  }
  if (typeof resource.id === "string") {
    const captureId = resource.id;
    const m = await db.query.milestones.findFirst({ columns: { id: true }, where: (t) => eq(t.paypalCaptureId, captureId) });
    if (m) return m.id;
  }
  return null;
}
