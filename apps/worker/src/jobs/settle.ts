import type { Job } from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import {
  AUDIT_EVENTS,
  OP_KINDS,
  PAYPAL_EVENTS,
  accounts,
  advances,
  asRecord,
  asString,
  audit,
  autoFundMandates,
  canTransition,
  enqueue,
  fromPayPalValue,
  ledgerEntries,
  ledgerRefs,
  markWebhookProcessed,
  milestones,
  nextDraftMilestone,
  paypalMode,
  paypalOps,
  postTransaction,
  recordOpResult,
  releaseEntries,
  requestIdFor,
  transition,
  webhookEvents,
  type Db,
  type Executor,
  type OpRow,
  type PayoutParty,
  type Tx,
} from "@milestone/core";
import { issuePaidReceipt, parsePayoutBatchEvent, parsePayoutItemEvent, parseRefundEvent, type PayoutBatchEvent, type PayoutItemEvent, type RefundEvent } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { paypal } from "../lib/paypal.ts";
import {
  allocateRepayment,
  flagNeedsOperator,
  isFlaggedForOperator,
  itemOutcomes,
  itemReversals,
  parseClaim,
  type ClaimAdvance,
  type ItemOutcome,
  type ItemReversal,
  type ReleaseClaim,
} from "./claim.ts";

// ---------- Pure helpers (unit-tested in apps/worker/test) ----------

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
  const base = asRecord(response);
  const existing = itemOutcomes(base)[party];
  if (existing) return { response: base, changed: false, conflict: existing.status !== outcome.status };
  const items = { ...asRecord(base.items), [party]: { ...outcome } };
  return { response: { ...base, items }, changed: true, conflict: false };
}

/** Records one item's reversal; the first one sticks (a redelivery or a second reversal event changes nothing). */
export function mergeItemReversal(response: unknown, party: PayoutParty, reversal: ItemReversal): { response: Record<string, unknown>; changed: boolean } {
  const base = asRecord(response);
  if (itemReversals(base)[party]) return { response: base, changed: false };
  return { response: { ...base, reversals: { ...asRecord(base.reversals), [party]: { ...reversal } } }, changed: true };
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

/** A settle event, read once from the stored webhook body. */
export type SettleEvent =
  | { kind: "item"; itemKind: PayoutEventKind; item: PayoutItemEvent & { milestoneId: string; party: PayoutParty } }
  | { kind: "refund"; refund: RefundEvent }
  | { kind: "batch_denied"; batch: PayoutBatchEvent }
  /** Not a release item, refund or denied batch of ours (e.g. an advance-funding payout): nothing to settle. */
  | { kind: "ignored" };

export function parseSettleEvent(eventType: string, payload: unknown): SettleEvent {
  const itemKind = payoutEventKind(eventType);
  if (itemKind) {
    const item = parsePayoutItemEvent(payload);
    const { milestoneId, party } = item;
    return milestoneId && party ? { kind: "item", itemKind, item: { ...item, milestoneId, party } } : { kind: "ignored" };
  }
  if (eventType === PAYPAL_EVENTS.captureRefunded) return { kind: "refund", refund: parseRefundEvent(payload) };
  if (eventType === PAYPAL_EVENTS.payoutsBatchDenied) return { kind: "batch_denied", batch: parsePayoutBatchEvent(payload) };
  return { kind: "ignored" };
}

// ---------- DB helpers ----------

type MilestoneRow = typeof milestones.$inferSelect;
type ContractRow = NonNullable<Awaited<ReturnType<Db["query"]["contracts"]["findFirst"]>>>;

async function hasLedgerRef(tx: Tx, ref: string): Promise<boolean> {
  const [row] = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.ref, ref)).limit(1);
  return row !== undefined;
}

/**
 * Posts the mirror of the transaction booked under `fromRef` (directions swapped) under `toRef`, once. Returns the
 * amount taken back (the mirrored debits), 0 when `toRef` was already posted or nothing was booked under `fromRef`.
 */
