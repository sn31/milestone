import type { Job } from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import {
  PAYPAL_EVENTS,
  TRANSITIONS,
  accounts,
  advances,
  audit,
  fromPayPalValue,
  ledgerEntries,
  milestones,
  paypalOps,
  postTransaction,
  recordOpResult,
  releaseEntries,
  requestIdFor,
  transition,
  webhookEvents,
  type Db,
} from "@milestone/core";
import { advanceRefs, issuePaidReceipt, paypalMode } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { paypal } from "../lib/paypal.ts";
import {
  advanceRepayment,
  allocateRepayment,
  flagNeedsOperator,
  isFlaggedForOperator,
  itemOutcomes,
  itemReversals,
  parseClaim,
  parseDecision,
  payoutShares,
  type ClaimAdvance,
  type ItemOutcome,
  type ItemReversal,
  type OpRow,
  type PayoutParty,
  type ReleaseClaim,
} from "./release.ts";

export { canHold, type PayoutParty } from "./release.ts";

// ---------- Pure helpers (unit-tested in apps/worker/test) ----------

export interface PayoutItemEvent {
  senderItemId?: string;
  /** Set only for release items, whose sender_item_id is "<milestoneId>:<party>" (see executeRelease). */
  milestoneId?: string;
  party?: PayoutParty;
  payoutBatchId?: string;
  payoutItemId?: string;
  transactionStatus?: string;
  reason?: string;
  /** payout_item.amount as PayPal sent it (decimal string) and its currency. */
  amountValue?: string;
  currency?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reads a PAYMENT.PAYOUTS-ITEM.* event body. Advance-funding payouts (sender_item_id = advance id) come back without a party. */
export function parsePayoutItemEvent(payload: unknown): PayoutItemEvent {
  const resource = obj(obj(payload).resource);
  const item = obj(resource.payout_item);
  const senderItemId = str(item.sender_item_id) ?? str(resource.sender_item_id);
  const errors = obj(resource.errors);
  const out: PayoutItemEvent = {};
  if (senderItemId) {
    out.senderItemId = senderItemId;
    const [milestoneId, party, ...rest] = senderItemId.split(":");
    if (milestoneId && rest.length === 0 && (party === "partner" || party === "freelancer")) {
      out.milestoneId = milestoneId;
      out.party = party;
    }
  }
  const batch = str(resource.payout_batch_id);
  if (batch) out.payoutBatchId = batch;
  const itemId = str(resource.payout_item_id);
  if (itemId) out.payoutItemId = itemId;
  const status = str(resource.transaction_status);
  if (status) out.transactionStatus = status;
  const reason = str(errors.message) ?? str(errors.name) ?? status;
  if (reason) out.reason = reason;
  const amount = obj(item.amount);
  const value = str(amount.value);
  if (value) out.amountValue = value;
  const currency = str(amount.currency) ?? str(amount.currency_code);
  if (currency) out.currency = currency;
  return out;
}

export interface RefundEvent {
  refundId?: string;
  /** From the refund's "up" link (/v2/payments/captures/{id}). */
  captureId?: string;
  status?: string;
  amountValue?: string;
  currency?: string;
}

/** Reads a PAYMENT.CAPTURE.REFUNDED event body (resource = the refund). */
export function parseRefundEvent(payload: unknown): RefundEvent {
  const resource = obj(obj(payload).resource);
  const out: RefundEvent = {};
  const id = str(resource.id);
  if (id) out.refundId = id;
  const status = str(resource.status);
  if (status) out.status = status;
  const amount = obj(resource.amount);
  const value = str(amount.value);
  if (value) out.amountValue = value;
  const currency = str(amount.currency_code) ?? str(amount.currency);
  if (currency) out.currency = currency;
  const links = Array.isArray(resource.links) ? resource.links : [];
  for (const l of links) {
    const link = obj(l);
    const m = link.rel === "up" ? /\/captures\/([^/?#]+)/.exec(str(link.href) ?? "") : null;
    if (m?.[1]) out.captureId = m[1];
  }
  return out;
}

export function settleTarget(action: string): "released" | "partial_released" {
  return action === "partial" ? "partial_released" : "released";
}

/** PayPal caps invoice_number at 25 characters; deterministic per milestone so a retry reuses it. */
export function receiptInvoiceNumber(milestoneId: string): string {
  return `MS-${milestoneId.replace(/-/g, "").slice(0, 22)}`;
}

/**
 * What a PAYMENT.PAYOUTS-ITEM.* event means for the item. UNCLAIMED is still in flight (the receiver has 30 days to
 * claim it) and HELD is under PayPal review: both are audit only. FAILED / BLOCKED / DENIED / CANCELED never paid.
 * RETURNED / REVERSED / REFUNDED take back money that may already have been booked as paid.
 */
export type PayoutEventKind = "succeeded" | "failed" | "unclaimed" | "held" | "reversed";

export function payoutEventKind(eventType: string): PayoutEventKind | null {
  switch (eventType) {
    case PAYPAL_EVENTS.payoutItemSucceeded:
      return "succeeded";
    case PAYPAL_EVENTS.payoutItemFailed:
    case PAYPAL_EVENTS.payoutItemBlocked:
    case PAYPAL_EVENTS.payoutItemDenied:
    case PAYPAL_EVENTS.payoutItemCanceled:
      return "failed";
    case PAYPAL_EVENTS.payoutItemUnclaimed:
      return "unclaimed";
    case PAYPAL_EVENTS.payoutItemHeld:
      return "held";
    case PAYPAL_EVENTS.payoutItemReturned:
    case PAYPAL_EVENTS.payoutItemReversed:
    case PAYPAL_EVENTS.payoutItemRefunded:
      return "reversed";
    default:
      return null;
  }
}

export interface PayoutBatchEvent {
  payoutBatchId?: string;
  /** Our payout op's PayPal-Request-Id (executeRelease sends it as sender_batch_id). */
  senderBatchId?: string;
  batchStatus?: string;
}

/** Reads a PAYMENT.PAYOUTSBATCH.* event body (resource = the batch). */
export function parsePayoutBatchEvent(payload: unknown): PayoutBatchEvent {
  const header = obj(obj(obj(payload).resource).batch_header);
  const out: PayoutBatchEvent = {};
  const batch = str(header.payout_batch_id);
  if (batch) out.payoutBatchId = batch;
  const sender = str(obj(header.sender_batch_header).sender_batch_id);
  if (sender) out.senderBatchId = sender;
  const status = str(header.batch_status);
  if (status) out.batchStatus = status;
  return out;
}

/**
 * Whether a release may reach its final state (released / partial_released). Every half the claim has must have
 * succeeded: the payout op when something was released, the refund op when something was refunded. "blocked" when a
 * half failed (an operator was flagged), "wait" while a half is still in flight.
 */
export function finalisation(
  claim: Pick<ReleaseClaim, "releaseMinor" | "refundMinor">,
  payoutStatus: string | undefined,
  refundStatus: string | undefined,
): "final" | "wait" | "blocked" {
  const needed = [...(claim.releaseMinor > 0 ? [payoutStatus] : []), ...(claim.refundMinor > 0 ? [refundStatus] : [])];
  if (needed.length === 0) return "wait";
  if (needed.some((s) => s === "failed")) return "blocked";
  return needed.every((s) => s === "succeeded") ? "final" : "wait";
}

/**
 * Records one item's outcome on the payout op's response JSON. The first terminal outcome for an item sticks: a repeat
 * of the same event changes nothing, a contradicting later event is reported as a conflict and not applied.
 */
export function mergeItemOutcome(response: unknown, party: PayoutParty, outcome: ItemOutcome): { response: Record<string, unknown>; changed: boolean; conflict: boolean } {
  const base = obj(response);
  const existing = itemOutcomes(base)[party];
  if (existing) return { response: base, changed: false, conflict: existing.status !== outcome.status };
  const items = { ...obj(base.items), [party]: { ...outcome } };
  return { response: { ...base, items }, changed: true, conflict: false };
}

/** Records one item's reversal; the first one sticks (a redelivery or a second reversal event changes nothing). */
export function mergeItemReversal(response: unknown, party: PayoutParty, reversal: ItemReversal): { response: Record<string, unknown>; changed: boolean } {
  const base = obj(response);
  if (itemReversals(base)[party]) return { response: base, changed: false };
  return { response: { ...base, reversals: { ...obj(base.reversals), [party]: { ...reversal } } }, changed: true };
}

/**
 * Op status from its items, for reporting. It stays "sent" until every party with a share has a final outcome (R5);
 * then it is "succeeded" when all of them succeeded and none was reversed, "failed" otherwise.
 */
export function deriveOpStatus(
  shares: { partnerShareMinor: number; freelancerShareMinor: number },
  items: Partial<Record<PayoutParty, ItemOutcome>>,
  reversals: Partial<Record<PayoutParty, unknown>> = {},
): "sent" | "succeeded" | "failed" {
  const expected: PayoutParty[] = [];
  if (shares.partnerShareMinor > 0) expected.push("partner");
  if (shares.freelancerShareMinor > 0) expected.push("freelancer");
  if (expected.length === 0 || !expected.every((p) => items[p] !== undefined)) return "sent";
  return expected.every((p) => items[p]?.status === "succeeded" && !reversals[p]) ? "succeeded" : "failed";
}

/** Total paid out according to the recorded items (falls back to the claimed share when PayPal sent no amount). */
export function paidTotal(shares: { partnerShareMinor: number; freelancerShareMinor: number }, items: Partial<Record<PayoutParty, ItemOutcome>>): number {
  let total = 0;
  if (items.partner?.status === "succeeded") total += items.partner.amountMinor ?? shares.partnerShareMinor;
  if (items.freelancer?.status === "succeeded") total += items.freelancer.amountMinor ?? shares.freelancerShareMinor;
  return total;
}

/**
 * How a payout item event finds its op. With a batch id, only the op carrying that PayPal id matches (R8, never a
 * fallback to another op); "wait" when our op was claimed but its PayPal answer is not recorded yet.
 */
export function matchPayoutOp(op: { status: string; paypalId: string | null } | undefined, payoutBatchId: string | undefined): "match" | "wait" | "unmatched" {
  if (!op || op.status === "pending") return "unmatched";
  if (!payoutBatchId || op.paypalId === payoutBatchId) return "match";
  return op.paypalId === null && op.status === "sent" ? "wait" : "unmatched";
}

/** R10: a refund event is ours only when it carries our refund id, or our op has no id yet and the amount is exactly the claimed refund. */
export function isOurRefund(op: { status: string; paypalId: string | null } | undefined, claimRefundMinor: number | null, refund: { refundId?: string; amountMinor: number | null }): boolean {
  if (!op || op.status === "pending") return false;
  if (op.paypalId) return refund.refundId !== undefined && op.paypalId === refund.refundId;
  return refund.amountMinor !== null && claimRefundMinor !== null && refund.amountMinor === claimRefundMinor;
}

/** Mirror of a posted transaction: same accounts and amounts, directions swapped. */
export function reverseEntries(rows: ReadonlyArray<{ account: string; amountMinor: number; direction: "debit" | "credit" }>) {
  return rows.map((r) => ({ account: r.account, amountMinor: r.amountMinor, direction: r.direction === "debit" ? ("credit" as const) : ("debit" as const) }));
}

/** Ledger refs: one release posting per party, one refund posting and one reversal per party per milestone, checked under the milestone lock. */
export const ledgerRef = {
  release: (milestoneId: string, party: PayoutParty) => (party === "freelancer" ? `release:${milestoneId}` : `release:${milestoneId}:partner`),
  refund: (milestoneId: string) => `refund:${milestoneId}`,
  reversal: (milestoneId: string, party: PayoutParty) => `reversal:${milestoneId}:${party}`,
};

// ---------- DB helpers ----------

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = NonNullable<Awaited<ReturnType<Db["query"]["contracts"]["findFirst"]>>>;

async function markProcessed(q: Db | Tx, webhookRowId: string): Promise<void> {
  await q.update(webhookEvents).set({ processedAt: new Date() }).where(eq(webhookEvents.id, webhookRowId));
}

async function hasLedgerRef(tx: Tx, ref: string): Promise<boolean> {
  const [row] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.ref, ref)).limit(1);
  return row !== undefined;
}

/** The milestone's op of this kind, locked for the rest of the transaction. */
async function lockOp(tx: Tx, kind: "payout" | "refund", milestoneId: string): Promise<OpRow | undefined> {
  const [row] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, milestoneId))).for("update");
  return row;
}

