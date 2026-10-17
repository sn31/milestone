/**
 * The only module in the codebase allowed to move money.
 * Every call takes a `requestId` that the caller has already persisted in `paypal_ops`,
 * so a retried job replays the same PayPal-Request-Id and can never pay twice.
 */
import { acceptClaim, captureOrder, chargeVault, createPayout, refundCapture, type Capture, type PayoutBatch, type PayoutItemInput } from "../paypal/money.ts";
import { PayPalError, type PayPalClient } from "../paypal/client.ts";
import { ACCEPT_CLAIM_STATUSES, type AcceptClaimPlan, type DisputeActionResult } from "../paypal/disputes.ts";
import {
  AUDIT_EVENTS,
  OP_KINDS,
  accounts,
  activePaymentMethod,
  agentActor,
  audit,
  autoFundMandates,
  claimVaultCharge,
  fundMilestoneFromCapture,
  fundingAllows,
  isCaptureInfo,
  ledgerRefs,
  loadFundingState,
  loadMilestone,
  nextDraftMilestone,
  postTransaction,
  recordOpResult,
  requestIdFor,
  type AgentMandate,
  type CaptureInfo,
  type Db,
  type Executor,
  type FundResult,
  type FundingRefusal,
  type MilestoneStatus,
  type PaymentMethod,
  type PayoutParty,
  type PolicyDecision,
  type VaultChargeOp,
  type VaultChargeRequest,
} from "@milestone/core";

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

// ---------- Funding from the client's saved PayPal (agents) ----------

type MilestoneRow = NonNullable<Awaited<ReturnType<typeof loadMilestone>>>["milestone"];
type ContractRow = NonNullable<Awaited<ReturnType<typeof loadMilestone>>>["contract"];

/** How an agent reached the vault charge: the Milestone MCP fund_milestone tool, or the mandate's auto-fund rule. */
export type VaultFundVia = "mcp" | "auto_fund";

export interface VaultFundPlan {
  /** The mandate the agent acts under; the charge is audited as agentActor(mandate). */
  mandate: AgentMandate;
  /** The saved PayPal to charge (the mandate user's own); null refuses with payment_method_missing. */
  paymentMethod: PaymentMethod | null;
  /** The milestone and its contract as the caller saw them. Everything is re-read under lock before charging. */
  milestone: MilestoneRow;
  contract: ContractRow;
  via: VaultFundVia;
  /** The verifier's baseline (default branch head) for the funded milestone; a network call the caller supplies. */
  baselineSha?: (contract: { repoFullName: string | null }) => Promise<string | null>;
  now?: Date;
}

export type VaultFundResult =
  /**
   * funded: the milestone moved to funded. pending: PayPal holds the capture PENDING (PAYMENT.CAPTURE.COMPLETED funds
   * it). already: the milestone was already past draft when booking (a retry after success). replayed: no new charge
   * was attempted, an earlier one was replayed or booked.
   */
  | { ok: true; kind: "funded" | "pending" | "already"; milestoneId: string; status: MilestoneStatus; requestId: string; orderId: string | null; captureId: string | null; amountMinor: number; currency: string; replayed: boolean }
  | { ok: false; kind: "refused"; reason: FundingRefusal; milestoneId: string }
  /** retryable: the outcome is unknown (network, 5xx), so the op stays "sent" and a retry replays the same request id. */
  | { ok: false; kind: "paypal_error"; milestoneId: string; requestId: string; error: string; status: number; retryable: boolean }
  /** PayPal created the order but did not capture (e.g. PAYER_ACTION_REQUIRED): nothing moved. */
  | { ok: false; kind: "not_completed"; milestoneId: string; requestId: string; orderId: string; orderStatus: string }
  | { ok: false; kind: "mismatch"; milestoneId: string; requestId: string; captureId: string }
  | { ok: false; kind: "rejected"; milestoneId: string; requestId: string; error: string };

/** A PayPal answer that settles the charge as not made: a 4xx other than timeout, conflict or rate limit. */
function definiteRefusal(e: unknown): boolean {
  return e instanceof PayPalError && e.status >= 400 && e.status < 500 && ![408, 409, 429].includes(e.status);
}

/** The capture and order id a succeeded vault_charge op recorded. */
function recordedCharge(op: VaultChargeOp): { orderId: string | null; capture: CaptureInfo } | null {
  const r = op.response as { orderId?: unknown; capture?: unknown } | null;
  if (!r || !isCaptureInfo(r.capture)) return null;
  return { orderId: typeof r.orderId === "string" ? r.orderId : null, capture: r.capture };
}