async function mirrorRef(tx: Tx, fromRef: string, toRef: string, currency: string): Promise<number> {
  if (await hasLedgerRef(tx, toRef)) return 0;
  const posted = await tx
    .select({ account: ledgerEntries.account, amountMinor: ledgerEntries.amountMinor, direction: ledgerEntries.direction })
    .from(ledgerEntries)
    .where(eq(ledgerEntries.ref, fromRef));
  if (posted.length === 0) return 0;
  await postTransaction(tx, { ref: toRef, currency, entries: reverseEntries(posted) });
  return posted.filter((r) => r.direction === "debit").reduce((s, r) => s + r.amountMinor, 0);
}

/** The milestone's op of this kind, locked for the rest of the transaction. */
async function lockOp(tx: Tx, kind: typeof OP_KINDS.payout | typeof OP_KINDS.refund, milestoneId: string): Promise<OpRow | undefined> {
  const [row] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, milestoneId))).for("update");
  return row;
}

/**
 * Resolves the milestone an event belongs to, first match wins: our op of `kind` by its PayPal id, then by its request
 * id (a batch's sender_batch_id), then the milestone by its capture id (a refund's "up" link), then the job's hint.
 */
async function resolveMilestone(
  q: Executor,
  by: { kind: typeof OP_KINDS.payout | typeof OP_KINDS.refund; paypalId?: string | undefined; requestId?: string | undefined; captureId?: string | undefined },
  hint: string | null,
): Promise<string | undefined> {
  const opKey = async (column: typeof paypalOps.paypalId | typeof paypalOps.requestId, value: string) =>
    (await q.query.paypalOps.findFirst({ columns: { key: true }, where: and(eq(paypalOps.kind, by.kind), eq(column, value)) }))?.key;
  const milestoneId = async (column: typeof milestones.paypalCaptureId | typeof milestones.id, value: string) =>
    (await q.query.milestones.findFirst({ columns: { id: true }, where: eq(column, value) }))?.id;
  return (
    (by.paypalId ? await opKey(paypalOps.paypalId, by.paypalId) : undefined) ??
    (by.requestId ? await opKey(paypalOps.requestId, by.requestId) : undefined) ??
    (by.captureId ? await milestoneId(milestones.paypalCaptureId, by.captureId) : undefined) ??
    (hint ? await milestoneId(milestones.id, hint) : undefined)
  );
}

// ---------- Job ----------

interface After {
  receipt?: { m: MilestoneRow; contract: ContractRow; amountMinor: number };
  /** The milestone just reached released: the auto-fund rule may fund the contract's next milestone. */
  released?: { m: MilestoneRow; contract: ContractRow };
}

type Apply = (tx: Tx, m: MilestoneRow, contract: ContractRow) => Promise<After>;

/**
 * Enqueued by the PayPal webhook route with { eventId, eventType } after the event was verified and stored once.
 * Handles PAYMENT.PAYOUTS-ITEM.*, PAYMENT.PAYOUTSBATCH.DENIED and PAYMENT.CAPTURE.REFUNDED. Each event is applied in one transaction that locks the
 * milestone row and the webhook row, so concurrent runs cannot double-post the ledger. Nothing here ever enqueues a
 * release: one payout attempt per milestone, and anything that goes wrong is flagged for an operator.
 */
export async function settle(job: Job<JobData>): Promise<void> {
  const db = getDb();
  const eventId = asString(job.data.eventId);
  if (!eventId) throw new Error(`settle job ${job.id} has no eventId`);
  const row = await db.query.webhookEvents.findFirst({ where: (w, { and, eq }) => and(eq(w.source, "paypal"), eq(w.eventId, eventId)) });
  if (!row) throw new Error(`webhook event ${eventId} not stored yet`);
  if (row.processedAt) return;

  const eventType = row.type;
  const hint = asString(job.data.milestoneId);
  const event = parseSettleEvent(eventType, row.payload);
  let milestoneId: string | undefined;
  let apply: Apply | undefined;
  switch (event.kind) {
    case "item":
      milestoneId = event.item.milestoneId;
      apply = (tx, m, contract) => settleItem(tx, m, contract, eventId, eventType, event.itemKind, event.item);
      break;
    case "refund":
      milestoneId = await resolveMilestone(db, { kind: OP_KINDS.refund, paypalId: event.refund.refundId, captureId: event.refund.captureId }, hint);
      apply = (tx, m, contract) => settleRefund(tx, m, contract, eventId, event.refund);
      break;
    case "batch_denied":
      milestoneId = await resolveMilestone(db, { kind: OP_KINDS.payout, paypalId: event.batch.payoutBatchId, requestId: event.batch.senderBatchId }, hint);
      apply = (tx, m) => settleBatchDenied(tx, m, eventId, eventType, event.batch);
      if (!milestoneId) {
        await audit(db, { actor: "paypal", event: AUDIT_EVENTS.paypalPayoutBatchUnmatched, detail: { eventId, payoutBatchId: event.batch.payoutBatchId ?? null, senderBatchId: event.batch.senderBatchId ?? null } });
      }
      break;
    case "ignored":
      break;
  }
  if (!milestoneId || !apply) {
    await markWebhookProcessed(db, { id: row.id });
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
    await markWebhookProcessed(tx, { id: row.id });
    return out;
  });

  if (after.receipt) await issueReceipt(db, after.receipt.m, after.receipt.contract, after.receipt.amountMinor);
  if (after.released) await enqueueAutofund(db, after.released.m, after.released.contract);
}