/** Resolves the milestone a refund event belongs to: our refund op's PayPal id, then the capture id, then the job's hint. */
async function milestoneForRefund(db: Db, refund: RefundEvent, hint: string | undefined): Promise<string | undefined> {
  if (refund.refundId) {
    const op = await db.query.paypalOps.findFirst({ where: and(eq(paypalOps.kind, "refund"), eq(paypalOps.paypalId, refund.refundId)) });
    if (op) return op.key;
  }
  if (refund.captureId) {
    const m = await db.query.milestones.findFirst({ where: eq(milestones.paypalCaptureId, refund.captureId) });
    if (m) return m.id;
  }
  if (hint) {
    const m = await db.query.milestones.findFirst({ where: eq(milestones.id, hint) });
    if (m) return m.id;
  }
  return undefined;
}

/** Resolves the milestone a payout batch event belongs to: our payout op by PayPal's batch id, then by sender_batch_id (= its request id), then the job's hint. */
async function milestoneForBatch(db: Db, batch: PayoutBatchEvent, hint: string | undefined): Promise<string | undefined> {
  if (batch.payoutBatchId) {
    const op = await db.query.paypalOps.findFirst({ where: and(eq(paypalOps.kind, "payout"), eq(paypalOps.paypalId, batch.payoutBatchId)) });
    if (op) return op.key;
  }
  if (batch.senderBatchId) {
    const op = await db.query.paypalOps.findFirst({ where: and(eq(paypalOps.kind, "payout"), eq(paypalOps.requestId, batch.senderBatchId)) });
    if (op) return op.key;
  }
  if (hint) {
    const m = await db.query.milestones.findFirst({ where: eq(milestones.id, hint) });
    if (m) return m.id;
  }
  return undefined;
}

