import type { Job } from "pg-boss";
import { and, eq } from "drizzle-orm";
import {
  PAYPAL_EVENTS,
  TRANSITIONS,
  accounts,
  advances,
  audit,
  enqueue,
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
  type MilestoneStatus,
} from "@milestone/core";
import { issuePaidReceipt } from "@milestone/money";
import type { JobData } from "../handlers.js";
import { getDb } from "../lib/db.js";
import { paypal } from "../lib/paypal.js";
import {
  advanceRepayment,
  itemOutcomes,
  parseClaim,
  parseDecision,
  payoutShares,
  releaseOps,
  type ItemOutcome,
  type ItemStatus,
  type OpRow,
  type PayoutParty,
  type ReleaseClaim,
} from "./release.js";

export type { PayoutParty } from "./release.js";

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

/** The milestone settles on the freelancer's item, or on the partner's item when the partner took the whole release. */
export function settlesMilestone(party: PayoutParty, shares: { freelancerShareMinor: number }): boolean {
  return party === "freelancer" || shares.freelancerShareMinor === 0;
}

export function settleTarget(action: string): "released" | "partial_released" {
  return action === "partial" ? "partial_released" : "released";
}

export function canHold(status: MilestoneStatus): boolean {
  return status === "held" || TRANSITIONS[status].includes("held");
}

/** PayPal caps invoice_number at 25 characters; deterministic per milestone so a retry reuses it. */
export function receiptInvoiceNumber(milestoneId: string): string {
  return `MS-${milestoneId.replace(/-/g, "").slice(0, 22)}`;
}