/**
 * After a milestone reaches released: when the client has a live mandate with auto_fund_next, enqueue the autofund job
 * for the contract's next draft milestone (one job per milestone: the dedupe key makes a repeat a no-op). The job
 * checks the whole funding guarantee itself; this only decides whether to ask. A failed enqueue is audited, not thrown:
 * the release is final either way, and the client can still fund the milestone by hand.
 */
async function enqueueAutofund(db: Db, m: MilestoneRow, contract: ContractRow): Promise<void> {
  try {
    if ((await autoFundMandates(db, contract.clientId)).length === 0) return;
    const next = await nextDraftMilestone(db, contract.id);
    if (!next) return;
    await enqueue("autofund", next.id, { contractId: contract.id, releasedMilestoneId: m.id }, { dedupe: "autofund" });
  } catch (err) {
    await audit(db, { actor: "system", event: "agent.autofund_enqueue_failed", milestoneId: m.id, contractId: contract.id, detail: { error: err instanceof Error ? err.message : String(err) } });
  }
}

/** The audit entry for an in-flight item event (UNCLAIMED / HELD). */
const IN_FLIGHT_EVENTS = { unclaimed: AUDIT_EVENTS.paypalPayoutUnclaimed, held: AUDIT_EVENTS.paypalPayoutHeld } as const;

