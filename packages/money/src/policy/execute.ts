/**
 * The only module in the codebase allowed to move money.
 * Every call takes a `requestId` that the caller has already persisted in `paypal_ops`,
 * so a retried job replays the same PayPal-Request-Id and can never pay twice.
 */
import { acceptClaim, captureOrder, createPayout, refundCapture, type PayoutBatch, type PayoutItemInput } from "../paypal/money.ts";
import { PayPalError, type PayPalClient } from "../paypal/client.ts";
import { ACCEPT_CLAIM_STATUSES, type AcceptClaimPlan, type DisputeActionResult } from "../paypal/disputes.ts";
import { AUDIT_EVENTS, OP_KINDS, accounts, audit, ledgerRefs, postTransaction, recordOpResult, requestIdFor, type Db, type Executor, type PayoutParty, type PolicyDecision } from "@milestone/core";

export type { PayoutBatch };

export interface MoneyContext {
  client: PayPalClient;
  /** Creates (or returns the existing) paypal_ops row and hands back its request id. */
  requestIdFor: (kind: string, key: string) => Promise<string>;
}

/** The usual context: request ids from paypal_ops through `db` (the pool, or a transaction). */
export function moneyContextFor(db: Executor, client: PayPalClient): MoneyContext {
  return { client, requestIdFor: (kind, key) => requestIdFor(db, kind, key) };
}

export async function captureFunding(ctx: MoneyContext, milestoneId: string, orderId: string) {
  const requestId = await ctx.requestIdFor(OP_KINDS.capture, milestoneId);
  return captureOrder(ctx.client, orderId, requestId);
}

export interface PayoutRequest {
  milestoneId: string;
  currency: string;
  /** In payment order; each item's sender_item_id is "<milestoneId>:<party>". */
  items: Array<{ party: PayoutParty; email: string; amountMinor: number }>;
}

const PAYOUT_NOTES: Record<PayoutParty, string> = { partner: "Milestone Advance repayment", freelancer: "Milestone released on verified delivery" };

/** One payout batch for the milestone, under its "payout" op (the request id is also the sender_batch_id). */
export async function executePayout(ctx: MoneyContext, p: PayoutRequest): Promise<PayoutBatch> {
  const rid = await ctx.requestIdFor(OP_KINDS.payout, p.milestoneId);
  const items: PayoutItemInput[] = p.items.map((i) => ({ receiverEmail: i.email, amountMinor: i.amountMinor, currency: p.currency, note: PAYOUT_NOTES[i.party], senderItemId: `${p.milestoneId}:${i.party}` }));
  return createPayout(ctx.client, { requestId: rid, senderBatchId: rid, items });
}

export interface RefundRequest {
  milestoneId: string;
  captureId: string;
  amountMinor: number;
  currency: string;
  note?: string;
}

/** Refunds part of the milestone's capture to the client, under its "refund" op. */
export async function executeRefund(ctx: MoneyContext, r: RefundRequest): Promise<{ id: string; status: string }> {
  const rid = await ctx.requestIdFor(OP_KINDS.refund, r.milestoneId);
  return refundCapture(ctx.client, r.captureId, { amountMinor: r.amountMinor, currency: r.currency, requestId: rid, note: r.note ?? "Partial release: unverified share returned" });
}

export interface ReleasePlan {
  milestoneId: string;
  currency: string;
  captureId: string;
  freelancerEmail: string;
  decision: PolicyDecision;
  /** Optional advance repayment that is paid to the partner before the freelancer. */
  partner?: { email: string; amountMinor: number };
  /** Full milestone amount, needed to compute the refund on a partial release. */
  milestoneAmountMinor: number;
}

export interface ReleaseResult {
  payout?: PayoutBatch;
  refund?: { id: string; status: string };
}

/** Executes a release or partial decision. Hold / ask_client never reach this function. */
export async function executeRelease(ctx: MoneyContext, plan: ReleasePlan): Promise<ReleaseResult> {
  if (plan.decision.action !== "release" && plan.decision.action !== "partial") {
    throw new Error(`executeRelease called with action ${plan.decision.action}`);
  }
  const releaseMinor = plan.decision.amountMinor;
  const refundMinor = plan.milestoneAmountMinor - releaseMinor;
  const results: ReleaseResult = {};

  const partnerShare = Math.min(plan.partner?.amountMinor ?? 0, releaseMinor);
  const freelancerShare = releaseMinor - partnerShare;
  const items: PayoutRequest["items"] = [];
  if (plan.partner && partnerShare > 0) items.push({ party: "partner", email: plan.partner.email, amountMinor: partnerShare });
  if (freelancerShare > 0) items.push({ party: "freelancer", email: plan.freelancerEmail, amountMinor: freelancerShare });
  if (items.length > 0) results.payout = await executePayout(ctx, { milestoneId: plan.milestoneId, currency: plan.currency, items });
  if (refundMinor > 0) results.refund = await executeRefund(ctx, { milestoneId: plan.milestoneId, captureId: plan.captureId, amountMinor: refundMinor, currency: plan.currency });
  return results;
}