/**
 * THE ONLY way an agent funds a milestone: a charge of the client's saved PayPal, reached from the MCP fund_milestone
 * tool and from the auto-fund rule. Steps:
 *  1. In one transaction, under FOR UPDATE on the mandate row (which serialises the mandate's charges, so the total cap
 *     holds under concurrency) and the milestone row: re-read the mandate, milestone, contract, siblings, payment
 *     method and the mandate's funded total, check the whole funding guarantee (fundingAllows), and claim the
 *     milestone's vault_charge op ("sent", with the mandate and amount in its request) so it commits with the check.
 *  2. Charge (chargeVault, PayPal-Request-Id = the op's request id).
 *  3. Record the op, audit the charge as the agent, and fund the milestone through fundMilestoneFromCapture (the same
 *     booking the capture route and the webhook use: client -> held ledger entry, draft -> funded).
 * A retry never charges twice: a succeeded op is booked without calling PayPal; a "sent" op (outcome unknown) is
 * replayed with the same request id after the guarantee is re-checked (its own amount not counted twice); only a
 * failed op (a definite PayPal refusal: nothing moved) is charged again, under a fresh request id.
 * Every refusal is audited (vault.fund_refused) as the agent on behalf of the user.
 */
export async function fundFromVault(ctx: { client: PayPalClient; db: Db }, plan: VaultFundPlan): Promise<VaultFundResult> {
  const { db } = ctx;
  const now = plan.now ?? new Date();
  const actor = agentActor(plan.mandate);
  const milestoneId = plan.milestone.id;
  const amountMinor = plan.milestone.amountMinor;
  const currency = plan.contract.currency;

  type Step =
    | { refused: FundingRefusal; contractId: string | null; exists: boolean }
    | { book: VaultChargeOp }
    | { charge: VaultChargeOp; vaultId: string; replay: boolean };
  const step = await db.transaction(async (tx): Promise<Step> => {
    const st = await loadFundingState(tx, { mandateId: plan.mandate.id, milestoneId, paymentMethodId: plan.paymentMethod?.id ?? null }, { lock: true });
    if (!st) return { refused: "milestone_not_in_contract", contractId: null, exists: false };
    if (st.contract.id !== plan.contract.id) return { refused: "milestone_not_in_contract", contractId: st.contract.id, exists: true };
    const op = st.chargeOp;
    if (op?.status === "succeeded") {
      // A charge already went through. Booking it again moves no money; it heals a crash between charge and booking.
      // Past draft it is only reported back to the mandate that made it; any other caller is refused like any non-draft.
      const req = op.request as Partial<VaultChargeRequest> | null;
      if (st.milestone.status !== "draft" && req?.mandateId !== st.mandate.id) return { refused: "milestone_not_draft", contractId: st.contract.id, exists: true };
      return { book: op };
    }
    let fundedMinor = st.fundedMinor;
    if (op?.status === "sent") {
      // An earlier charge's outcome is unknown. Only the same mandate may replay it, and only while the guarantee holds.
      const req = op.request as Partial<VaultChargeRequest> | null;
      if (req?.mandateId !== st.mandate.id || req.paymentMethodId !== st.paymentMethod?.id) return { refused: "capture_in_progress", contractId: st.contract.id, exists: true };
      fundedMinor -= typeof req.amountMinor === "number" ? req.amountMinor : 0;
    }
    const verdict = fundingAllows({ ...st, fundedMinor, amountMinor, currency }, now);
    if ("refused" in verdict) return { refused: verdict.refused, contractId: st.contract.id, exists: true };
    const vaultId = st.paymentMethod!.paypalPaymentTokenId;
    if (op?.status === "sent") return { charge: op, vaultId, replay: true };
    const request: VaultChargeRequest = { mandateId: st.mandate.id, userId: st.mandate.userId, paymentMethodId: st.paymentMethod!.id, milestoneId, contractId: st.contract.id, amountMinor, currency, actor };
    const claimed = await claimVaultCharge(tx, request, now);
    if (claimed.status === "succeeded") return { book: claimed };
    // Claimed fresh, or re-claimed from "pending" / "failed": a new charge. (The milestone row is locked, so no other
    // call can have claimed it in between.)
    return { charge: claimed, vaultId, replay: false };
  });

  if ("refused" in step) {
    await audit(db, {
      actor,
      event: AUDIT_EVENTS.vaultFundRefused,
      ...(step.exists ? { milestoneId } : {}),
      ...(step.contractId ? { contractId: step.contractId } : {}),
      detail: { reason: step.refused, mandateId: plan.mandate.id, paymentMethodId: plan.paymentMethod?.id ?? null, milestoneId, amountMinor, currency, via: plan.via },
    });
    return { ok: false, kind: "refused", reason: step.refused, milestoneId };
  }

  const scope = { milestoneId, contractId: plan.contract.id };
  const book = async (requestId: string, orderId: string | null, capture: CaptureInfo, replayed: boolean): Promise<VaultFundResult> => {
    const funded: FundResult = await fundMilestoneFromCapture(db, milestoneId, capture, actor, {
      orderId,
      ...(plan.baselineSha ? { baselineSha: plan.baselineSha } : {}),
      detail: { mandateId: plan.mandate.id, paymentMethodId: plan.paymentMethod?.id ?? null, requestId, via: plan.via, source: "vault" },
    });
    switch (funded.kind) {
      case "funded":
      case "pending":
      case "already":
        return { ok: true, kind: funded.kind, milestoneId, status: funded.status, requestId, orderId, captureId: funded.captureId, amountMinor, currency, replayed };
      case "mismatch":
        return { ok: false, kind: "mismatch", milestoneId, requestId, captureId: funded.captureId };
      case "rejected":
        return { ok: false, kind: "rejected", milestoneId, requestId, error: funded.error };
      case "paypal_error":
        return { ok: false, kind: "rejected", milestoneId, requestId, error: String(funded.error) };
    }
  };

  if ("book" in step) {
    const rec = recordedCharge(step.book);
    if (!rec) return { ok: false, kind: "rejected", milestoneId, requestId: step.book.requestId, error: "the recorded vault charge has no capture" };
    return book(step.book.requestId, rec.orderId, rec.capture, true);
  }

  const op = step.charge;
  let res: Awaited<ReturnType<typeof chargeVault>>;
  try {
    res = await chargeVault(ctx.client, { requestId: op.requestId, vaultId: step.vaultId, milestoneId, amountMinor, currency });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    const retryable = !definiteRefusal(e);
    // A definite refusal moved nothing: the op is failed and a retry gets a fresh request id. Otherwise it stays "sent".
    if (!retryable) await recordOpResult(db, op.requestId, { status: "failed", response: { error: error.slice(0, 2000), status: (e as PayPalError).status, body: (e as PayPalError).body ?? null } });
    await audit(db, { actor, event: AUDIT_EVENTS.paypalVaultChargeError, ...scope, detail: { requestId: op.requestId, mandateId: plan.mandate.id, amountMinor, currency, via: plan.via, retryable, error: error.slice(0, 500) } });
    return { ok: false, kind: "paypal_error", milestoneId, requestId: op.requestId, error, status: e instanceof PayPalError ? e.status : 0, retryable };
  }
  if (!res.capture) {
    await recordOpResult(db, op.requestId, { status: "failed", paypalId: res.order.id, response: { orderId: res.order.id, orderStatus: res.order.status } });
    await audit(db, { actor, event: AUDIT_EVENTS.paypalVaultChargeError, ...scope, detail: { requestId: op.requestId, mandateId: plan.mandate.id, orderId: res.order.id, orderStatus: res.order.status, via: plan.via, retryable: true, error: "order not captured" } });
    return { ok: false, kind: "not_completed", milestoneId, requestId: op.requestId, orderId: res.order.id, orderStatus: res.order.status };
  }
  const capture: Capture = res.capture;
  await recordOpResult(db, op.requestId, { status: "succeeded", paypalId: capture.id, response: { orderId: res.order.id, orderStatus: res.order.status, capture } });
  await audit(db, {
    actor,
    event: AUDIT_EVENTS.paypalVaultCharge,
    ...scope,
    detail: { requestId: op.requestId, mandateId: plan.mandate.id, userId: plan.mandate.userId, paymentMethodId: plan.paymentMethod?.id ?? null, orderId: res.order.id, captureId: capture.id, captureStatus: capture.status, amountMinor, currency, via: plan.via, replayed: step.replay },
  });
  return book(op.requestId, res.order.id, capture, step.replay);
}