/** A payout op written before claims existed: rebuild the shares from the stored decision. */
function legacyClaim(m: MilestoneRow, contract: ContractRow, owedMinor: number): ReleaseClaim | null {
  const d = parseDecision(m.decision);
  if (!d || (d.action !== "release" && d.action !== "partial")) return null;
  return {
    deliveryId: "",
    action: d.action,
    ruleIds: d.ruleIds,
    reason: d.reason,
    releaseMinor: d.amountMinor,
    refundMinor: Math.max(0, m.amountMinor - d.amountMinor),
    currency: contract.currency,
    captureId: m.paypalCaptureId ?? "",
    freelancerEmail: "",
    partnerEmail: null,
    shares: payoutShares(d.amountMinor, owedMinor),
  };
}

// ---------- Job ----------

interface After {
  receipt?: { m: MilestoneRow; contract: ContractRow; amountMinor: number };
}

/**
 * Enqueued by the PayPal webhook route with { eventId, eventType } after the event was verified and stored once.
 * Handles PAYMENT.PAYOUTS-ITEM.*, PAYMENT.PAYOUTSBATCH.DENIED and PAYMENT.CAPTURE.REFUNDED. Each event is applied in one transaction that locks the
 * milestone row and the webhook row, so concurrent runs cannot double-post the ledger. Nothing here ever enqueues a
 * release: one payout attempt per milestone, and anything that goes wrong is flagged for an operator.
 */
