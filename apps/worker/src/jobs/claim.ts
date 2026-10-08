import { and, eq, inArray } from "drizzle-orm";
import {
  AUDIT_EVENTS,
  OP_KINDS,
  asInt,
  asNumber,
  asRecord,
  asString,
  audit,
  canTransition,
  hasAudit,
  paypalOps,
  transition,
  type Executor,
  type MilestoneStatus,
  type OpRow,
  type PayoutParty,
} from "@milestone/core";

/*
 * The release claim and what the release and settle jobs both read from paypal_ops: the claim on request.claim, the
 * per-item outcomes and reversals the settle job stores on response.items / response.reversals, and the operator flag.
 */

const PARTIES = ["partner", "freelancer"] as const satisfies readonly PayoutParty[];

// ---------- Advances a payout repays ----------

/** One advance a claim repays, in payment order, with what it still owed when the claim was made. */
export interface ClaimAdvance {
  advanceId: string;
  /** The advance's own milestone (the release milestone itself, or an earlier one whose repayment is carried). */
  milestoneId: string;
  principalMinor: number;
  feeMinor: number;
}

/**
 * Pure. Splits a partner payment across the advances in order: each advance's principal, then its fee, then the next
 * advance. The release job and the settle job both use it, so the claim and the ledger agree.
 */
export function allocateRepayment(amountMinor: number, dues: ReadonlyArray<Pick<ClaimAdvance, "principalMinor" | "feeMinor">>): Array<{ principalMinor: number; feeMinor: number }> {
  let rest = Math.max(0, amountMinor);
  return dues.map((d) => {
    const principalMinor = Math.min(Math.max(0, d.principalMinor), rest);
    rest -= principalMinor;
    const feeMinor = Math.min(Math.max(0, d.feeMinor), rest);
    rest -= feeMinor;
    return { principalMinor, feeMinor };
  });
}

/** Mirrors executeRelease: the partner is repaid first, capped at the released amount; the freelancer gets the rest. */
export function payoutShares(releaseMinor: number, partnerOwedMinor: number): { partnerShareMinor: number; freelancerShareMinor: number } {
  const partnerShareMinor = Math.max(0, Math.min(partnerOwedMinor, releaseMinor));
  return { partnerShareMinor, freelancerShareMinor: releaseMinor - partnerShareMinor };
}

// ---------- The claim ----------

/**
 * What a release job claimed, stored on its paypal_ops rows (request.claim) before any PayPal call. A retry replays the
 * claim exactly; the settle job reads the action, shares, advances and refund from it.
 */
export interface ReleaseClaim {
  deliveryId: string;
  action: "release" | "partial";
  ruleIds: string[];
  reason: string;
  /** Released to the parties (partner + freelancer shares). */
  releaseMinor: number;
  /** Refunded to the client; 0 when there is none. */
  refundMinor: number;
  currency: string;
  captureId: string;
  freelancerEmail: string;
  partnerEmail: string | null;
  shares: { partnerShareMinor: number; freelancerShareMinor: number };
  /** The advances the partner share repays, in order. */
  advances: ClaimAdvance[];
  /** The pg-boss job that holds the claim (its retries keep the id). */
  jobId: string;
  /** When that job took the claim (ISO 8601); the lease runs LEASE_MS from here. */
  claimedAt: string;
}

function parseClaimAdvance(raw: unknown): ClaimAdvance | null {
  const a = asRecord(raw);
  const principalMinor = asInt(a.principalMinor, 0);
  const feeMinor = asInt(a.feeMinor, 0);
  if (typeof a.advanceId !== "string" || typeof a.milestoneId !== "string" || principalMinor === null || feeMinor === null) return null;
  return { advanceId: a.advanceId, milestoneId: a.milestoneId, principalMinor, feeMinor };
}

