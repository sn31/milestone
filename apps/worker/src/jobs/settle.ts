import type { Job } from "pg-boss";
import {
  PAYPAL_EVENTS,
  TRANSITIONS,
  audit,
  postTransaction,
  recordOpResult,
  releaseEntries,
  requestIdFor,
  transition,
  type Db,
  type MilestoneStatus,
} from "@milestone/core";
import { issuePaidReceipt } from "@milestone/money";
import type { JobData } from "../handlers.js";
import { getDb } from "../lib/db.js";
import { paypal } from "../lib/paypal.js";
import { SETTLED_STATUSES, advanceRepayment, parseDecision, payoutShares } from "./release.js";

// ---------- Pure helpers (unit-tested in apps/worker/test) ----------

export type PayoutParty = "partner" | "freelancer";

export interface PayoutItemEvent {
  senderItemId?: string;
  /** Set only for release items, whose sender_item_id is "<milestoneId>:<party>" (see executeRelease). */
  milestoneId?: string;
  party?: PayoutParty;
  payoutBatchId?: string;
  payoutItemId?: string;
  transactionStatus?: string;
  reason?: string;
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

// ---------- DB helpers ----------
// The worker has no direct drizzle-orm dependency (no "eq" for update/where), so the two plain updates use the pool.

async function markProcessed(db: Db, webhookRowId: string): Promise<void> {
  await db.$client.query("update webhook_events set processed_at = now() where id = $1 and processed_at is null", [webhookRowId]);
}

async function markAdvanceRepaid(db: Db, advanceId: string): Promise<boolean> {
  const res = await db.$client.query("update advances set status = 'repaid', repaid_at = now() where id = $1 and status = 'funded'", [advanceId]);
  return (res.rowCount ?? 0) > 0;
}

// ---------- Job ----------

/** Enqueued by the PayPal webhook route with { eventId, eventType } after the event was verified and stored once. */
export async function settle(job: Job<JobData>): Promise<void> {
  const db = getDb();
  const eventId = str(job.data.eventId);
  if (!eventId) throw new Error(`settle job ${job.id} has no eventId`);
  const row = await db.query.webhookEvents.findFirst({ where: (w, { and, eq }) => and(eq(w.source, "paypal"), eq(w.eventId, eventId)) });
  if (!row) throw new Error(`webhook event ${eventId} not stored yet`);
  if (row.processedAt) return;

  const eventType = row.type;
  const item = parsePayoutItemEvent(row.payload);
  const isPayoutItem = eventType === PAYPAL_EVENTS.payoutItemSucceeded || eventType === PAYPAL_EVENTS.payoutItemFailed || eventType === PAYPAL_EVENTS.payoutItemBlocked;
  if (!isPayoutItem || !item.party || !item.milestoneId) {
    // Not a release item (e.g. an advance-funding payout): nothing for this job to settle.
    await markProcessed(db, row.id);
    return;
  }

  const milestoneId = item.milestoneId;
  const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!m) throw new Error(`milestone ${milestoneId} not found`);

  if (eventType === PAYPAL_EVENTS.payoutItemSucceeded) {
    await onSucceeded(db, eventId, item as PayoutItemEvent & { party: PayoutParty }, m);
  } else {
    await audit(db, {
      actor: "paypal",
      event: "paypal.payout_failed",
      milestoneId,
      contractId: m.contractId,
      detail: { eventId, eventType, party: item.party, payoutBatchId: item.payoutBatchId ?? null, payoutItemId: item.payoutItemId ?? null, reason: item.reason ?? null },
    });
    if (canHold(m.status)) {
      await transition(db, milestoneId, "held", { actor: "paypal", event: "milestone.held", detail: { reason: `Payout ${eventType}: ${item.reason ?? "no reason given"}`, eventId } });
    }
  }
  await markProcessed(db, row.id);
}

type MilestoneRow = NonNullable<Awaited<ReturnType<Db["query"]["milestones"]["findFirst"]>>>;

async function onSucceeded(db: Db, eventId: string, item: PayoutItemEvent & { party: PayoutParty }, m: MilestoneRow): Promise<void> {
  const milestoneId = m.id;
  const decision = parseDecision(m.decision);
  if (!decision) throw new Error(`milestone ${milestoneId} has no policy decision to settle`);
  const contract = await db.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
  if (!contract) throw new Error(`contract ${m.contractId} not found`);

  // "repaid" too: the partner's item may settle before the freelancer's, and the ledger still needs the advance.
  const advance = await db.query.advances.findFirst({ where: (a, { and, eq, inArray }) => and(eq(a.milestoneId, milestoneId), inArray(a.status, ["funded", "repaid"])) });
  const owed = advance ? advanceRepayment(advance, m.decidedAt) : undefined;

  if (item.party === "partner" && advance?.status === "funded" && (await markAdvanceRepaid(db, advance.id))) {
    await audit(db, { actor: "paypal", event: "advance.repaid", milestoneId, contractId: m.contractId, detail: { advanceId: advance.id, eventId, payoutItemId: item.payoutItemId ?? null, ...owed } });
  }

  const shares = payoutShares(decision.amountMinor, owed ? owed.principalMinor + owed.feeMinor : 0);
  if (!settlesMilestone(item.party, shares)) return;

  const target = settleTarget(decision.action);
  await db.transaction(async (tx) => {
    // Same query/insert/update surface as Db; ledger.ts asks for the posting and the state change in one transaction.
    const t = tx as unknown as Db;
    const posted = await t.query.ledgerEntries.findFirst({ where: (l, { eq }) => eq(l.ref, eventId) });
    if (!posted && !SETTLED_STATUSES.has(m.status) && decision.amountMinor > 0) {
      await postTransaction(t, {
        ref: eventId,
        currency: contract.currency,
        entries: releaseEntries({
          milestoneId,
          freelancerId: contract.freelancerId,
          amountMinor: decision.amountMinor,
          ...(advance && owed ? { advance: { partnerId: advance.partnerId, principalMinor: owed.principalMinor, feeMinor: owed.feeMinor } } : {}),
        }),
      });
    }
    await transition(t, milestoneId, target, {
      actor: "paypal",
      event: `milestone.${target}`,
      detail: { eventId, payoutBatchId: item.payoutBatchId ?? null, payoutItemId: item.payoutItemId ?? null, amountMinor: decision.amountMinor },
    });
  });

  await issueReceipt(db, m, contract, decision.amountMinor);
}

async function issueReceipt(
  db: Db,
  m: MilestoneRow,
  contract: { id: string; clientId: string; freelancerId: string; currency: string; title: string },
  amountMinor: number,
): Promise<void> {
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