export async function settle(job: Job<JobData>): Promise<void> {
  const db = getDb();
  const eventId = str(job.data.eventId);
  if (!eventId) throw new Error(`settle job ${job.id} has no eventId`);
  const row = await db.query.webhookEvents.findFirst({ where: (w, { and, eq }) => and(eq(w.source, "paypal"), eq(w.eventId, eventId)) });
  if (!row) throw new Error(`webhook event ${eventId} not stored yet`);
  if (row.processedAt) return;

  const eventType = row.type;
  const kind = payoutEventKind(eventType);
  let milestoneId: string | undefined;
  let apply: ((tx: Tx, m: MilestoneRow, contract: ContractRow) => Promise<After>) | undefined;

  if (kind) {
    const item = parsePayoutItemEvent(row.payload);
    if (item.party && item.milestoneId) {
      milestoneId = item.milestoneId;
      const party = item.party;
      apply = (tx, m, contract) => settleItem(tx, m, contract, eventId, eventType, kind, { ...item, party });
    }
  } else if (eventType === PAYPAL_EVENTS.captureRefunded) {
    const refund = parseRefundEvent(row.payload);
    milestoneId = await milestoneForRefund(db, refund, str(job.data.milestoneId));
    apply = (tx, m, contract) => settleRefund(tx, m, contract, eventId, refund);
  } else if (eventType === PAYPAL_EVENTS.payoutsBatchDenied) {
    const batch = parsePayoutBatchEvent(row.payload);
    milestoneId = await milestoneForBatch(db, batch, str(job.data.milestoneId));
    apply = (tx, m, contract) => settleBatchDenied(tx, m, contract, eventId, eventType, batch);
    if (!milestoneId) await audit(db, { actor: "paypal", event: "paypal.payout_batch_unmatched", detail: { eventId, payoutBatchId: batch.payoutBatchId ?? null, senderBatchId: batch.senderBatchId ?? null } });
  }
  if (!milestoneId || !apply) {
    // Not a release item or refund of ours (e.g. an advance-funding payout): nothing for this job to settle.
    await markProcessed(db, row.id);
    return;
  }
  const id = milestoneId;
  const run = apply;

  const after = await db.transaction(async (tx) => {
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, id)).for("update");
    if (!m) throw new Error(`milestone ${id} not found`);
    const [w] = await tx.select({ processedAt: webhookEvents.processedAt }).from(webhookEvents).where(eq(webhookEvents.id, row.id)).for("update");
    if (w?.processedAt) return {};
    const contract = await tx.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
    if (!contract) throw new Error(`contract ${m.contractId} not found`);
    const out = await run(tx, m, contract);
    await markProcessed(tx, row.id);
    return out;
  });

  if (after.receipt) await issueReceipt(db, after.receipt.m, after.receipt.contract, after.receipt.amountMinor);
}