/** Reads request.claim; null when it is missing or malformed. Malformed advance entries are dropped. */
export function parseClaim(request: unknown): ReleaseClaim | null {
  const r = asRecord(asRecord(request).claim);
  const shares = asRecord(r.shares);
  const releaseMinor = asInt(r.releaseMinor, 0);
  const refundMinor = asInt(r.refundMinor, 0);
  const partnerShareMinor = asInt(shares.partnerShareMinor, 0);
  const freelancerShareMinor = asInt(shares.freelancerShareMinor, 0);
  const jobId = asString(r.jobId);
  const claimedAt = asString(r.claimedAt);
  if (typeof r.deliveryId !== "string" || (r.action !== "release" && r.action !== "partial")) return null;
  if (releaseMinor === null || refundMinor === null || typeof r.currency !== "string" || typeof r.captureId !== "string" || typeof r.freelancerEmail !== "string") return null;
  if (partnerShareMinor === null || freelancerShareMinor === null || !Array.isArray(r.advances) || !jobId || !claimedAt) return null;
  return {
    deliveryId: r.deliveryId,
    action: r.action,
    ruleIds: Array.isArray(r.ruleIds) ? r.ruleIds.filter((x): x is string => typeof x === "string") : [],
    reason: typeof r.reason === "string" ? r.reason : "",
    releaseMinor,
    refundMinor,
    currency: r.currency,
    captureId: r.captureId,
    freelancerEmail: r.freelancerEmail,
    partnerEmail: typeof r.partnerEmail === "string" ? r.partnerEmail : null,
    shares: { partnerShareMinor, freelancerShareMinor },
    advances: r.advances.map(parseClaimAdvance).filter((a): a is ClaimAdvance => a !== null),
    jobId,
    claimedAt,
  };
}

// ---------- Item outcomes and reversals (written by the settle job) ----------

export type ItemStatus = "succeeded" | "failed";

/** One payout item's outcome, stored by the settle job under paypal_ops.response.items[party]. */
export interface ItemOutcome {
  status: ItemStatus;
  amountMinor: number | null;
  eventId: string;
  payoutItemId?: string;
  reason?: string;
}

/** A RETURNED / REVERSED / REFUNDED payout item, stored by the settle job under paypal_ops.response.reversals[party]. */
export interface ItemReversal {
  eventId: string;
  eventType: string;
  amountMinor: number | null;
  payoutItemId?: string;
}

/** Reads one party's stored outcome per party out of response[field], skipping entries `read` rejects. */
function perParty<T>(response: unknown, field: "items" | "reversals", read: (r: Record<string, unknown>) => T | null): Partial<Record<PayoutParty, T>> {
  const byParty = asRecord(asRecord(response)[field]);
  const out: Partial<Record<PayoutParty, T>> = {};
  for (const party of PARTIES) {
    const v = read(asRecord(byParty[party]));
    if (v !== null) out[party] = v;
  }
  return out;
}

const optional = <K extends string>(key: K, v: unknown): Partial<Record<K, string>> => (typeof v === "string" ? ({ [key]: v } as Record<K, string>) : {});

/** Reads the per-item outcomes stored on a payout op's response JSON. */
export function itemOutcomes(response: unknown): Partial<Record<PayoutParty, ItemOutcome>> {
  return perParty(response, "items", (r) =>
    r.status === "succeeded" || r.status === "failed"
      ? { status: r.status, amountMinor: asNumber(r.amountMinor), eventId: typeof r.eventId === "string" ? r.eventId : "", ...optional("payoutItemId", r.payoutItemId), ...optional("reason", r.reason) }
      : null,
  );
}

/** Reads the per-item reversals stored on a payout op's response JSON. */
export function itemReversals(response: unknown): Partial<Record<PayoutParty, ItemReversal>> {
  return perParty(response, "reversals", (r) =>
    typeof r.eventId === "string" && typeof r.eventType === "string"
      ? { eventId: r.eventId, eventType: r.eventType, amountMinor: asNumber(r.amountMinor), ...optional("payoutItemId", r.payoutItemId) }
      : null,
  );
}

// ---------- Operator flag ----------

/** True when the milestone may be moved to held through the ordinary transition table (or already is). */
export function canHold(status: MilestoneStatus): boolean {
  return status === "held" || canTransition(status, "held");
}