async function settleItem(
  tx: Tx,
  m: MilestoneRow,
  contract: ContractRow,
  eventId: string,
  eventType: string,
  kind: PayoutEventKind,
  item: PayoutItemEvent & { party: PayoutParty },
): Promise<After> {
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const detail = { eventId, eventType, party: item.party, payoutBatchId: item.payoutBatchId ?? null, payoutItemId: item.payoutItemId ?? null };
  const op = await lockOp(tx, OP_KINDS.payout, milestoneId);
  const match = matchPayoutOp(op, item.payoutBatchId);
  if (match === "wait") {
    // Our payout was claimed but PayPal's answer (the batch id) is not recorded yet: retry this job, the release job's
    // retry (same PayPal-Request-Id) records it.
    throw new Error(`payout op for milestone ${milestoneId} has no batch id recorded yet; event ${eventId} will be retried`);
  }
  if (match === "unmatched" || !op) {
    await audit(tx, { ...base, event: op ? AUDIT_EVENTS.paypalUnmatchedBatch : AUDIT_EVENTS.paypalPayoutUnmatched, detail: { ...detail, opBatchId: op?.paypalId ?? null } });
    return {};
  }

  const claim = parseClaim(op.request);
  if (!claim) throw new Error(`payout op ${op.key} has no claim`);
  const amountMinor = item.amountValue ? fromPayPalValue(item.amountValue, item.currency ?? contract.currency) : null;

  if (kind === "unclaimed" || kind === "held") {
    // Still in flight: the receiver can claim it (UNCLAIMED) or PayPal is reviewing it (HELD); a final item event follows.
    await audit(tx, { ...base, event: IN_FLIGHT_EVENTS[kind], detail: { ...detail, amountMinor } });
    return {};
  }
  // The advance this milestone's partner share repays, for the audit trail ("repaid" / "shortfall" too: the partner's
  // item may settle before the freelancer's).
  const advance = await tx.query.advances.findFirst({ columns: { id: true }, where: (a, { and, eq, inArray }) => and(eq(a.milestoneId, milestoneId), inArray(a.status, ["funded", "repaid", "shortfall"])) });
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
    await audit(tx, { ...base, event: AUDIT_EVENTS.paypalPayoutItemConflict, detail: { ...detail, recorded: itemOutcomes(op.response)[item.party] ?? null } });
  }
  if (!merged.changed) return {};
  const items = itemOutcomes(merged.response);
  const opStatus = deriveOpStatus(claim.shares, items, itemReversals(merged.response));
  await tx.update(paypalOps).set({ response: merged.response, status: opStatus, updatedAt: new Date() }).where(eq(paypalOps.id, op.id));

  if (kind === "failed") {
    await audit(tx, { ...base, event: AUDIT_EVENTS.paypalPayoutFailed, detail: { ...detail, reason: item.reason ?? null, opStatus } });
    if (item.party === "partner") await audit(tx, { ...base, event: AUDIT_EVENTS.advanceRepaymentFailed, detail: { ...detail, advanceId: advance?.id ?? null, reason: item.reason ?? null } });
    // R7: any failed item holds the milestone for an operator; it never ends released.
    await flagNeedsOperator(tx, m, { actor: "paypal", reason: `Payout ${eventType} for the ${item.party}: ${item.reason ?? "no reason given"}`, detail: { eventId } });
    return {};
  }

  // Money moved: book exactly what PayPal paid for this item, once.
  const booked = amountMinor ?? (item.party === "partner" ? claim.shares.partnerShareMinor : claim.shares.freelancerShareMinor);
  const ref = ledgerRefs.release(milestoneId, item.party);
  if (item.party === "partner") {
    // The claim names the advances this payment repays (the milestone's own, then balances carried from earlier ones).
    if (booked > 0) await bookPartnerRepayment(tx, m, contract, claim.advances, booked, { ...detail, payoutItemId: item.payoutItemId ?? null });
  } else if (booked > 0 && !(await hasLedgerRef(tx, ref))) {
    await postTransaction(tx, { ref, currency: contract.currency, entries: releaseEntries({ milestoneId, freelancerId: contract.freelancerId, amountMinor: booked }) });
  }
  if (opStatus === "failed") {
    // The other item already failed: the milestone is held; refresh the operator's picture with this payment.
    await flagNeedsOperator(tx, m, { actor: "paypal", reason: `The ${item.party} was paid after another item of the same payout failed`, detail: { eventId } });
    return {};
  }
  if (opStatus !== "succeeded") return {}; // wait for the other item

  // A partial (or any release with a refunded share) is final only once the refund half succeeded too.
  const refundOp = claim.refundMinor > 0 ? await lockOp(tx, OP_KINDS.refund, milestoneId) : undefined;
  return finalise(tx, m, contract, claim, { payout: opStatus, refund: refundOp?.status, items }, detail);
}

/**
 * Books a succeeded partner item: splits what PayPal paid across the claimed advances in order (allocateRepayment, the
 * same split the release job claimed), posts one balanced transaction per advance (held -> partner receivable for the
 * principal, -> partner fees for the fee) under its own ref, each once, and sets each advance "repaid" when it got all
 * it owed, else "shortfall" with the remaining balance in the audit detail (the next release collects it).
 */