async function settleItem(
  tx: Tx,
  m: MilestoneRow,
  contract: ContractRow,
  eventId: string,
  eventType: string,
  kind: PayoutEventKind,
  item: PayoutItemEvent & { party: PayoutParty },
): Promise<After> {
  const t = tx as unknown as Db;
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const detail = { eventId, eventType, party: item.party, payoutBatchId: item.payoutBatchId ?? null, payoutItemId: item.payoutItemId ?? null };
  const op = await lockOp(tx, "payout", milestoneId);
  const match = matchPayoutOp(op, item.payoutBatchId);
  if (match === "wait") {
    // Our payout was claimed but PayPal's answer (the batch id) is not recorded yet: retry this job, the release job's
    // retry (same PayPal-Request-Id) records it.
    throw new Error(`payout op for milestone ${milestoneId} has no batch id recorded yet; event ${eventId} will be retried`);
  }
  if (match === "unmatched" || !op) {
    await audit(t, { ...base, event: op ? "paypal.unmatched_batch" : "paypal.payout_unmatched", detail: { ...detail, opBatchId: op?.paypalId ?? null } });
    return {};
  }

  // "repaid" / "shortfall" too: the partner's item may settle before the freelancer's, and the ledger still needs the advance.
  const advance = await tx.query.advances.findFirst({ where: (a, { and, eq, inArray }) => and(eq(a.milestoneId, milestoneId), inArray(a.status, ["funded", "repaid", "shortfall"])) });
  const owed = advance ? advanceRepayment(advance, m.decidedAt) : undefined;
  const claim = parseClaim(op.request) ?? legacyClaim(m, contract, owed ? owed.principalMinor + owed.feeMinor : 0);
  if (!claim) throw new Error(`payout op ${op.key} has no claim and milestone ${milestoneId} no usable decision`);
  const amountMinor = item.amountValue ? fromPayPalValue(item.amountValue, item.currency ?? contract.currency) : null;

  if (kind === "unclaimed" || kind === "held") {
    // Still in flight: the receiver can claim it (UNCLAIMED) or PayPal is reviewing it (HELD); a final item event follows.
    await audit(t, { ...base, event: `paypal.payout_${kind}`, detail: { ...detail, amountMinor } });
    return {};
  }
  if (kind === "reversed") return reverseItem(tx, m, contract, op, claim, { ...detail, amountMinor, advanceId: advance?.id ?? null }, item);

  const outcome: ItemOutcome = {
    status: kind,
    amountMinor,
    eventId,
    ...(item.payoutItemId ? { payoutItemId: item.payoutItemId } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
  };
  const merged = mergeItemOutcome(op.response, item.party, outcome);
  if (merged.conflict) {
    await audit(t, { ...base, event: "paypal.payout_item_conflict", detail: { ...detail, recorded: itemOutcomes(op.response)[item.party] ?? null } });
  }
  if (!merged.changed) return {};
  const items = itemOutcomes(merged.response);
  const opStatus = deriveOpStatus(claim.shares, items, itemReversals(merged.response));
  await tx.update(paypalOps).set({ response: merged.response, status: opStatus, updatedAt: new Date() }).where(eq(paypalOps.id, op.id));

  if (kind === "failed") {
    await audit(t, { ...base, event: "paypal.payout_failed", detail: { ...detail, reason: item.reason ?? null, opStatus } });
    if (item.party === "partner") await audit(t, { ...base, event: "advance.repayment_failed", detail: { ...detail, advanceId: advance?.id ?? null, reason: item.reason ?? null } });
    // R7: any failed item holds the milestone for an operator; it never ends released.
    await flagNeedsOperator(t, m, { actor: "paypal", reason: `Payout ${eventType} for the ${item.party}: ${item.reason ?? "no reason given"}`, detail: { eventId } });
    return {};
  }

  // Money moved: book exactly what PayPal paid for this item, once.
  const booked = amountMinor ?? (item.party === "partner" ? claim.shares.partnerShareMinor : claim.shares.freelancerShareMinor);
  const ref = ledgerRef.release(milestoneId, item.party);
  if (item.party === "partner") {
    // The claim names the advances this payment repays (the milestone's own, then balances carried from earlier ones).
    const dues: ClaimAdvance[] | undefined =
      claim.advances ?? (advance && owed ? [{ advanceId: advance.id, milestoneId: advance.milestoneId, principalMinor: owed.principalMinor, feeMinor: owed.feeMinor }] : undefined);
    if (booked > 0) await bookPartnerRepayment(tx, m, contract, dues ?? [], booked, { ...detail, payoutItemId: item.payoutItemId ?? null });
  } else if (booked > 0 && !(await hasLedgerRef(tx, ref))) {
    await postTransaction(t, { ref, currency: contract.currency, entries: releaseEntries({ milestoneId, freelancerId: contract.freelancerId, amountMinor: booked }) });
  }
  if (opStatus === "failed") {
    // The other item already failed: the milestone is held; refresh the operator's picture with this payment.
    await flagNeedsOperator(t, m, { actor: "paypal", reason: `The ${item.party} was paid after another item of the same payout failed`, detail: { eventId } });
    return {};
  }
  if (opStatus !== "succeeded") return {}; // wait for the other item

  // A partial (or any release with a refunded share) is final only once the refund half succeeded too.
  const refundOp = claim.refundMinor > 0 ? await lockOp(tx, "refund", milestoneId) : undefined;
  return finalise(tx, m, contract, claim, { payout: opStatus, refund: refundOp?.status, items }, detail);
}

/**
 * Books a succeeded partner item: splits what PayPal paid across the claimed advances in order (allocateRepayment, the
 * same split the release job claimed), posts one balanced transaction per advance (held -> partner receivable for the
 * principal, -> partner fees for the fee) under its own ref, each once, and sets each advance "repaid" when it got all
 * it owed, else "shortfall" with the remaining balance in the audit detail (the next release collects it).
 */
async function bookPartnerRepayment(tx: Tx, m: MilestoneRow, contract: ContractRow, dues: readonly ClaimAdvance[], booked: number, detail: Record<string, unknown>): Promise<void> {
  const t = tx as unknown as Db;
  const base = { actor: "paypal", milestoneId: m.id, contractId: m.contractId } as const;
  if (dues.length === 0) {
    await audit(t, { ...base, event: "ledger.skipped", detail: { ...detail, reason: "partner item paid but the claim names no advance", amountMinor: booked } });
    return;
  }
  const rows = await tx.select().from(advances).where(inArray(advances.id, dues.map((d) => d.advanceId)));
  const allocation = allocateRepayment(booked, dues);
  let allocated = 0;
  for (const [i, d] of dues.entries()) {
    const a = rows.find((r) => r.id === d.advanceId);
    const x = allocation[i]!;
    const paidMinor = x.principalMinor + x.feeMinor;
    allocated += paidMinor;
    if (!a) {
      await audit(t, { ...base, event: "ledger.skipped", detail: { ...detail, reason: "claimed advance not found", advanceId: d.advanceId, amountMinor: paidMinor } });
      continue;
    }
    const ref = advanceRefs.repayment(m.id, a);
    if (paidMinor > 0 && !(await hasLedgerRef(tx, ref))) {
      await postTransaction(t, {
        ref,
        currency: contract.currency,
        entries: releaseEntries({ milestoneId: m.id, freelancerId: contract.freelancerId, amountMinor: paidMinor, advance: { partnerId: a.partnerId, principalMinor: x.principalMinor, feeMinor: x.feeMinor } }),
      });
    }
    const owedMinor = d.principalMinor + d.feeMinor;
    const remainingMinor = Math.max(0, owedMinor - paidMinor);
    const info = { advanceId: a.id, advanceMilestoneId: a.milestoneId, carried: a.milestoneId !== m.id, partnerId: a.partnerId, owedMinor, paidMinor, principalPaidMinor: x.principalMinor, feePaidMinor: x.feeMinor, remainingMinor, ...detail };
    if (remainingMinor === 0) {
      const done = await tx.update(advances).set({ status: "repaid", repaidAt: new Date() }).where(and(eq(advances.id, a.id), inArray(advances.status, ["funded", "shortfall"]))).returning({ id: advances.id });
      if (done.length > 0) await audit(t, { ...base, event: "advance.repaid", detail: info });
    } else {
      const done = await tx.update(advances).set({ status: "shortfall" }).where(and(eq(advances.id, a.id), inArray(advances.status, ["funded", "shortfall"]))).returning({ id: advances.id });
      if (done.length > 0) await audit(t, { ...base, event: "advance.shortfall", detail: info });
    }
  }
  if (booked > allocated) {
    // More than every claimed balance: left in the milestone's held account for an operator, never credited to anyone.
    await audit(t, { ...base, event: "ledger.partner_excess", detail: { ...detail, amountMinor: booked, allocatedMinor: allocated, excessMinor: booked - allocated } });
  }
}

/**
 * The one place a release reaches released / partial_released, called by the settle step that completed a half
 * (payout items or refund). Waits for the other half; never moves a milestone that was flagged for an operator.
 */
async function finalise(
  tx: Tx,
  m: MilestoneRow,
  contract: ContractRow,
  claim: ReleaseClaim,
  halves: { payout: string | undefined; refund: string | undefined; items: Partial<Record<PayoutParty, ItemOutcome>> },
  detail: Record<string, unknown>,
): Promise<After> {
  const t = tx as unknown as Db;
  const base = { actor: "paypal", milestoneId: m.id, contractId: m.contractId } as const;
  const target = settleTarget(claim.action);
  const state = finalisation(claim, halves.payout, halves.refund);
  if (state === "blocked") return {}; // the failed half flagged an operator; the milestone stays held
  if (state === "wait") {
    await audit(t, { ...base, event: "settle.waiting", detail: { ...detail, to: target, payoutOpStatus: halves.payout ?? null, refundOpStatus: halves.refund ?? null } });
    return {};
  }
  const total = paidTotal(claim.shares, halves.items);
  if (m.status === target) return {};
  const flagged = await isFlaggedForOperator(tx, m.id);
  if (flagged || !TRANSITIONS[m.status].includes(target)) {
    await audit(t, { ...base, event: "milestone.settle_conflict", detail: { ...detail, from: m.status, to: target, amountMinor: total, needsOperator: flagged } });
    return {};
  }
  const moved = await transition(t, m.id, target, { actor: "paypal", event: `milestone.${target}`, detail: { ...detail, amountMinor: total, refundMinor: claim.refundMinor } });
  return moved && total > 0 ? { receipt: { m, contract, amountMinor: total } } : {};
}

/**
 * PAYMENT.PAYOUTSBATCH.DENIED: PayPal refused the whole batch, so no item was paid. The payout op (matched by the batch
 * id as for items, or by sender_batch_id, which is the op's own PayPal-Request-Id) is marked failed and an operator is
 * flagged. A repeat for an op the release job already recorded as denied only adds the audit entry.
 */
async function settleBatchDenied(tx: Tx, m: MilestoneRow, _contract: ContractRow, eventId: string, eventType: string, batch: PayoutBatchEvent): Promise<After> {
  const t = tx as unknown as Db;
  const base = { actor: "paypal", milestoneId: m.id, contractId: m.contractId } as const;
  const detail = { eventId, eventType, payoutBatchId: batch.payoutBatchId ?? null, senderBatchId: batch.senderBatchId ?? null, batchStatus: batch.batchStatus ?? null };
  const op = await lockOp(tx, "payout", m.id);
  const ours = op !== undefined && op.status !== "pending" && batch.senderBatchId !== undefined && op.requestId === batch.senderBatchId;
  const match = ours ? "match" : matchPayoutOp(op, batch.payoutBatchId);
  if (match === "wait") throw new Error(`payout op for milestone ${m.id} has no batch id recorded yet; event ${eventId} will be retried`);
  if (match === "unmatched" || !op) {
    await audit(t, { ...base, event: op ? "paypal.unmatched_batch" : "paypal.payout_unmatched", detail: { ...detail, opBatchId: op?.paypalId ?? null } });
    return {};
  }
  const wasFailed = op.status === "failed";
  await tx
    .update(paypalOps)
    .set({
      status: "failed",
      paypalId: op.paypalId ?? batch.payoutBatchId ?? null,
      response: { ...obj(op.response), batchDenied: { eventId, batchStatus: batch.batchStatus ?? "DENIED" } },
      updatedAt: new Date(),
    })
    .where(eq(paypalOps.id, op.id));
  await audit(t, { ...base, event: "paypal.payout_batch_denied", detail: { ...detail, opStatus: op.status } });
  if (wasFailed && (await isFlaggedForOperator(tx, m.id))) return {};
  await flagNeedsOperator(t, m, { actor: "paypal", reason: "PayPal denied the payout batch", detail: { eventId, payoutBatchId: batch.payoutBatchId ?? op.paypalId ?? null } });
  return {};
}

/**
 * R9: a RETURNED / REVERSED / REFUNDED item. The release posting for that party (if any) is mirrored under
 * reversal:<milestoneId>:<party> (debit the party, credit held), the milestone goes to held (writing the status directly
 * from released / partial_released, which the transition table treats as final) and an operator is flagged.
 */
async function reverseItem(
  tx: Tx,
  m: MilestoneRow,
  contract: ContractRow,
  op: OpRow,
  claim: ReleaseClaim,
  detail: Record<string, unknown> & { eventId: string; eventType: string; amountMinor: number | null },
  item: PayoutItemEvent & { party: PayoutParty },
): Promise<After> {
  const t = tx as unknown as Db;
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const rv = mergeItemReversal(op.response, item.party, {
    eventId: detail.eventId,
    eventType: detail.eventType,
    amountMinor: detail.amountMinor,
    ...(item.payoutItemId ? { payoutItemId: item.payoutItemId } : {}),
  });
  if (!rv.changed) return {};
  let response = rv.response;
  // Returned before it ever succeeded (UNCLAIMED -> RETURNED): record the item as failed so the op reaches a final status.
  if (!itemOutcomes(response)[item.party]) {
    response = mergeItemOutcome(response, item.party, { status: "failed", amountMinor: detail.amountMinor, eventId: detail.eventId, reason: detail.eventType }).response;
  }
  const opStatus = deriveOpStatus(claim.shares, itemOutcomes(response), itemReversals(response));
  await tx.update(paypalOps).set({ response, status: opStatus, updatedAt: new Date() }).where(eq(paypalOps.id, op.id));

  const releaseRef = ledgerRef.release(milestoneId, item.party);
  const reversalRef = ledgerRef.reversal(milestoneId, item.party);
  let reversedMinor = 0;
  if (!(await hasLedgerRef(tx, reversalRef))) {
    const posted = await tx
      .select({ account: ledgerEntries.account, amountMinor: ledgerEntries.amountMinor, direction: ledgerEntries.direction })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.ref, releaseRef));
    if (posted.length > 0) {
      await postTransaction(t, { ref: reversalRef, currency: contract.currency, entries: reverseEntries(posted) });
      reversedMinor = posted.filter((r) => r.direction === "debit").reduce((s, r) => s + r.amountMinor, 0);
    }
  }
  if (item.party === "partner") {
    // Repayments of balances carried from earlier milestones were booked under their own refs: mirror them too. The
    // advances keep their status: the money went back to the platform, not to the freelancer, so an operator re-sends it.
    for (const d of claim.advances ?? []) {
      if (d.milestoneId === milestoneId) continue;
      const a = { id: d.advanceId, milestoneId: d.milestoneId };
      const rRef = advanceRefs.repayment(milestoneId, a);
      const vRef = advanceRefs.reversal(milestoneId, a);
      if (await hasLedgerRef(tx, vRef)) continue;
      const posted = await tx
        .select({ account: ledgerEntries.account, amountMinor: ledgerEntries.amountMinor, direction: ledgerEntries.direction })
        .from(ledgerEntries)
        .where(eq(ledgerEntries.ref, rRef));
      if (posted.length === 0) continue;
      await postTransaction(t, { ref: vRef, currency: contract.currency, entries: reverseEntries(posted) });
      reversedMinor += posted.filter((r) => r.direction === "debit").reduce((s, r) => s + r.amountMinor, 0);
    }
  }
  await audit(t, { ...base, event: "paypal.payout_reversed", detail: { ...detail, reversedMinor, opStatus } });

  let status = m.status;
  if (m.status === "released" || m.status === "partial_released") {
    await tx.update(milestones).set({ status: "held" }).where(eq(milestones.id, milestoneId));
    await audit(t, { ...base, event: "milestone.reversed", detail: { ...detail, from: m.status, to: "held", reversedMinor } });
    status = "held";
  }
  await flagNeedsOperator(t, { ...m, status }, { actor: "paypal", reason: `Payout ${detail.eventType} for the ${item.party}`, detail: { eventId: detail.eventId, reversedMinor } });
  return {};
}