/** The shape of a paypal_ops row the gate and the operator summary read. */
export interface OpView {
  kind: string;
  status: string;
  paypalId: string | null;
  request: unknown;
  response?: unknown;
}

/** What an operator needs to know: what was paid, what failed or was reversed, what is still pending, what was refunded. */
export function operatorSummary(claim: ReleaseClaim | null, payout: OpView | undefined, refund: OpView | undefined) {
  const items = itemOutcomes(payout?.response);
  const reversals = itemReversals(payout?.response);
  const share = (p: PayoutParty) => (p === "partner" ? claim?.shares.partnerShareMinor : claim?.shares.freelancerShareMinor) ?? 0;
  const paid: Partial<Record<PayoutParty, number>> = {};
  const failed: Partial<Record<PayoutParty, string>> = {};
  const reversed: Partial<Record<PayoutParty, { eventType: string; amountMinor: number | null }>> = {};
  const pending: PayoutParty[] = [];
  for (const p of PARTIES) {
    const it = items[p];
    if (it?.status === "succeeded") paid[p] = it.amountMinor ?? share(p);
    else if (it?.status === "failed") failed[p] = it.reason ?? "failed";
    else if (share(p) > 0) pending.push(p);
    const rv = reversals[p];
    if (rv) reversed[p] = { eventType: rv.eventType, amountMinor: rv.amountMinor };
  }
  const settledMinor = asNumber(asRecord(asRecord(refund?.response).webhook).amountMinor);
  return {
    deliveryId: claim?.deliveryId ?? null,
    action: claim?.action ?? null,
    currency: claim?.currency ?? null,
    payoutBatchId: payout?.paypalId ?? null,
    payoutOpStatus: payout?.status ?? null,
    paid,
    failed,
    reversed,
    pending,
    refunded: refund ? { claimedMinor: claim?.refundMinor ?? null, opStatus: refund.status, refundId: refund.paypalId, settledMinor } : null,
  };
}

/** This milestone's payout op and refund op (one of each at most: both are keyed by the milestone id). */
export async function releaseOps(q: Executor, milestoneId: string): Promise<{ payout: OpRow | undefined; refund: OpRow | undefined }> {
  const rows = await q.select().from(paypalOps).where(and(eq(paypalOps.key, milestoneId), inArray(paypalOps.kind, [OP_KINDS.payout, OP_KINDS.refund])));
  return { payout: rows.find((r) => r.kind === OP_KINDS.payout), refund: rows.find((r) => r.kind === OP_KINDS.refund) };
}

/**
 * Whether the milestone was ever flagged for an operator. Once flagged, the release and verify jobs never run for it
 * again (CLAUDE.md rule 8), even after the /ops queue marked the case resolved: an operator resolves it by hand.
 */
export function isFlaggedForOperator(q: Executor, milestoneId: string): Promise<boolean> {
  return hasAudit(q, { event: AUDIT_EVENTS.needsOperator, milestoneId });
}

/**
 * Moves the milestone to held (when the transition table allows it) and writes milestone.needs_operator with the
 * current picture of the attempt. Call under the milestone row lock.
 */
export async function flagNeedsOperator(
  q: Executor,
  m: { id: string; contractId: string; status: MilestoneStatus },
  input: { actor: string; reason: string; detail?: Record<string, unknown> },
): Promise<void> {
  if (m.status !== "held" && canHold(m.status)) {
    await transition(q, m.id, "held", { actor: input.actor, event: AUDIT_EVENTS.milestoneHeld, detail: { reason: input.reason } });
  }
  const ops = await releaseOps(q, m.id);
  const claim = parseClaim(ops.payout?.request) ?? parseClaim(ops.refund?.request);
  await audit(q, {
    actor: input.actor,
    event: AUDIT_EVENTS.needsOperator,
    milestoneId: m.id,
    contractId: m.contractId,
    detail: { reason: input.reason, status: m.status, ...input.detail, ...operatorSummary(claim, ops.payout, ops.refund) },
  });
}