/** Advance: the capital partner's account pays the freelancer. `partnerClient` is the partner's own app credentials. */
export async function fundAdvance(ctx: MoneyContext, partnerClient: PayPalClient, advanceId: string, freelancerEmail: string, principalMinor: number, currency: string) {
  const rid = await ctx.requestIdFor(OP_KINDS.advancePayout, advanceId);
  return createPayout(partnerClient, {
    requestId: rid,
    senderBatchId: rid,
    items: [{ receiverEmail: freelancerEmail, amountMinor: principalMinor, currency, note: "Milestone Advance", senderItemId: advanceId }],
  });
}

/** Ledger ref of an accepted dispute claim (core's ledgerRefs.dispute); kept for existing importers. */
export const disputeLedgerRef = ledgerRefs.dispute;

function isUniqueViolation(e: unknown): boolean {
  for (let x: unknown = e, i = 0; x && typeof x === "object" && i < 4; x = (x as { cause?: unknown }).cause, i++) {
    if ((x as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/**
 * The freelancer accepts a buyer's PayPal dispute: POST accept-claim, and PayPal refunds the buyer from the platform
 * account. Only for a milestone whose money already left escrow (released / partial_released); anything else is refused
 * with reason "milestone_not_final" before PayPal is called. Once PayPal accepts, in one transaction:
 *  - the ledger books the refund against the milestone (debit held:<milestone>, credit client:<id>, ref dispute:<id>),
 *    which leaves held:<milestone> showing what the platform paid twice;
 *  - dispute.claim_accepted and milestone.needs_operator are audited, so an operator recovers it from the freelancer
 *    or books the loss.
 * The ref guards the posting: a second call (double click, retry) replays PayPal's answer and books nothing.
 */
export async function acceptDisputeClaim(ctx: MoneyContext & { db: Db }, plan: AcceptClaimPlan): Promise<DisputeActionResult> {
  const { db } = ctx;
  const m = await db.query.milestones.findFirst({ columns: { status: true }, where: (t, { eq }) => eq(t.id, plan.milestoneId) });
  if (!m || !ACCEPT_CLAIM_STATUSES.has(m.status)) {
    return { ok: false, requestId: "", status: 409, reason: "milestone_not_final", error: `the milestone is ${m?.status ?? "missing"}: its money is still in escrow, so the claim cannot be accepted here` };
  }
  if (!Number.isInteger(plan.amountMinor) || plan.amountMinor <= 0) return { ok: false, requestId: "", status: 400, error: `bad refund amount ${plan.amountMinor}` };
  const scope = { milestoneId: plan.milestoneId, contractId: plan.contractId };
  const requestId = await ctx.requestIdFor(OP_KINDS.disputeAccept, plan.disputeId);
  let res: unknown;
  try {
    res = await acceptClaim(ctx.client, plan.disputeId, { note: plan.note, requestId });
  } catch (e) {
    // The op row stays pending so a retry reuses the same PayPal-Request-Id.
    const message = e instanceof Error ? e.message : String(e);
    await audit(db, { actor: plan.actor, event: AUDIT_EVENTS.disputeAcceptFailed, ...scope, detail: { disputeId: plan.disputeId, requestId, error: message.slice(0, 500) } });
    return { ok: false, requestId, error: message, status: e instanceof PayPalError ? 502 : 500 };
  }
  await recordOpResult(db, requestId, { status: "succeeded", paypalId: plan.disputeId, response: res });

  const ref = ledgerRefs.dispute(plan.disputeId);
  try {
    await db.transaction(async (t) => {
      const posted = await t.query.ledgerEntries.findFirst({ columns: { id: true }, where: (l, { eq }) => eq(l.ref, ref) });
      if (posted) return;
      await postTransaction(t, {
        ref,
        currency: plan.currency,
        entries: [
          { account: accounts.held(plan.milestoneId), amountMinor: plan.amountMinor, direction: "debit" },
          { account: accounts.client(plan.clientId), amountMinor: plan.amountMinor, direction: "credit" },
        ],
      });
      await audit(t, { actor: plan.actor, event: AUDIT_EVENTS.disputeClaimAccepted, ...scope, detail: { disputeId: plan.disputeId, requestId, note: plan.note, amountMinor: plan.amountMinor, currency: plan.currency, ledgerRef: ref } });
      await audit(t, {
        actor: "policy",
        event: AUDIT_EVENTS.needsOperator,
        ...scope,
        detail: {
          reason: "dispute claim accepted: PayPal refunded the buyer after the milestone's money left escrow; recover it from the freelancer or book the loss",
          status: m.status,
          disputeId: plan.disputeId,
          refundMinor: plan.amountMinor,
          currency: plan.currency,
          ledgerRef: ref,
        },
      });
    });
  } catch (e) {
    // A racing accept booked it first (unique ref); its rows stand and this one rolled back.
    if (!isUniqueViolation(e)) throw e;
  }
  return { ok: true, requestId };
}