export type AutoFundResult = VaultFundResult | { ok: false; kind: "skipped"; why: "no_draft_milestone" | "no_auto_fund_mandate" | "no_payment_method" | "contract_missing" };

/**
 * The auto-fund rule: fund the contract's next draft milestone from the client's saved PayPal, under the client's
 * newest live mandate with auto_fund_next. It only picks the plan; fundFromVault checks the whole guarantee.
 */
export async function autoFundNextMilestone(ctx: { client: PayPalClient; db: Db }, contractId: string, opts: { baselineSha?: VaultFundPlan["baselineSha"]; now?: Date } = {}): Promise<AutoFundResult> {
  const now = opts.now ?? new Date();
  const next = await nextDraftMilestone(ctx.db, contractId);
  if (!next) return { ok: false, kind: "skipped", why: "no_draft_milestone" };
  const found = await loadMilestone(ctx.db, next.id);
  if (!found) return { ok: false, kind: "skipped", why: "contract_missing" };
  const [mandate] = await autoFundMandates(ctx.db, found.contract.clientId, now);
  if (!mandate) return { ok: false, kind: "skipped", why: "no_auto_fund_mandate" };
  const paymentMethod = await activePaymentMethod(ctx.db, mandate.userId);
  if (!paymentMethod) return { ok: false, kind: "skipped", why: "no_payment_method" };
  return fundFromVault(ctx, { mandate, paymentMethod, milestone: found.milestone, contract: found.contract, via: "auto_fund", now, ...(opts.baselineSha ? { baselineSha: opts.baselineSha } : {}) });
}