/** Refund statuses that mean the money did not go back to the client. */
const REFUND_FAILED = new Set(["FAILED", "CANCELLED"]);

async function settleRefund(tx: Tx, m: MilestoneRow, contract: ContractRow, eventId: string, refund: RefundEvent): Promise<After> {
  const t = tx as unknown as Db;
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const op = await lockOp(tx, "refund", milestoneId);
  const claim = op ? parseClaim(op.request) : null;
  const eventMinor = refund.amountValue ? fromPayPalValue(refund.amountValue, refund.currency ?? contract.currency) : null;
  if (!op || !isOurRefund(op, claim?.refundMinor ?? null, { ...(refund.refundId ? { refundId: refund.refundId } : {}), amountMinor: eventMinor })) {
    // Not the refund this platform sent for the release (e.g. a dispute, a manual refund, another amount): logged, not booked.
    await audit(t, { ...base, event: "paypal.refund_unmatched", detail: { eventId, refundId: refund.refundId ?? null, captureId: refund.captureId ?? null, amountMinor: eventMinor, opRefundId: op?.paypalId ?? null } });
    return {};
  }
  const amountMinor = eventMinor ?? claim?.refundMinor ?? 0;

  if (refund.status && REFUND_FAILED.has(refund.status)) {
    // The refund half failed: nothing is booked, the milestone stays out of its final state (held) for an operator.
    await tx
      .update(paypalOps)
      .set({
        status: op.status === "succeeded" ? op.status : "failed",
        paypalId: op.paypalId ?? refund.refundId ?? null,
        response: { ...obj(op.response), webhook: { eventId, status: refund.status, amountMinor } },
        updatedAt: new Date(),
      })
      .where(eq(paypalOps.id, op.id));
    await audit(t, { ...base, event: "paypal.refund_failed", detail: { eventId, refundId: refund.refundId ?? op.paypalId ?? null, status: refund.status, amountMinor } });
    await flagNeedsOperator(t, m, { actor: "paypal", reason: `PayPal refund ${refund.status}`, detail: { eventId, refundId: refund.refundId ?? op.paypalId ?? null } });
    return {};
  }

  await tx
    .update(paypalOps)
    .set({
      status: "succeeded",
      paypalId: op.paypalId ?? refund.refundId ?? null,
      response: { ...obj(op.response), webhook: { eventId, status: refund.status ?? null, amountMinor } },
      updatedAt: new Date(),
    })
    .where(eq(paypalOps.id, op.id));

  const ref = ledgerRef.refund(milestoneId);
  if (amountMinor > 0 && !(await hasLedgerRef(tx, ref))) {
    await postTransaction(t, {
      ref,
      currency: contract.currency,
      entries: [
        { account: accounts.held(milestoneId), amountMinor, direction: "debit" },
        { account: accounts.client(contract.clientId), amountMinor, direction: "credit" },
      ],
    });
  }
  await audit(t, { ...base, event: "paypal.refund_settled", detail: { eventId, refundId: refund.refundId ?? op.paypalId ?? null, amountMinor, currency: contract.currency } });

  // The refund half is done: final now when nothing was released (a refund-only partial) or the payout already succeeded.
  if (!claim) return {};
  const payoutOp = claim.releaseMinor > 0 ? await lockOp(tx, "payout", milestoneId) : undefined;
  return finalise(tx, m, contract, claim, { payout: payoutOp?.status, refund: "succeeded", items: itemOutcomes(payoutOp?.response) }, { eventId, refundMinor: amountMinor });
}