async function bookPartnerRepayment(tx: Tx, m: MilestoneRow, contract: ContractRow, dues: readonly ClaimAdvance[], booked: number, detail: Record<string, unknown>): Promise<void> {
  const base = { actor: "paypal", milestoneId: m.id, contractId: m.contractId } as const;
  if (dues.length === 0) {
    await audit(tx, { ...base, event: AUDIT_EVENTS.ledgerSkipped, detail: { ...detail, reason: "partner item paid but the claim names no advance", amountMinor: booked } });
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
      await audit(tx, { ...base, event: AUDIT_EVENTS.ledgerSkipped, detail: { ...detail, reason: "claimed advance not found", advanceId: d.advanceId, amountMinor: paidMinor } });
      continue;
    }
    const ref = ledgerRefs.advanceRepayment(m.id, a);
    if (paidMinor > 0 && !(await hasLedgerRef(tx, ref))) {
      await postTransaction(tx, {
        ref,
        currency: contract.currency,
        entries: releaseEntries({ milestoneId: m.id, freelancerId: contract.freelancerId, amountMinor: paidMinor, advance: { partnerId: a.partnerId, principalMinor: x.principalMinor, feeMinor: x.feeMinor } }),
      });
    }
    const owedMinor = d.principalMinor + d.feeMinor;
    const remainingMinor = Math.max(0, owedMinor - paidMinor);
    const next = remainingMinor === 0 ? "repaid" : "shortfall";
    const done = await tx
      .update(advances)
      .set({ status: next, ...(next === "repaid" ? { repaidAt: new Date() } : {}) })
      .where(and(eq(advances.id, a.id), inArray(advances.status, ["funded", "shortfall"])))
      .returning({ id: advances.id });
    if (done.length > 0) {
      const info = { advanceId: a.id, advanceMilestoneId: a.milestoneId, carried: a.milestoneId !== m.id, partnerId: a.partnerId, owedMinor, paidMinor, principalPaidMinor: x.principalMinor, feePaidMinor: x.feeMinor, remainingMinor, ...detail };
      await audit(tx, { ...base, event: next === "repaid" ? AUDIT_EVENTS.advanceRepaid : AUDIT_EVENTS.advanceShortfall, detail: info });
    }
  }
  if (booked > allocated) {
    // More than every claimed balance: left in the milestone's held account for an operator, never credited to anyone.
    await audit(tx, { ...base, event: AUDIT_EVENTS.ledgerPartnerExcess, detail: { ...detail, amountMinor: booked, allocatedMinor: allocated, excessMinor: booked - allocated } });
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
  const base = { actor: "paypal", milestoneId: m.id, contractId: m.contractId } as const;
  const target = settleTarget(claim.action);
  const state = finalisation(claim, halves.payout, halves.refund);
  if (state === "blocked") return {}; // the failed half flagged an operator; the milestone stays held
  if (state === "wait") {
    await audit(tx, { ...base, event: AUDIT_EVENTS.settleWaiting, detail: { ...detail, to: target, payoutOpStatus: halves.payout ?? null, refundOpStatus: halves.refund ?? null } });
    return {};
  }
  const total = paidTotal(claim.shares, halves.items);
  if (m.status === target) return {};
  const flagged = await isFlaggedForOperator(tx, m.id);
  if (flagged || !canTransition(m.status, target)) {
    await audit(tx, { ...base, event: AUDIT_EVENTS.milestoneSettleConflict, detail: { ...detail, from: m.status, to: target, amountMinor: total, needsOperator: flagged } });
    return {};
  }
  const moved = await transition(tx, m.id, target, { actor: "paypal", event: `milestone.${target}`, detail: { ...detail, amountMinor: total, refundMinor: claim.refundMinor } });
  return { ...(moved && total > 0 ? { receipt: { m, contract, amountMinor: total } } : {}), ...(moved && target === "released" ? { released: { m, contract } } : {}) };
}

/**
 * PAYMENT.PAYOUTSBATCH.DENIED: PayPal refused the whole batch, so no item was paid. The payout op (matched by the batch
 * id as for items, or by sender_batch_id, which is the op's own PayPal-Request-Id) is marked failed and an operator is
 * flagged. A repeat for an op the release job already recorded as denied only adds the audit entry.
 */
