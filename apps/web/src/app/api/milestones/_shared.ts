import { NextResponse } from "next/server";
import { eq, getOperators, type Operators } from "drizzle-orm";
import { PayPalError, captureFunding, getOrder, type MoneyContext } from "@milestone/money";
import { accounts, audit, milestones, postTransaction, recordOpResult, requestIdFor, toPayPalValue, transition, type Db, type MilestoneStatus } from "@milestone/core";
import { paypal } from "@/lib/paypal";
import type { Actor } from "@/lib/session";

/** Drizzle's query operators (eq, and, sql, ...), kept on loadMilestone's result for existing callers. */
export type Ops = Operators;
const ops: Ops = getOperators();

/** Loads a milestone with its contract. */
export async function loadMilestone(db: Db, id: string) {
  const milestone = await db.query.milestones.findFirst({ where: (t) => eq(t.id, id) });
  if (!milestone) return null;
  const contract = await db.query.contracts.findFirst({ where: (t) => eq(t.id, milestone.contractId) });
  if (!contract) return null;
  return { milestone, contract, ops };
}

/** Only the contract's own client funds a milestone. */
export function isContractClient(actor: Actor, contract: { clientId: string }): boolean {
  return actor.role === "client" && actor.userId === contract.clientId;
}

export function moneyContext(db: Db): MoneyContext {
  return { client: paypal(), requestIdFor: (kind, key) => requestIdFor(db, kind, key) };
}

export function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function paypalErrorResponse(e: unknown) {
  if (e instanceof PayPalError) return jsonError(e.message, 502, { debugId: e.debugId ?? null });
  return jsonError(e instanceof Error ? e.message : "PayPal call failed", 502);
}

// ---------- Funding: shared by the capture route and the PayPal webhook ----------

/** The parts of a PayPal capture we act on (order capture response or PAYMENT.CAPTURE.* resource). */
export interface CaptureInfo {
  id: string;
  status: string;
  amount: { value: string; currency_code: string };
}

export type FundResult =
  | { kind: "funded"; status: "funded"; captureId: string }
  /** Nothing to do: the milestone is already past draft (repeated onApprove, double click, redelivered webhook). */
  | { kind: "already"; status: MilestoneStatus; captureId: string | null }
  /** PayPal holds the capture as PENDING; PAYMENT.CAPTURE.COMPLETED finishes the job. */
  | { kind: "pending"; status: "draft"; captureId: string; captureStatus: string }
  | { kind: "mismatch"; captureId: string }
  | { kind: "rejected"; httpStatus: 404 | 409; error: string }
  | { kind: "paypal_error"; error: unknown };

export function isCaptureInfo(v: unknown): v is CaptureInfo {
  const c = v as Partial<CaptureInfo> | null;
  return !!c && typeof c.id === "string" && typeof c.status === "string" && !!c.amount && typeof c.amount.value === "string" && typeof c.amount.currency_code === "string";
}

/**
 * Funds a draft milestone from a capture: amount check, then under SELECT ... FOR UPDATE on the milestone row
 * the capture id, the client -> held ledger entry (skipped when one with this capture id exists) and draft -> funded.
 * A PENDING capture only records its id. Idempotent; safe to call from the route and the webhook concurrently.
 */
export async function fundFromCapture(db: Db, milestoneId: string, capture: CaptureInfo, actor: string, orderId: string | null = null): Promise<FundResult> {
  const found = await loadMilestone(db, milestoneId);
  if (!found) return { kind: "rejected", httpStatus: 404, error: "milestone not found" };
  const { milestone: m, contract: c } = found;
  if (m.status !== "draft") return { kind: "already", status: m.status, captureId: m.paypalCaptureId };

  const expected = toPayPalValue(m.amountMinor, c.currency);
  if (capture.amount.currency_code !== c.currency || capture.amount.value !== expected) {
    await audit(db, {
      actor: "paypal",
      event: "milestone.capture_mismatch",
      milestoneId: m.id,
      contractId: c.id,
      detail: { captureId: capture.id, expected: { value: expected, currency: c.currency }, got: capture.amount },
    });
    return { kind: "mismatch", captureId: capture.id };
  }

  if (capture.status !== "COMPLETED") {
    const recorded = await db.transaction(async (tx) => {
      const [row] = await tx.select({ status: milestones.status, captureId: milestones.paypalCaptureId }).from(milestones).where(eq(milestones.id, m.id)).for("update");
      if (!row || row.status !== "draft") return row ?? null;
      if (row.captureId !== capture.id) {
        await tx.update(milestones).set({ paypalCaptureId: capture.id }).where(eq(milestones.id, m.id));
        await audit(tx as unknown as Db, { actor: "paypal", event: "milestone.capture_pending", milestoneId: m.id, contractId: c.id, detail: { captureId: capture.id, captureStatus: capture.status } });
      }
      return null;
    });
    if (recorded) return { kind: "already", status: recorded.status, captureId: recorded.captureId };
    return { kind: "pending", status: "draft", captureId: capture.id, captureStatus: capture.status };
  }

  return db.transaction(async (tx): Promise<FundResult> => {
    // The core helpers take Db; a transaction exposes the same query builder.
    const t = tx as unknown as Db;
    const [row] = await tx.select({ status: milestones.status, captureId: milestones.paypalCaptureId }).from(milestones).where(eq(milestones.id, m.id)).for("update");
    if (!row) throw new Error(`milestone ${m.id} disappeared`);
    if (row.status !== "draft") return { kind: "already", status: row.status, captureId: row.captureId };

    await tx.update(milestones).set({ paypalCaptureId: capture.id }).where(eq(milestones.id, m.id));
    const posted = await tx.query.ledgerEntries.findFirst({ where: (l) => eq(l.ref, capture.id) });
    if (!posted) {
      await postTransaction(t, {
        ref: capture.id,
        currency: c.currency,
        entries: [
          { account: accounts.client(c.clientId), amountMinor: m.amountMinor, direction: "debit" },
          { account: accounts.held(m.id), amountMinor: m.amountMinor, direction: "credit" },
        ],
      });
    }
    await transition(t, m.id, "funded", {
      actor,
      event: "milestone.funded",
      detail: { orderId: orderId ?? m.paypalOrderId, captureId: capture.id, amountMinor: m.amountMinor, currency: c.currency },
    });
    return { kind: "funded", status: "funded", captureId: capture.id };
  });
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

  const rid = await requestIdFor(db, "capture", m.id);
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

/** Resolves the milestone a PAYMENT.CAPTURE.* resource belongs to: reference_id, then the order id, then the capture id. */
export async function milestoneForCapture(db: Db, resource: Record<string, unknown>): Promise<string | null> {
  const units = resource.purchase_units as Array<{ reference_id?: unknown }> | undefined;
  const ref = units?.[0]?.reference_id;
  if (typeof ref === "string" && ref) return ref;
  const related = (resource.supplementary_data as { related_ids?: { order_id?: unknown } } | undefined)?.related_ids;
  const orderId = typeof related?.order_id === "string" ? related.order_id : null;
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
