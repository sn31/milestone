import { NextResponse } from "next/server";
import { accounts, audit, milestones, postTransaction, recordOpResult, requestIdFor, toPayPalValue, transition, type Db } from "@milestone/core";
import { captureFunding, getOrder } from "@milestone/money";
import { getDb } from "@/lib/db";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { isContractClient, jsonError, loadMilestone, moneyContext, paypalErrorResponse } from "../../_shared";

type Capture = Awaited<ReturnType<typeof captureFunding>>["capture"];

function ok(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/**
 * Captures the approved order (JS SDK onApprove) and moves the milestone to funded.
 * Idempotent: the PayPal-Request-Id is fixed per milestone, the milestone row is locked while the
 * ledger is posted, and the ledger transaction is skipped when one with this capture id already exists.
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
  const { milestone: m, contract: c, ops } = found;

  if (!isContractClient(actor, c)) return jsonError("only the contract's client can fund a milestone", 403);
  // Already past draft: a repeated onApprove or a double click. Report the current state, call nothing.
  if (m.status !== "draft") return ok({ status: m.status, captureId: m.paypalCaptureId });
  if (c.status !== "active") return jsonError(`contract is ${c.status}`, 409);
  if (!m.paypalOrderId || m.paypalOrderId !== orderId) return jsonError("orderId does not match this milestone's order", 409);

  let capture: Capture;
  try {
    ({ capture } = await captureFunding(moneyContext(db), m.id, orderId));
  } catch (e) {
    // Recover a capture that already happened (e.g. the first response was lost after PayPal's idempotency window).
    const order = await getOrder(paypal(), orderId).catch(() => null);
    const existing = order?.status === "COMPLETED" ? order.purchase_units?.[0]?.payments?.captures?.[0] : undefined;
    if (!existing) {
      const rid = await requestIdFor(db, "capture", m.id);
      await recordOpResult(db, rid, { status: "failed", response: { error: e instanceof Error ? e.message : String(e) } });
      return paypalErrorResponse(e);
    }
    capture = existing;
  }
  const rid = await requestIdFor(db, "capture", m.id);
  await recordOpResult(db, rid, { status: "succeeded", paypalId: capture.id, response: capture });

  const expected = toPayPalValue(m.amountMinor, c.currency);
  if (capture.amount.currency_code !== c.currency || capture.amount.value !== expected) {
    await audit(db, {
      actor: "paypal",
      event: "milestone.capture_mismatch",
      milestoneId: m.id,
      contractId: c.id,
      detail: { captureId: capture.id, expected: { value: expected, currency: c.currency }, got: capture.amount },
    });
    return jsonError("captured amount does not match the milestone", 409, { captureId: capture.id });
  }

  if (capture.status !== "COMPLETED") {
    // PENDING captures are not funds we can hold yet; the PAYMENT.CAPTURE.COMPLETED webhook finishes the job.
    await db.update(milestones).set({ paypalCaptureId: capture.id }).where(ops.eq(milestones.id, m.id));
    await audit(db, { actor: "paypal", event: "milestone.capture_pending", milestoneId: m.id, contractId: c.id, detail: { captureId: capture.id, captureStatus: capture.status } });
    return ok({ status: "draft", captureId: capture.id, captureStatus: capture.status }, 202);
  }

  const status = await db.transaction(async (tx) => {
    // The core helpers take Db; a transaction exposes the same query builder.
    const t = tx as unknown as Db;
    const [row] = await tx.select({ status: milestones.status }).from(milestones).where(ops.eq(milestones.id, m.id)).for("update");
    if (!row) throw new Error(`milestone ${m.id} disappeared`);
    if (row.status !== "draft") return row.status;

    await tx.update(milestones).set({ paypalCaptureId: capture.id }).where(ops.eq(milestones.id, m.id));
    const posted = await tx.query.ledgerEntries.findFirst({ where: (l, { eq }) => eq(l.ref, capture.id) });
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
      actor: actor.userId,
      event: "milestone.funded",
      detail: { orderId, captureId: capture.id, amountMinor: m.amountMinor, currency: c.currency },
    });
    return "funded" as const;
  });

  return ok({ status, captureId: capture.id });
}