async function settleBatchDenied(tx: Tx, m: MilestoneRow, eventId: string, eventType: string, batch: PayoutBatchEvent): Promise<After> {
  const base = { actor: "paypal", milestoneId: m.id, contractId: m.contractId } as const;
  const detail = { eventId, eventType, payoutBatchId: batch.payoutBatchId ?? null, senderBatchId: batch.senderBatchId ?? null, batchStatus: batch.batchStatus ?? null };
  const op = await lockOp(tx, OP_KINDS.payout, m.id);
  const ours = op !== undefined && op.status !== "pending" && batch.senderBatchId !== undefined && op.requestId === batch.senderBatchId;
  const match = ours ? "match" : matchPayoutOp(op, batch.payoutBatchId);
  if (match === "wait") throw new Error(`payout op for milestone ${m.id} has no batch id recorded yet; event ${eventId} will be retried`);
  if (match === "unmatched" || !op) {
    await audit(tx, { ...base, event: op ? AUDIT_EVENTS.paypalUnmatchedBatch : AUDIT_EVENTS.paypalPayoutUnmatched, detail: { ...detail, opBatchId: op?.paypalId ?? null } });
    return {};
  }
  const wasFailed = op.status === "failed";
  await tx
    .update(paypalOps)
    .set({
      status: "failed",
      paypalId: op.paypalId ?? batch.payoutBatchId ?? null,
      response: { ...asRecord(op.response), batchDenied: { eventId, batchStatus: batch.batchStatus ?? "DENIED" } },
      updatedAt: new Date(),
    })
    .where(eq(paypalOps.id, op.id));
  await audit(tx, { ...base, event: AUDIT_EVENTS.paypalPayoutBatchDenied, detail: { ...detail, opStatus: op.status } });
  if (wasFailed && (await isFlaggedForOperator(tx, m.id))) return {};
  await flagNeedsOperator(tx, m, { actor: "paypal", reason: "PayPal denied the payout batch", detail: { eventId, payoutBatchId: batch.payoutBatchId ?? op.paypalId ?? null } });
  return {};
}

/**
 * R9: a RETURNED / REVERSED / REFUNDED item. The release posting for that party (if any) is mirrored under
 * reversal:<milestoneId>:<party> (debit the party, credit held), the milestone goes to held (the guarded "reversal"
 * edge out of released / partial_released) and an operator is flagged.
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
  const milestoneId = m.id;
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

  let reversedMinor = await mirrorRef(tx, ledgerRefs.release(milestoneId, item.party), ledgerRefs.reversal(milestoneId, item.party), contract.currency);
  if (item.party === "partner") {
    // Repayments of balances carried from earlier milestones were booked under their own refs: mirror them too. The
    // advances keep their status: the money went back to the platform, not to the freelancer, so an operator re-sends it.
    for (const d of claim.advances) {
      if (d.milestoneId === milestoneId) continue;
      const a = { id: d.advanceId, milestoneId: d.milestoneId };
      reversedMinor += await mirrorRef(tx, ledgerRefs.advanceRepayment(milestoneId, a), ledgerRefs.advanceReversal(milestoneId, a), contract.currency);
    }
  }
  await audit(tx, { actor: "paypal", milestoneId, contractId: m.contractId, event: AUDIT_EVENTS.paypalPayoutReversed, detail: { ...detail, reversedMinor, opStatus } });

  let status = m.status;
  if (m.status === "released" || m.status === "partial_released") {
    await transition(tx, milestoneId, "held", { actor: "paypal", event: AUDIT_EVENTS.milestoneReversed, detail: { ...detail, reversedMinor } }, { cause: "reversal" });
    status = "held";
  }
  await flagNeedsOperator(tx, { ...m, status }, { actor: "paypal", reason: `Payout ${detail.eventType} for the ${item.party}`, detail: { eventId: detail.eventId, reversedMinor } });
  return {};
}

/** Refund statuses that mean the money did not go back to the client. */
const REFUND_FAILED = new Set(["FAILED", "CANCELLED"]);