/** Maps a payout item event type to the item's outcome; null for anything else. */
export function itemStatusFor(eventType: string): ItemStatus | null {
  if (eventType === PAYPAL_EVENTS.payoutItemSucceeded) return "succeeded";
  if (eventType === PAYPAL_EVENTS.payoutItemFailed || eventType === PAYPAL_EVENTS.payoutItemBlocked) return "failed";
  return null;
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

/** Op status from its items: any failed item fails the op; it succeeds once every party with a share has succeeded. */
export function deriveOpStatus(shares: { partnerShareMinor: number; freelancerShareMinor: number }, items: Partial<Record<PayoutParty, ItemOutcome>>): "sent" | "succeeded" | "failed" {
  if (items.partner?.status === "failed" || items.freelancer?.status === "failed") return "failed";
  const expected: PayoutParty[] = [];
  if (shares.partnerShareMinor > 0) expected.push("partner");
  if (shares.freelancerShareMinor > 0) expected.push("freelancer");
  return expected.length > 0 && expected.every((p) => items[p]?.status === "succeeded") ? "succeeded" : "sent";
}

/** Total paid out according to the recorded items (falls back to the claimed share when PayPal sent no amount). */
export function paidTotal(shares: { partnerShareMinor: number; freelancerShareMinor: number }, items: Partial<Record<PayoutParty, ItemOutcome>>): number {
  let total = 0;
  if (items.partner?.status === "succeeded") total += items.partner.amountMinor ?? shares.partnerShareMinor;
  if (items.freelancer?.status === "succeeded") total += items.freelancer.amountMinor ?? shares.freelancerShareMinor;
  return total;
}

/** Ledger refs: one release posting per party and one refund posting per milestone, checked under the milestone lock. */
export const ledgerRef = {
  release: (milestoneId: string, party: PayoutParty) => (party === "freelancer" ? `release:${milestoneId}` : `release:${milestoneId}:partner`),
  refund: (milestoneId: string) => `refund:${milestoneId}`,
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

/** Resolves the milestone a refund event belongs to: our refund op's PayPal id, then the capture id. */
async function milestoneForRefund(db: Db, refund: RefundEvent, hint: string | undefined): Promise<string | undefined> {
  if (refund.refundId) {
    const op = await db.query.paypalOps.findFirst({ where: and(eq(paypalOps.kind, "refund"), eq(paypalOps.paypalId, refund.refundId)) });
    if (op) return op.key;
    // The webhook route's contract: capture id = resource.id.
    const m = await db.query.milestones.findFirst({ where: eq(milestones.paypalCaptureId, refund.refundId) });
    if (m) return m.id;
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

/** A payout op written before claims existed: rebuild the shares from the stored decision. */
function legacyClaim(m: MilestoneRow, contract: ContractRow, owedMinor: number): ReleaseClaim | null {
  const d = parseDecision(m.decision);
  if (!d || (d.action !== "release" && d.action !== "partial")) return null;
  return {
    deliveryId: "",
    attempt: 1,
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
  finishRefund?: string;
}

/**
 * Enqueued by the PayPal webhook route with { eventId, eventType } after the event was verified and stored once.
 * Handles PAYMENT.PAYOUTS-ITEM.SUCCEEDED / FAILED / BLOCKED and PAYMENT.CAPTURE.REFUNDED. Each event is applied in one
 * transaction that locks the milestone row and the webhook row, so concurrent runs cannot double-post the ledger.
 */
export async function settle(job: Job<JobData>): Promise<void> {
  const db = getDb();
  const eventId = str(job.data.eventId);
  if (!eventId) throw new Error(`settle job ${job.id} has no eventId`);
  const row = await db.query.webhookEvents.findFirst({ where: (w, { and, eq }) => and(eq(w.source, "paypal"), eq(w.eventId, eventId)) });
  if (!row) throw new Error(`webhook event ${eventId} not stored yet`);
  if (row.processedAt) return;

  const eventType = row.type;
  const itemStatus = itemStatusFor(eventType);
  let milestoneId: string | undefined;
  let apply: ((tx: Tx, m: MilestoneRow, contract: ContractRow) => Promise<After>) | undefined;

  if (itemStatus) {
    const item = parsePayoutItemEvent(row.payload);
    if (item.party && item.milestoneId) {
      milestoneId = item.milestoneId;
      const party = item.party;
      apply = (tx, m, contract) => settleItem(tx, m, contract, eventId, eventType, itemStatus, { ...item, party });
    }
  } else if (eventType === PAYPAL_EVENTS.captureRefunded) {
    const refund = parseRefundEvent(row.payload);
    milestoneId = await milestoneForRefund(db, refund, str(job.data.milestoneId));
    apply = (tx, m, contract) => settleRefund(tx, m, contract, eventId, refund);
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

  if (after.finishRefund) {
    // The milestone settled while its refund is unfinished: run the release job again to (re)send it.
    await enqueue("release", id, { deliveryId: after.finishRefund }, { dedupe: `refund-${after.finishRefund}` });
  }
  if (after.receipt) await issueReceipt(db, after.receipt.m, after.receipt.contract, after.receipt.amountMinor);
}

async function settleItem(
  tx: Tx,
  m: MilestoneRow,
  contract: ContractRow,
  eventId: string,
  eventType: string,
  status: ItemStatus,
  item: PayoutItemEvent & { party: PayoutParty },
): Promise<After> {
  const t = tx as unknown as Db;
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const ops = await releaseOps(tx, milestoneId);
  const op: (OpRow & { attempt: number }) | undefined =
    (item.payoutBatchId ? ops.payouts.find((o) => o.paypalId === item.payoutBatchId) : undefined) ?? ops.payouts.filter((o) => o.status !== "pending").at(-1);
  if (!op) {
    await audit(t, { ...base, event: "paypal.payout_unmatched", detail: { eventId, eventType, party: item.party, payoutBatchId: item.payoutBatchId ?? null } });
    return {};
  }

  // "repaid" too: the partner's item may settle before the freelancer's, and the ledger still needs the advance.
  const advance = await tx.query.advances.findFirst({ where: (a, { and, eq, inArray }) => and(eq(a.milestoneId, milestoneId), inArray(a.status, ["funded", "repaid"])) });
  const owed = advance ? advanceRepayment(advance, m.decidedAt) : undefined;
  const claim = parseClaim(op.request) ?? legacyClaim(m, contract, owed ? owed.principalMinor + owed.feeMinor : 0);
  if (!claim) throw new Error(`payout op ${op.key} has no claim and milestone ${milestoneId} no usable decision`);

  const amountMinor = item.amountValue ? fromPayPalValue(item.amountValue, item.currency ?? contract.currency) : null;
  const outcome: ItemOutcome = {
    status,
    amountMinor,
    eventId,
    ...(item.payoutItemId ? { payoutItemId: item.payoutItemId } : {}),
    ...(item.reason ? { reason: item.reason } : {}),
  };
  const merged = mergeItemOutcome(op.response, item.party, outcome);
  if (merged.conflict) {
    await audit(t, { ...base, event: "paypal.payout_item_conflict", detail: { eventId, eventType, party: item.party, recorded: itemOutcomes(op.response)[item.party] ?? null } });
  }
  if (!merged.changed) return {};
  const items = itemOutcomes(merged.response);
  const opStatus = deriveOpStatus(claim.shares, items);
  await tx.update(paypalOps).set({ response: merged.response, status: opStatus, updatedAt: new Date() }).where(eq(paypalOps.id, op.id));

  const detail = { eventId, eventType, party: item.party, attempt: op.attempt, payoutBatchId: item.payoutBatchId ?? null, payoutItemId: item.payoutItemId ?? null };
  const settles = settlesMilestone(item.party, claim.shares);

  if (status === "failed") {
    await audit(t, { ...base, event: "paypal.payout_failed", detail: { ...detail, reason: item.reason ?? null, opStatus } });
    if (settles && canHold(m.status) && m.status !== "held") {
      await transition(t, milestoneId, "held", { actor: "paypal", event: "milestone.held", detail: { reason: `Payout ${eventType}: ${item.reason ?? "no reason given"}`, eventId } });
    } else if (item.party === "partner") {
      await audit(t, { ...base, event: "advance.repayment_failed", detail: { ...detail, advanceId: advance?.id ?? null, reason: item.reason ?? null } });
    }
    return {};
  }

  // Money moved: book exactly what PayPal paid for this item, once.
  const booked = amountMinor ?? (item.party === "partner" ? claim.shares.partnerShareMinor : claim.shares.freelancerShareMinor);
  const ref = ledgerRef.release(milestoneId, item.party);
  if (booked > 0 && !(await hasLedgerRef(tx, ref))) {
    if (item.party === "partner") {
      if (advance && owed) {
        await postTransaction(t, {
          ref,
          currency: contract.currency,
          entries: releaseEntries({ milestoneId, freelancerId: contract.freelancerId, amountMinor: booked, advance: { partnerId: advance.partnerId, principalMinor: owed.principalMinor, feeMinor: owed.feeMinor } }),
        });
      } else {
        await audit(t, { ...base, event: "ledger.skipped", detail: { ...detail, reason: "partner item paid but the milestone has no advance", amountMinor: booked } });
      }
    } else {
      await postTransaction(t, { ref, currency: contract.currency, entries: releaseEntries({ milestoneId, freelancerId: contract.freelancerId, amountMinor: booked }) });
    }
  }
  if (item.party === "partner" && advance?.status === "funded") {
    const done = await tx.update(advances).set({ status: "repaid", repaidAt: new Date() }).where(and(eq(advances.id, advance.id), eq(advances.status, "funded"))).returning({ id: advances.id });
    if (done.length > 0) await audit(t, { ...base, event: "advance.repaid", detail: { advanceId: advance.id, eventId, payoutItemId: item.payoutItemId ?? null, amountMinor: booked, ...owed } });
  }
  if (!settles) return {};

  const target = settleTarget(claim.action);
  if (m.status !== target && !TRANSITIONS[m.status].includes(target)) {
    // e.g. held after a failed partner item: the money is booked, the state needs a human.
    await audit(t, { ...base, event: "milestone.settle_conflict", detail: { ...detail, from: m.status, to: target, amountMinor: booked } });
    return {};
  }
  const total = paidTotal(claim.shares, items);
  const moved = await transition(t, milestoneId, target, { actor: "paypal", event: `milestone.${target}`, detail: { ...detail, amountMinor: total } });
  const after: After = {};
  if (moved) after.receipt = { m, contract, amountMinor: total };
  if (claim.refundMinor > 0 && claim.deliveryId && ops.refund?.status !== "succeeded") after.finishRefund = claim.deliveryId;
  return after;
}

async function settleRefund(tx: Tx, m: MilestoneRow, contract: ContractRow, eventId: string, refund: RefundEvent): Promise<After> {
  const t = tx as unknown as Db;
  const milestoneId = m.id;
  const base = { actor: "paypal", milestoneId, contractId: m.contractId } as const;
  const { refund: op } = await releaseOps(tx, milestoneId);
  const otherRefund = op?.paypalId && refund.refundId && op.paypalId !== refund.refundId && refund.refundId !== m.paypalCaptureId;
  if (!op || otherRefund) {
    // Not a refund this platform sent for a release (e.g. a dispute or a manual refund): logged, not booked.
    await audit(t, { ...base, event: "paypal.refund_unmatched", detail: { eventId, refundId: refund.refundId ?? null, captureId: refund.captureId ?? null } });
    return {};
  }
  const claim = parseClaim(op.request);
  const amountMinor = refund.amountValue ? fromPayPalValue(refund.amountValue, refund.currency ?? contract.currency) : (claim?.refundMinor ?? 0);

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

  // A refund-only partial (nothing released) settles on the refund.
  if (claim && claim.action === "partial" && claim.releaseMinor === 0) {
    if (m.status !== "partial_released" && TRANSITIONS[m.status].includes("partial_released")) {
      await transition(t, milestoneId, "partial_released", { actor: "paypal", event: "milestone.partial_released", detail: { eventId, refundMinor: amountMinor, amountMinor: 0 } });
    } else if (m.status !== "partial_released") {
      await audit(t, { ...base, event: "milestone.settle_conflict", detail: { eventId, from: m.status, to: "partial_released", refundMinor: amountMinor } });
    }
  }
  return {};
}

async function issueReceipt(db: Db, m: MilestoneRow, contract: ContractRow, amountMinor: number): Promise<void> {
  const base = { milestoneId: m.id, contractId: contract.id } as const;
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_CLIENT_SECRET) {
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

  const requestId = await requestIdFor(db, "invoice", m.id);
  try {
    const { invoiceId } = await issuePaidReceipt(paypal(), {
      requestId,
      invoiceNumber: receiptInvoiceNumber(m.id),
      freelancerEmail: freelancer.paypalEmail ?? freelancer.email,
      clientEmail: client.email,
      currency: contract.currency,
      amountMinor,
      description: `${contract.title}: ${m.title}`,
    });
    await recordOpResult(db, requestId, { status: "succeeded", paypalId: invoiceId });
    await audit(db, { ...base, actor: "paypal", event: "paypal.receipt", detail: { invoiceId } });
  } catch (err) {
    // The money has moved and the state is final; a missing receipt is logged, not retried forever.
    const error = err instanceof Error ? err.message : String(err);
    await recordOpResult(db, requestId, { status: "failed", response: { error } });
    await audit(db, { ...base, actor: "paypal", event: "paypal.receipt_failed", detail: { error } });
  }
}