async function issueReceipt(db: Db, m: MilestoneRow, contract: ContractRow, amountMinor: number): Promise<void> {
  const base = { milestoneId: m.id, contractId: contract.id } as const;
  // The simulator issues receipts too; outside simulated mode a receipt needs the platform's real credentials.
  if (paypalMode() !== "simulated" && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) {
    await audit(db, { ...base, actor: "system", event: "receipt.skipped", detail: { reason: "PayPal credentials are not configured" } });
    return;
  }
  const existing = await db.query.paypalOps.findFirst({ where: (o, { and, eq }) => and(eq(o.kind, "invoice"), eq(o.key, m.id)) });
  if (existing?.status === "succeeded") return;

  const [client, freelancer] = await Promise.all([
    db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.clientId) }),
    db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) }),
  ]);
  if (!client || !freelancer) {
    await audit(db, { ...base, actor: "system", event: "receipt.skipped", detail: { reason: "client or freelancer user not found" } });
    return;
  }

  const payoutOp = await db.query.paypalOps.findFirst({ where: (o, { and, eq }) => and(eq(o.kind, "payout"), eq(o.key, m.id)) });
  const requestId = await requestIdFor(db, "invoice", m.id);
  try {
    const { invoiceId, invoiceUrl } = await issuePaidReceipt(paypal(), {
      requestId,
      invoiceNumber: receiptInvoiceNumber(m.id),
      freelancerName: freelancer.name ?? freelancer.email,
      ...(process.env.PAYPAL_PLATFORM_EMAIL ? { platformEmail: process.env.PAYPAL_PLATFORM_EMAIL } : {}),
      ...(payoutOp?.paypalId ? { payoutBatchId: payoutOp.paypalId } : {}),
      milestoneLabel: `Milestone ${m.seq} · ${m.title}`,
      clientEmail: client.email,
      currency: contract.currency,
      amountMinor,
      description: `${contract.title}: ${m.title}`,
    });
    await recordOpResult(db, requestId, { status: "succeeded", paypalId: invoiceId, response: { invoiceId, invoiceUrl: invoiceUrl ?? null } });
    await audit(db, { ...base, actor: "paypal", event: "paypal.receipt", detail: { invoiceId, invoiceUrl: invoiceUrl ?? null } });
  } catch (err) {
    // The money has moved and the state is final; a missing receipt is logged, not retried forever.
    const error = err instanceof Error ? err.message : String(err);
    await recordOpResult(db, requestId, { status: "failed", response: { error } });
    await audit(db, { ...base, actor: "paypal", event: "paypal.receipt_failed", detail: { error } });
  }
}