async function settleRefund(tx: Tx, m: MilestoneRow, contract: ContractRow, eventId: string, refund: RefundEvent): Promise<After> {
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const op = await lockOp(tx, OP_KINDS.refund, milestoneId);
  const claim = op ? parseClaim(op.request) : null;
  const eventMinor = refund.amountValue ? fromPayPalValue(refund.amountValue, refund.currency ?? contract.currency) : null;
  if (!op || !isOurRefund(op, claim?.refundMinor ?? null, { ...(refund.refundId ? { refundId: refund.refundId } : {}), amountMinor: eventMinor })) {
    // Not the refund this platform sent for the release (e.g. a dispute, a manual refund, another amount): logged, not booked.
    await audit(tx, { ...base, event: AUDIT_EVENTS.paypalRefundUnmatched, detail: { eventId, refundId: refund.refundId ?? null, captureId: refund.captureId ?? null, amountMinor: eventMinor, opRefundId: op?.paypalId ?? null } });
    return {};
  }
  const amountMinor = eventMinor ?? claim?.refundMinor ?? 0;
  const refundId = refund.refundId ?? op.paypalId ?? null;
  const failed = refund.status !== undefined && REFUND_FAILED.has(refund.status);
  await tx
    .update(paypalOps)
    .set({
      // A failed refund never overwrites a refund already recorded as succeeded.
      status: failed && op.status !== "succeeded" ? "failed" : "succeeded",
      paypalId: op.paypalId ?? refund.refundId ?? null,
      response: { ...asRecord(op.response), webhook: { eventId, status: refund.status ?? null, amountMinor } },
      updatedAt: new Date(),
    })
    .where(eq(paypalOps.id, op.id));

  if (failed) {
    // The refund half failed: nothing is booked, the milestone stays out of its final state (held) for an operator.
    await audit(tx, { ...base, event: AUDIT_EVENTS.paypalRefundFailed, detail: { eventId, refundId, status: refund.status, amountMinor } });
    await flagNeedsOperator(tx, m, { actor: "paypal", reason: `PayPal refund ${refund.status}`, detail: { eventId, refundId } });
    return {};
  }

  const ref = ledgerRefs.refund(milestoneId);
  if (amountMinor > 0 && !(await hasLedgerRef(tx, ref))) {
    await postTransaction(tx, {
      ref,
      currency: contract.currency,
      entries: [
        { account: accounts.held(milestoneId), amountMinor, direction: "debit" },
        { account: accounts.client(contract.clientId), amountMinor, direction: "credit" },
      ],
    });
  }
  await audit(tx, { ...base, event: AUDIT_EVENTS.paypalRefundSettled, detail: { eventId, refundId, amountMinor, currency: contract.currency } });

  // The refund half is done: final now when nothing was released (a refund-only partial) or the payout already succeeded.
  if (!claim) return {};
  const payoutOp = claim.releaseMinor > 0 ? await lockOp(tx, OP_KINDS.payout, milestoneId) : undefined;
  return finalise(tx, m, contract, claim, { payout: payoutOp?.status, refund: "succeeded", items: itemOutcomes(payoutOp?.response) }, { eventId, refundMinor: amountMinor });
}

async function issueReceipt(db: Db, m: MilestoneRow, contract: ContractRow, amountMinor: number): Promise<void> {
  const base = { milestoneId: m.id, contractId: contract.id } as const;
  // The simulator issues receipts too; outside simulated mode a receipt needs the platform's real credentials.
  if (paypalMode() !== "simulated" && (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET)) {
    await audit(db, { ...base, actor: "system", event: AUDIT_EVENTS.receiptSkipped, detail: { reason: "PayPal credentials are not configured" } });
    return;
  }
  const existing = await db.query.paypalOps.findFirst({ where: (o, { and, eq }) => and(eq(o.kind, OP_KINDS.invoice), eq(o.key, m.id)) });
  if (existing?.status === "succeeded") return;

  const [client, freelancer] = await Promise.all([
    db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.clientId) }),
    db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) }),
  ]);
  if (!client || !freelancer) {
    await audit(db, { ...base, actor: "system", event: AUDIT_EVENTS.receiptSkipped, detail: { reason: "client or freelancer user not found" } });
    return;
  }

  const payoutOp = await db.query.paypalOps.findFirst({ where: (o, { and, eq }) => and(eq(o.kind, OP_KINDS.payout), eq(o.key, m.id)) });
  const requestId = await requestIdFor(db, OP_KINDS.invoice, m.id);
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
    await audit(db, { ...base, actor: "paypal", event: AUDIT_EVENTS.paypalReceipt, detail: { invoiceId, invoiceUrl: invoiceUrl ?? null } });
  } catch (err) {
    // The money has moved and the state is final; a missing receipt is logged, not retried forever.
    const error = err instanceof Error ? err.message : String(err);
    await recordOpResult(db, requestId, { status: "failed", response: { error } });
    await audit(db, { ...base, actor: "paypal", event: AUDIT_EVENTS.paypalReceiptFailed, detail: { error } });
  }
}
