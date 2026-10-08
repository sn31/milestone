/**
 * The only module in the codebase allowed to move money.
 * Every call takes a `requestId` that the caller has already persisted in `paypal_ops`,
 * so a retried job replays the same PayPal-Request-Id and can never pay twice.
 */
import { captureOrder, createPayout, refundCapture } from "../paypal/money.ts";
import type { PayPalClient } from "../paypal/client.ts";
import type { PolicyDecision } from "@milestone/core";

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
