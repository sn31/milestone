/**
 * The only module in the codebase allowed to move money.
 * Every call takes a `requestId` that the caller has already persisted in `paypal_ops`,
 * so a retried job replays the same PayPal-Request-Id and can never pay twice.
 */
import { acceptClaim, captureOrder, createPayout, refundCapture } from "../paypal/money.ts";
import { PayPalError, type PayPalClient } from "../paypal/client.ts";
import { ACCEPT_CLAIM_STATUSES, type AcceptClaimPlan, type DisputeActionResult } from "../paypal/disputes.ts";
import { accounts, audit, postTransaction, recordOpResult, type Db, type PolicyDecision } from "@milestone/core";

export interface MoneyContext {
  client: PayPalClient;
  /** Creates (or returns the existing) paypal_ops row and hands back its request id. */
  requestIdFor: (kind: string, key: string) => Promise<string>;
}

export async function captureFunding(ctx: MoneyContext, milestoneId: string, orderId: string) {
  const requestId = await ctx.requestIdFor("capture", milestoneId);
  return captureOrder(ctx.client, orderId, requestId);
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

/** Executes a release or partial decision. Hold / ask_client never reach this function. */
export async function executeRelease(ctx: MoneyContext, plan: ReleasePlan) {
  if (plan.decision.action !== "release" && plan.decision.action !== "partial") {
    throw new Error(`executeRelease called with action ${plan.decision.action}`);
  }
  const releaseMinor = plan.decision.amountMinor;
  const refundMinor = plan.milestoneAmountMinor - releaseMinor;
  const results: Record<string, unknown> = {};

  const partnerShare = Math.min(plan.partner?.amountMinor ?? 0, releaseMinor);
  const freelancerShare = releaseMinor - partnerShare;
  const items = [];
  if (plan.partner && partnerShare > 0) {
    items.push({ receiverEmail: plan.partner.email, amountMinor: partnerShare, currency: plan.currency, note: "Milestone Advance repayment", senderItemId: `${plan.milestoneId}:partner` });
  }
  if (freelancerShare > 0) {
    items.push({ receiverEmail: plan.freelancerEmail, amountMinor: freelancerShare, currency: plan.currency, note: "Milestone released on verified delivery", senderItemId: `${plan.milestoneId}:freelancer` });
  }
  if (items.length > 0) {
    const rid = await ctx.requestIdFor("payout", plan.milestoneId);
    results.payout = await createPayout(ctx.client, { requestId: rid, senderBatchId: rid, items });
  }
  if (refundMinor > 0) {
    const rid = await ctx.requestIdFor("refund", plan.milestoneId);
    results.refund = await refundCapture(ctx.client, plan.captureId, { amountMinor: refundMinor, currency: plan.currency, requestId: rid, note: "Partial release: unverified share returned" });
  }
  return results;
}

/** Advance: the capital partner's account pays the freelancer. `partnerClient` is the partner's own app credentials. */
export async function fundAdvance(ctx: MoneyContext, partnerClient: PayPalClient, advanceId: string, freelancerEmail: string, principalMinor: number, currency: string) {
  const rid = await ctx.requestIdFor("advance-payout", advanceId);
  return createPayout(partnerClient, {
    requestId: rid,
    senderBatchId: rid,
    items: [{ receiverEmail: freelancerEmail, amountMinor: principalMinor, currency, note: "Milestone Advance", senderItemId: advanceId }],
  });
}

/** Ledger ref of an accepted dispute claim; one transaction per dispute (ledger_ref_account_direction is unique). */
export const disputeLedgerRef = (disputeId: string) => `dispute:${disputeId}`;

/** The audit event that hands a milestone to an operator (the release job's NEEDS_OPERATOR_EVENT). */
const NEEDS_OPERATOR_EVENT = "milestone.needs_operator";

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
  const requestId = await ctx.requestIdFor("dispute_accept", plan.disputeId);
  let res: unknown;
  try {
    res = await acceptClaim(ctx.client, plan.disputeId, { note: plan.note, requestId });
  } catch (e) {
    // The op row stays pending so a retry reuses the same PayPal-Request-Id.
    const message = e instanceof Error ? e.message : String(e);
    await audit(db, { actor: plan.actor, event: "dispute.accept_failed", ...scope, detail: { disputeId: plan.disputeId, requestId, error: message.slice(0, 500) } });
    return { ok: false, requestId, error: message, status: e instanceof PayPalError ? 502 : 500 };
  }
  await recordOpResult(db, requestId, { status: "succeeded", paypalId: plan.disputeId, response: res });

  const ref = disputeLedgerRef(plan.disputeId);
  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
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
      await audit(t, { actor: plan.actor, event: "dispute.claim_accepted", ...scope, detail: { disputeId: plan.disputeId, requestId, note: plan.note, amountMinor: plan.amountMinor, currency: plan.currency, ledgerRef: ref } });
      await audit(t, {
        actor: "policy",
        event: NEEDS_OPERATOR_EVENT,
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
