import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { and, eq, inArray, ne } from "drizzle-orm";
import {
  PolicyDecision,
  TRANSITIONS,
  advances as advancesTable,
  audit,
  auditLog,
  contracts as contractsTable,
  criteria as criteriaTable,
  deliveries,
  ledgerEntries,
  milestones,
  paypalOps,
  requestIdFor,
  transition,
  type Db,
  type MilestoneStatus,
} from "@milestone/core";
import { PayPalError, applyReviewWindow, executeRelease, loadAdvanceBalances, openDisputesFor, paypalMode, remainingOwed, type MoneyContext, type ReleasePlan, type ReviewWindowState } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { paypal } from "../lib/paypal.ts";

/*
 * ONE payout attempt per milestone. Once a payout or refund op for a milestone has been claimed (status "sent"), no job
 * ever creates another one: the claiming job (or its pg-boss retry) only finishes the PayPal calls of that claim. If any
 * item of the attempt fails, is blocked, returned, reversed or refunded, the milestone goes to held with an audit
 * "milestone.needs_operator", and the release job refuses to run for that milestone again
 * ("release.refused_needs_operator"). An operator resolves it by hand.
 *
 * The claim records the claiming pg-boss job id and when it was claimed (a lease). Only that job (pg-boss retries keep
 * the id) resumes an op that was claimed but never answered by PayPal; any other job waits until the lease expired
 * (LEASE_MS), then takes the lease over. A payout or refund PayPal rejects outright (a 4xx other than 409 / 429), or
 * one still failing on the job's last retry, is recorded as failed and flagged for an operator.
 */

// ---------- Pure helpers (unit-tested in apps/worker/test) ----------

/** The payout receiver. Simulated PayPal mode (local demo, no sandbox accounts) falls back to the account email. */
function payeeEmail(u: { paypalEmail: string | null; email: string } | undefined): string | null {
  if (!u) return null;
  return u.paypalEmail ?? (paypalMode() === "simulated" ? u.email : null);
}

/** The only states a new release may start from. */
export const RELEASABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["review", "needs_client"]);

/** States in which the claiming job may still finish its own PayPal calls (a retry after a crash or a failed refund call). */
export const RESUMABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["review", "needs_client", "released", "partial_released"]);

export const NEEDS_OPERATOR_EVENT = "milestone.needs_operator";
export const REFUSED_NEEDS_OPERATOR_EVENT = "release.refused_needs_operator";
export const SKIPPED_IN_FLIGHT_EVENT = "release.skipped_in_flight";
/** Written instead of a claim while a PayPal dispute on the milestone is open (dispute.opened, no later dispute.resolved). */
export const BLOCKED_BY_DISPUTE_EVENT = "release.blocked_by_dispute";

/** How long a claim belongs to the job that made it before another job may resume its unanswered PayPal calls. */
export const LEASE_MS = 120_000;

/** enqueue() in @milestone/core sends every job with retryLimit 5; used when the job carries no retryLimit metadata. */
export const DEFAULT_RETRY_LIMIT = 5;

/** Client responses that count as approval before the review window closes. */
const EARLY_APPROVALS = new Set(["approve", "confirm_partial"]);
/** Client responses that stop the release. */
const STOPS = new Set(["veto", "hold"]);

/** Builds the review-window input for applyReviewWindow from the milestone row. A missing reviewEndsAt means no window has closed. */
export function reviewWindowState(
  decision: PolicyDecision,
  m: { clientResponse: string | null; reviewEndsAt: Date | null },
  now: Date,
): ReviewWindowState {
  return {
    decision,
    vetoed: m.clientResponse === "veto",
    approvedEarly: m.clientResponse !== null && EARLY_APPROVALS.has(m.clientResponse),
    windowExpired: m.reviewEndsAt !== null && m.reviewEndsAt.getTime() <= now.getTime(),
  };
}

/** Reads the stored milestone decision; null when it is missing or malformed. */
export function parseDecision(raw: unknown): PolicyDecision | null {
  const parsed = PolicyDecision.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The delivery a stored decision was made for (written by the verify job); null for a legacy decision without one. */
export function decisionDeliveryId(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as Record<string, unknown>).deliveryId;
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * Why a release job must not start a new release, or null when it may. A job is stale when it was queued for another
 * delivery than the one the current decision belongs to, or when the milestone has left review / needs_client.
 */
export function staleReason(input: { jobDeliveryId: string | null; decisionDeliveryId: string | null; status: MilestoneStatus }): string | null {
  if (!input.jobDeliveryId) return "release job has no deliveryId";
  if (input.decisionDeliveryId !== input.jobDeliveryId) {
    return `job was queued for delivery ${input.jobDeliveryId} but the current decision belongs to ${input.decisionDeliveryId ?? "no delivery"}`;
  }
  if (!RELEASABLE_STATUSES.has(input.status)) return `milestone is ${input.status}`;
  return null;
}

/**
 * What the release job should do now, from the stored decision and the client's answer.
 * - veto / hold always wins (the review route refuses them once a payout has started).
 * - needs_client waits for the client: approve on an ask_client releases the full amount, confirm_partial releases
 *   the proposed share (an ask_client proposes 0, i.e. a full refund).
 * - review follows applyReviewWindow (released when the window closed or the client approved early).
 */
export function clientOutcome(
  stored: PolicyDecision,
  m: { status: MilestoneStatus; clientResponse: string | null; reviewEndsAt: Date | null; amountMinor: number },
  now: Date,
): PolicyDecision {
  if (m.clientResponse !== null && STOPS.has(m.clientResponse)) {
    return { action: "hold", amountMinor: 0, ruleIds: [...stored.ruleIds, `CL-${m.clientResponse}`], reason: `Client chose ${m.clientResponse}.` };
  }
  if (m.status === "needs_client") {
    if (m.clientResponse === "approve" && stored.action === "ask_client") {
      return { action: "release", amountMinor: m.amountMinor, ruleIds: [...stored.ruleIds, "CL-approve"], reason: "Client approved the full amount." };
    }
    if (m.clientResponse === "confirm_partial" && (stored.action === "partial" || stored.action === "ask_client")) {
      return { action: "partial", amountMinor: Math.min(stored.amountMinor, m.amountMinor), ruleIds: [...stored.ruleIds, "CL-partial"], reason: `Client confirmed the partial release. ${stored.reason}` };
    }
    return { action: "ask_client", amountMinor: 0, ruleIds: stored.ruleIds, reason: "Waiting for the client's answer." };
  }
  return applyReviewWindow(reviewWindowState(stored, m, now));
}

/** Required criteria whose verdict is not a pass (a criterion missing from the verdict counts as not passed). Returns their descriptions. */
export function requiredNotPassed(verdict: unknown, criteria: ReadonlyArray<{ id: string; required: boolean; description: string }>): string[] {
  const rows = verdict && typeof verdict === "object" ? (verdict as { criteria?: unknown }).criteria : undefined;
  const status = new Map<string, unknown>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      if (r && typeof r === "object") status.set(String((r as Record<string, unknown>).criterion_id), (r as Record<string, unknown>).status);
    }
  }
  return criteria.filter((c) => c.required && status.get(c.id) !== "pass").map((c) => c.description);
}

export interface AdvanceRow {
  principalMinor: number;
  feeBpsPerDay: number;
  offer: Record<string, unknown>;
  fundedAt: Date | null;
}

const DAY_MS = 86_400_000;

/**
 * What the partner is owed out of the release. The fee is the offer's quoted expectedFeeMinor; if the offer has none,
 * it is accrued from fundedAt to the decision time. Both inputs are fixed once the decision is made, so the release
 * job (payout amount) and the settle job (ledger entries) always compute the same number.
 */
export function advanceRepayment(a: AdvanceRow, decidedAt: Date | null): { principalMinor: number; feeMinor: number } {
  const quoted = a.offer.expectedFeeMinor;
  if (typeof quoted === "number" && Number.isInteger(quoted) && quoted >= 0) return { principalMinor: a.principalMinor, feeMinor: quoted };
  const days = a.fundedAt && decidedAt ? Math.max(1, Math.ceil((decidedAt.getTime() - a.fundedAt.getTime()) / DAY_MS)) : 1;
  return { principalMinor: a.principalMinor, feeMinor: Math.floor((a.principalMinor * a.feeBpsPerDay * days) / 10_000) };
}

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

/** True when the milestone may be moved to held through the transition table (or already is). */
export function canHold(status: MilestoneStatus): boolean {
  return status === "held" || TRANSITIONS[status].includes("held");
}

export type PayoutParty = "partner" | "freelancer";
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

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reads the per-item outcomes stored on a payout op's response JSON. */
export function itemOutcomes(response: unknown): Partial<Record<PayoutParty, ItemOutcome>> {
  const items = obj(obj(response).items);
  const out: Partial<Record<PayoutParty, ItemOutcome>> = {};
  for (const party of ["partner", "freelancer"] as const) {
    const r = obj(items[party]);
    if (r.status !== "succeeded" && r.status !== "failed") continue;
    out[party] = {
      status: r.status,
      amountMinor: typeof r.amountMinor === "number" ? r.amountMinor : null,
      eventId: typeof r.eventId === "string" ? r.eventId : "",
      ...(typeof r.payoutItemId === "string" ? { payoutItemId: r.payoutItemId } : {}),
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    };
  }
  return out;
}

/** Reads the per-item reversals stored on a payout op's response JSON. */
export function itemReversals(response: unknown): Partial<Record<PayoutParty, ItemReversal>> {
  const rev = obj(obj(response).reversals);
  const out: Partial<Record<PayoutParty, ItemReversal>> = {};
  for (const party of ["partner", "freelancer"] as const) {
    const r = obj(rev[party]);
    if (typeof r.eventId !== "string" || typeof r.eventType !== "string") continue;
    out[party] = {
      eventId: r.eventId,
      eventType: r.eventType,
      amountMinor: typeof r.amountMinor === "number" ? r.amountMinor : null,
      ...(typeof r.payoutItemId === "string" ? { payoutItemId: r.payoutItemId } : {}),
    };
  }
  return out;
}

/**
 * What a release job claimed, stored on its paypal_ops rows (request.claim) before any PayPal call. A retry replays the
 * claim exactly; the settle job reads the action, shares and refund from it.
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
  /** The advances the partner share repays, in order (missing on claims written before carry-over). */
  advances?: ClaimAdvance[];
  /** The pg-boss job that holds the claim (its retries keep the id). Missing on claims written before leases. */
  jobId?: string;
  /** When that job took the claim (ISO 8601); the lease runs LEASE_MS from here. */
  claimedAt?: string;
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function parseClaimAdvances(v: unknown): ClaimAdvance[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: ClaimAdvance[] = [];
  for (const raw of v) {
    const a = obj(raw);
    if (typeof a.advanceId !== "string" || typeof a.milestoneId !== "string" || !isInt(a.principalMinor) || !isInt(a.feeMinor)) continue;
    out.push({ advanceId: a.advanceId, milestoneId: a.milestoneId, principalMinor: a.principalMinor, feeMinor: a.feeMinor });
  }
  return out;
}

/** Reads request.claim; a legacy "attempt" field on older claims is ignored. */
export function parseClaim(request: unknown): ReleaseClaim | null {
  const r = obj(obj(request).claim);
  const shares = obj(r.shares);
  if (typeof r.deliveryId !== "string" || (r.action !== "release" && r.action !== "partial")) return null;
  if (!isInt(r.releaseMinor) || !isInt(r.refundMinor) || typeof r.currency !== "string" || typeof r.captureId !== "string" || typeof r.freelancerEmail !== "string") return null;
  if (!isInt(shares.partnerShareMinor) || !isInt(shares.freelancerShareMinor)) return null;
  return {
    deliveryId: r.deliveryId,
    action: r.action,
    ruleIds: Array.isArray(r.ruleIds) ? r.ruleIds.filter((x): x is string => typeof x === "string") : [],
    reason: typeof r.reason === "string" ? r.reason : "",
    releaseMinor: r.releaseMinor,
    refundMinor: r.refundMinor,
    currency: r.currency,
    captureId: r.captureId,
    freelancerEmail: r.freelancerEmail,
    partnerEmail: typeof r.partnerEmail === "string" ? r.partnerEmail : null,
    shares: { partnerShareMinor: shares.partnerShareMinor, freelancerShareMinor: shares.freelancerShareMinor },
    ...(Array.isArray(r.advances) ? { advances: parseClaimAdvances(r.advances)! } : {}),
    ...(typeof r.jobId === "string" && r.jobId ? { jobId: r.jobId } : {}),
    ...(typeof r.claimedAt === "string" && r.claimedAt ? { claimedAt: r.claimedAt } : {}),
  };
}

/**
 * Who may resume a claim's unanswered PayPal calls: "own" for the claiming job, "expired" once LEASE_MS has passed
 * since claimedAt (or for a claim written before leases), "held" while another job's lease is live.
 */
export function leaseState(claim: Pick<ReleaseClaim, "jobId" | "claimedAt">, jobId: string | null, now: Date, leaseMs = LEASE_MS): "own" | "expired" | "held" {
  if (claim.jobId && jobId && claim.jobId === jobId) return "own";
  if (!claim.jobId || !claim.claimedAt) return "expired";
  const at = Date.parse(claim.claimedAt);
  if (!Number.isFinite(at)) return "expired";
  return now.getTime() - at >= leaseMs ? "expired" : "held";
}

/** True on the job's last pg-boss attempt (retryCount counts retries; retryLimit falls back to enqueue's default). */
export function isLastAttempt(job: { retryCount?: unknown; retryLimit?: unknown }, defaultLimit = DEFAULT_RETRY_LIMIT): boolean {
  const count = typeof job.retryCount === "number" ? job.retryCount : 0;
  const limit = typeof job.retryLimit === "number" ? job.retryLimit : defaultLimit;
  return count >= limit;
}

/**
 * Whether a failed PayPal call is final. "rejected": PayPal answered with a 4xx other than 409 (in progress / conflict)
 * or 429 (rate limited), so the request was refused and retrying it cannot succeed. "last_attempt": any other error on
 * the job's last retry. null: throw, and pg-boss retries with the same PayPal-Request-Id.
 */
export function paypalFailure(err: unknown, lastAttempt: boolean): "rejected" | "last_attempt" | null {
  // 401/403 are our credentials or config, not PayPal rejecting this payout: retry, do not flag the milestone for good.
  if (err instanceof PayPalError && err.status >= 400 && err.status < 500 && ![401, 403, 409, 429].includes(err.status)) return "rejected";
  return lastAttempt ? "last_attempt" : null;
}

/** The payout half of a claim as an executeRelease plan (no refund: the payout result is recorded before the refund call). */
export function payoutPlan(milestoneId: string, c: ReleaseClaim): ReleasePlan {
  const releaseMinor = c.shares.partnerShareMinor + c.shares.freelancerShareMinor;
  return {
    milestoneId,
    currency: c.currency,
    captureId: c.captureId,
    freelancerEmail: c.freelancerEmail,
    decision: { action: c.action, amountMinor: releaseMinor, ruleIds: c.ruleIds, reason: c.reason },
    milestoneAmountMinor: releaseMinor,
    ...(c.shares.partnerShareMinor > 0 && c.partnerEmail ? { partner: { email: c.partnerEmail, amountMinor: c.shares.partnerShareMinor } } : {}),
  };
}

/** The refund half of a claim as an executeRelease plan (no payout items). */
export function refundPlan(milestoneId: string, c: ReleaseClaim): ReleasePlan {
  return {
    milestoneId,
    currency: c.currency,
    captureId: c.captureId,
    freelancerEmail: c.freelancerEmail,
    decision: { action: "partial", amountMinor: 0, ruleIds: c.ruleIds, reason: c.reason },
    milestoneAmountMinor: c.refundMinor,
  };
}

/** The shape of a paypal_ops row the gate and the operator summary read. */
export interface OpView {
  kind: string;
  status: string;
  paypalId: string | null;
  request: unknown;
  response?: unknown;
}

export type ReleaseGate =
  | { kind: "new" }
  | { kind: "resume"; claim: ReleaseClaim; takeover: boolean }
  | { kind: "skip"; reason: string }
  | { kind: "in_flight"; reason: string; claim: ReleaseClaim }
  | { kind: "refuse"; reason: string };

/**
 * The one-attempt rule. "new" only when no payout or refund op was ever claimed for the milestone; "resume" only for the
 * job of the claimed delivery while one of its ops was claimed but never answered by PayPal, and only by the claiming
 * job or after its lease expired ("in_flight" otherwise, audited as release.skipped_in_flight); "refuse" (audited as
 * release.refused_needs_operator) once the milestone needs an operator or for any new decision after an op was sent.
 */
export function releaseGate(input: {
  jobDeliveryId: string | null;
  decisionDeliveryId: string | null;
  status: MilestoneStatus;
  needsOperator: boolean;
  ops: readonly OpView[];
  jobId: string | null;
  now: Date;
}): ReleaseGate {
  if (input.needsOperator) return { kind: "refuse", reason: "the milestone needs an operator; the release job never runs for it again" };
  const claimed = input.ops.filter((o) => o.status !== "pending");
  if (claimed.length === 0) {
    const stale = staleReason(input);
    return stale ? { kind: "skip", reason: stale } : { kind: "new" };
  }
  const claim = claimed.map((o) => parseClaim(o.request)).find((c): c is ReleaseClaim => c !== null) ?? null;
  if (claim && claim.deliveryId === input.jobDeliveryId) {
    if (input.decisionDeliveryId !== input.jobDeliveryId) return { kind: "skip", reason: "the claimed release belongs to an older decision" };
    const unanswered = claimed.filter((o) => o.status === "sent" && !o.paypalId);
    if (unanswered.length === 0) return { kind: "skip", reason: "this release was already sent to PayPal" };
    if (!RESUMABLE_STATUSES.has(input.status)) return { kind: "refuse", reason: `the claimed release cannot resume while the milestone is ${input.status}` };
    const held = unanswered.map((o) => parseClaim(o.request)).find((c): c is ReleaseClaim => c !== null && c.deliveryId === claim.deliveryId) ?? claim;
    const lease = leaseState(held, input.jobId, input.now);
    if (lease === "held") return { kind: "in_flight", reason: `job ${held.jobId} claimed this release at ${held.claimedAt} and its lease has not expired`, claim: held };
    return { kind: "resume", claim: held, takeover: lease === "expired" };
  }
  if (!input.jobDeliveryId || input.decisionDeliveryId !== input.jobDeliveryId) return { kind: "skip", reason: staleReason(input) ?? "stale job" };
  const kinds = [...new Set(claimed.map((o) => o.kind))].join(" and ");
  return { kind: "refuse", reason: `a ${kinds} was already sent for this milestone (delivery ${claim?.deliveryId ?? "unknown"}); one attempt per milestone` };
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
  for (const p of ["partner", "freelancer"] as const) {
    const it = items[p];
    if (it?.status === "succeeded") paid[p] = it.amountMinor ?? share(p);
    else if (it?.status === "failed") failed[p] = it.reason ?? "failed";
    else if (share(p) > 0) pending.push(p);
    const rv = reversals[p];
    if (rv) reversed[p] = { eventType: rv.eventType, amountMinor: rv.amountMinor };
  }
  const settled = obj(obj(refund?.response).webhook);
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
    refunded: refund
      ? { claimedMinor: claim?.refundMinor ?? null, opStatus: refund.status, refundId: refund.paypalId, settledMinor: typeof settled.amountMinor === "number" ? settled.amountMinor : null }
      : null,
  };
}

// ---------- DB helpers ----------

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Tx;
export type OpRow = typeof paypalOps.$inferSelect;

/** This milestone's payout op and refund op (one of each at most: both are keyed by the milestone id). */
export async function releaseOps(q: Q, milestoneId: string): Promise<{ payout: OpRow | undefined; refund: OpRow | undefined }> {
  const rows = await q.select().from(paypalOps).where(and(eq(paypalOps.key, milestoneId), inArray(paypalOps.kind, ["payout", "refund"])));
  return { payout: rows.find((r) => r.kind === "payout"), refund: rows.find((r) => r.kind === "refund") };
}

/** Whether the milestone was ever flagged for an operator. Once flagged, the release job never runs for it again. */
export async function isFlaggedForOperator(q: Q, milestoneId: string): Promise<boolean> {
  const [row] = await q.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.milestoneId, milestoneId), eq(auditLog.event, NEEDS_OPERATOR_EVENT))).limit(1);
  return row !== undefined;
}

/**
 * Moves the milestone to held (when the transition table allows it) and writes milestone.needs_operator with the
 * current picture of the attempt. Call under the milestone row lock.
 */
export async function flagNeedsOperator(
  q: Db,
  m: { id: string; contractId: string; status: MilestoneStatus },
  input: { actor: string; reason: string; detail?: Record<string, unknown> },
): Promise<void> {
  if (m.status !== "held" && canHold(m.status)) {
    await transition(q, m.id, "held", { actor: input.actor, event: "milestone.held", detail: { reason: input.reason } });
  }
  const ops = await releaseOps(q, m.id);
  const claim = parseClaim(ops.payout?.request) ?? parseClaim(ops.refund?.request);
  await audit(q, {
    actor: input.actor,
    event: NEEDS_OPERATOR_EVENT,
    milestoneId: m.id,
    contractId: m.contractId,
    detail: { reason: input.reason, status: m.status, ...input.detail, ...operatorSummary(claim, ops.payout, ops.refund) },
  });
}

/** Claims a paypal_ops row for this release: creates it as "sent", or moves a never-sent "pending" row to "sent". */
async function claimOp(tx: Tx, kind: "payout" | "refund", key: string, claim: ReleaseClaim): Promise<void> {
  const now = new Date();
  await tx
    .insert(paypalOps)
    .values({ id: randomUUID(), kind, key, requestId: randomUUID(), status: "sent", request: { claim }, updatedAt: now })
    .onConflictDoUpdate({ target: [paypalOps.kind, paypalOps.key], set: { status: "sent", request: { claim }, updatedAt: now }, setWhere: eq(paypalOps.status, "pending") });
  const [row] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key)));
  if (row?.status !== "sent" || parseClaim(row.request)?.deliveryId !== claim.deliveryId) throw new Error(`could not claim ${kind} op ${key}`);
}

/**
 * Stores PayPal's answer. The PayPal id is always written (R8), whatever the op's status; the status only moves while the
 * op is still sent; per-item outcomes and reversals the settle job may already have written are kept.
 */
async function recordResponse(db: Db, kind: string, key: string, set: { paypalId?: string; status?: "failed" | "succeeded"; response: unknown }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key))).for("update");
    if (!row) return;
    const prev = obj(row.response);
    const response = { ...obj(set.response), ...(prev.items ? { items: prev.items } : {}), ...(prev.reversals ? { reversals: prev.reversals } : {}), ...(prev.webhook ? { webhook: prev.webhook } : {}) };
    const status = set.status && (row.status === "sent" || row.status === "pending") ? set.status : row.status;
    await tx
      .update(paypalOps)
      .set({ ...(set.paypalId ? { paypalId: set.paypalId } : {}), status, response, updatedAt: new Date() })
      .where(eq(paypalOps.id, row.id));
  });
}

/** Locks the milestone and flags it for an operator (release job side: a DENIED batch or a FAILED refund). */
async function flagFromJob(db: Db, milestoneId: string, reason: string, detail: Record<string, unknown>): Promise<void> {
  await db.transaction(async (tx) => {
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!m) throw new Error(`milestone ${milestoneId} not found`);
    await flagNeedsOperator(tx as unknown as Db, m, { actor: "paypal", reason, detail });
  });
}

// ---------- Job ----------

/** paypal_ops kind of an advance's funding payout (ADVANCE_OP_KIND in ./advance.ts, which imports this module). */
const ADVANCE_PAYOUT_KIND = "advance-payout";
type MilestoneRow = typeof milestones.$inferSelect;
type AdvanceDbRow = typeof advancesTable.$inferSelect;

type Owed =
  | { kind: "ok"; partnerId: string | null; dues: ClaimAdvance[]; blocked: Array<{ advanceId: string; partnerId: string; currency: string; remainingMinor: number }> }
  | { kind: "operator"; reason: string; detail: Record<string, unknown> };

/**
 * Everything the freelancer still owes capital partners, as of this claim (carried advances are row-locked, so two
 * claims serialize on them):
 *  - this milestone's own advance (funded or shortfall);
 *  - the freelancer's advances on OTHER milestones in a final state: shortfall, or funded where that milestone is
 *    released / partial_released, or held after a full refund (nothing was ever repaid out of it).
 * Each balance comes from the ledger (advance:<id> debit minus the repayment credits booked for it) plus the unpaid part
 * of its fee, minus what another payout claim still in flight is about to repay. One payout can repay one partner in
 * one currency: the dues are the ones of the own advance's partner (else the oldest carried one's); anything owed to
 * another partner or in another currency comes back as `blocked`. "operator" when the state cannot be trusted.
 */
async function owedAdvances(tx: Tx, m: MilestoneRow, freelancerId: string, currency: string): Promise<Owed> {
  const t = tx as unknown as Db;
  // The own advance is serialized by the milestone lock (the advance job and settle take it too); not locked again here,
  // since the advance job locks the advance before the milestone.
  const own = await tx.select().from(advancesTable).where(eq(advancesTable.milestoneId, m.id)).orderBy(advancesTable.id);
  for (const a of own.filter((x) => x.status === "offered")) {
    // An accepted advance whose payout was claimed but never confirmed: PayPal may have paid it, a person decides.
    const [op] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, ADVANCE_PAYOUT_KIND), eq(paypalOps.key, a.id)));
    const rejected = op?.status === "failed" && obj(obj(op.response).error).final === "rejected";
    if (op && !rejected) return { kind: "operator", reason: "an advance payout for this milestone was sent but never confirmed; PayPal may have paid it", detail: { advanceId: a.id, advanceOpStatus: op.status } };
  }

  const candidates = await tx
    .select({ id: advancesTable.id, milestoneStatus: milestones.status, milestoneAmountMinor: milestones.amountMinor, decidedAt: milestones.decidedAt, currency: contractsTable.currency })
    .from(advancesTable)
    .innerJoin(milestones, eq(milestones.id, advancesTable.milestoneId))
    .innerJoin(contractsTable, eq(contractsTable.id, milestones.contractId))
    .where(and(eq(contractsTable.freelancerId, freelancerId), ne(advancesTable.milestoneId, m.id), inArray(advancesTable.status, ["funded", "shortfall"])));
  const info = new Map(candidates.map((c) => [c.id, c]));
  const locked = candidates.length > 0 ? await tx.select().from(advancesTable).where(inArray(advancesTable.id, [...info.keys()])).orderBy(advancesTable.id).for("update") : [];
  const heldIds = candidates.filter((c) => c.milestoneStatus === "held").map((c) => `refund:${locked.find((a) => a.id === c.id)?.milestoneId ?? ""}`);
  const refunds = heldIds.length > 0 ? await tx.select({ ref: ledgerEntries.ref, amountMinor: ledgerEntries.amountMinor }).from(ledgerEntries).where(and(inArray(ledgerEntries.ref, heldIds), eq(ledgerEntries.direction, "debit"))) : [];
  const refunded = (milestoneId: string) => refunds.filter((r) => r.ref === `refund:${milestoneId}`).reduce((sum, r) => sum + r.amountMinor, 0);
  const carried = locked
    .filter((a) => {
      const c = info.get(a.id);
      if (!c) return false;
      if (a.status === "shortfall") return true;
      if (a.status !== "funded") return false;
      if (c.milestoneStatus === "released" || c.milestoneStatus === "partial_released") return true;
      return c.milestoneStatus === "held" && refunded(a.milestoneId) >= c.milestoneAmountMinor;
    })
    .sort((x, y) => (x.fundedAt?.getTime() ?? 0) - (y.fundedAt?.getTime() ?? 0) || x.id.localeCompare(y.id));

  const open: Array<{ a: AdvanceDbRow; decidedAt: Date | null; currency: string }> = [
    ...own.filter((a) => a.status === "funded" || a.status === "shortfall").map((a) => ({ a, decidedAt: m.decidedAt, currency })),
    ...carried.map((a) => ({ a, decidedAt: info.get(a.id)!.decidedAt, currency: info.get(a.id)!.currency })),
  ];
  if (open.length === 0) return { kind: "ok", partnerId: null, dues: [], blocked: [] };

  // Repayments another payout claim has sent but whose partner item has not settled yet (not in the ledger yet).
  const inFlight = new Map<string, number>();
  const sentOps = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, "payout"), eq(paypalOps.status, "sent"), ne(paypalOps.key, m.id)));
  for (const op of sentOps) {
    if (itemOutcomes(op.response).partner) continue;
    const c = parseClaim(op.request);
    if (!c?.advances?.length) continue;
    allocateRepayment(c.shares.partnerShareMinor, c.advances).forEach((x, i) => {
      const id = c.advances![i]!.advanceId;
      inFlight.set(id, (inFlight.get(id) ?? 0) + x.principalMinor + x.feeMinor);
    });
  }

  const balances = await loadAdvanceBalances(t, open.map(({ a }) => ({ id: a.id, milestoneId: a.milestoneId, partnerId: a.partnerId })));
  const remaining: Array<{ due: ClaimAdvance; partnerId: string; currency: string }> = [];
  for (const { a, decidedAt, currency: cur } of open) {
    const bal = balances.get(a.id);
    if (!bal || bal.fundedMinor <= 0) return { kind: "operator", reason: `advance ${a.id} is ${a.status} but its funding is not in the ledger`, detail: { advanceId: a.id } };
    const r = remainingOwed(bal, advanceRepayment(a, decidedAt).feeMinor);
    const pending = inFlight.get(a.id) ?? 0;
    const p = Math.min(r.principalMinor, pending);
    const due = { principalMinor: r.principalMinor - p, feeMinor: Math.max(0, r.feeMinor - (pending - p)) };
    if (due.principalMinor + due.feeMinor > 0) remaining.push({ due: { advanceId: a.id, milestoneId: a.milestoneId, ...due }, partnerId: a.partnerId, currency: cur });
  }
  const partnerId = remaining[0]?.partnerId ?? null;
  const mine = remaining.filter((r) => r.partnerId === partnerId && r.currency === currency);
  const blocked = remaining
    .filter((r) => !mine.includes(r))
    .map((r) => ({ advanceId: r.due.advanceId, partnerId: r.partnerId, currency: r.currency, remainingMinor: r.due.principalMinor + r.due.feeMinor }));
  return { kind: "ok", partnerId: mine.length > 0 ? partnerId : null, dues: mine.map((r) => r.due), blocked };
}

interface Claimed {
  claim: ReleaseClaim;
  contractId: string;
}

/**
 * Locks the milestone, applies the one-attempt gate, checks the job is still current and the client has not stopped it,
 * and claims the paypal_ops rows (status "sent") in the same transaction. The review route takes the same lock and
 * refuses veto / hold once a claimed op exists, so a veto either lands before the claim (and this job skips) or is refused.
 */
async function claimRelease(db: Db, milestoneId: string, jobDeliveryId: string | null, jobId: string | null, now: Date): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!m) throw new Error(`milestone ${milestoneId} not found`);
    const note = async (event: string, reason: string, extra: Record<string, unknown> = {}) => {
      await audit(t, { actor: "system", event, milestoneId, contractId: m.contractId, detail: { reason, jobDeliveryId, status: m.status, ...extra } });
      return null;
    };
    const skip = (reason: string, extra: Record<string, unknown> = {}) => note("release.skipped", reason, extra);
    const decId = decisionDeliveryId(m.decision);
    const ops = await releaseOps(tx, milestoneId);
    const opList = [ops.payout, ops.refund].filter((o): o is OpRow => o !== undefined);

    const gate = releaseGate({ jobDeliveryId, decisionDeliveryId: decId, status: m.status, needsOperator: await isFlaggedForOperator(tx, milestoneId), ops: opList, jobId, now });
    if (gate.kind === "refuse") return note(REFUSED_NEEDS_OPERATOR_EVENT, gate.reason, { ops: opList.map((o) => ({ kind: o.kind, status: o.status, paypalId: o.paypalId })) });
    if (gate.kind === "skip") return skip(gate.reason);
    if (gate.kind === "in_flight") return note(SKIPPED_IN_FLIGHT_EVENT, gate.reason, { jobId, claimJobId: gate.claim.jobId ?? null, claimedAt: gate.claim.claimedAt ?? null });
    if (gate.kind === "resume") {
      if (!gate.takeover) return { claim: gate.claim, contractId: m.contractId };
      // The claiming job's lease expired: this job takes the claim over (same ops, same PayPal-Request-Ids).
      const claim: ReleaseClaim = { ...gate.claim, ...(jobId ? { jobId } : {}), claimedAt: now.toISOString() };
      for (const op of opList) {
        if (op.status === "sent" && !op.paypalId && parseClaim(op.request)?.deliveryId === claim.deliveryId) {
          await tx.update(paypalOps).set({ request: { ...obj(op.request), claim }, updatedAt: now }).where(and(eq(paypalOps.id, op.id), eq(paypalOps.status, "sent")));
        }
      }
      await note("release.lease_taken_over", "the claiming job's lease expired", { jobId, previousJobId: gate.claim.jobId ?? null, previousClaimedAt: gate.claim.claimedAt ?? null });
      return { claim, contractId: m.contractId };
    }

    // Dispute guard: while the buyer's PayPal dispute is open, nothing is claimed. Paying out now could pay the money
    // twice (PayPal refunds the buyer if the claim is accepted or lost). A milestone in review is held; it waits for an
    // operator, as any held milestone does.
    const disputes = await openDisputesFor(t, milestoneId);
    if (disputes.length > 0) {
      if (m.status === "review") await transition(t, milestoneId, "held", { actor: "system", event: "milestone.held", detail: { reason: "a PayPal dispute on this milestone is open", disputeIds: disputes } });
      return note(BLOCKED_BY_DISPUTE_EVENT, "a PayPal dispute on this milestone is open", { disputeIds: disputes });
    }

    const stored = parseDecision(m.decision);
    if (!stored) return skip("milestone has no policy decision");
    const outcome = clientOutcome(stored, m, now);
    if (outcome.action === "hold") {
      await transition(t, milestoneId, "held", { actor: "policy", event: "milestone.held", detail: { reason: outcome.reason, ruleIds: outcome.ruleIds, deliveryId: jobDeliveryId } });
      return null;
    }
    if (outcome.action === "ask_client") {
      await audit(t, { actor: "policy", event: "release.waiting", milestoneId, contractId: m.contractId, detail: { reason: outcome.reason, ruleIds: outcome.ruleIds, deliveryId: jobDeliveryId } });
      return null;
    }
    if (m.status === "needs_client" && decId) {
      // F9: the client cannot approve past a required criterion that did not pass.
      const delivery = await tx.query.deliveries.findFirst({ where: eq(deliveries.id, decId) });
      const rows = await tx.query.criteria.findMany({ where: eq(criteriaTable.milestoneId, milestoneId) });
      const blocked = requiredNotPassed(delivery?.verdict, rows);
      if (blocked.length > 0) return skip("required criteria did not pass", { criteria: blocked });
    }

    const contract = await tx.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
    if (!contract) throw new Error(`contract ${m.contractId} not found`);
    const freelancer = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) });
    const freelancerEmail = payeeEmail(freelancer);
    if (!freelancerEmail) throw new Error(`freelancer ${contract.freelancerId} has no PayPal email`);
    if (!m.paypalCaptureId) throw new Error(`milestone ${milestoneId} has no PayPal capture id`);

    // The partner is repaid first: this milestone's advance and any balance carried from the freelancer's earlier ones.
    const owed = await owedAdvances(tx, m, contract.freelancerId, contract.currency);
    if (owed.kind === "operator") {
      await flagNeedsOperator(t, m, { actor: "system", reason: owed.reason, detail: { ...owed.detail, deliveryId: jobDeliveryId } });
      return null;
    }
    const owedMinor = owed.dues.reduce((sum, d) => sum + d.principalMinor + d.feeMinor, 0);
    let partnerEmail: string | null = null;
    if (owedMinor > 0 && owed.partnerId) {
      const p = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, owed.partnerId!) });
      partnerEmail = payeeEmail(p);
      if (!partnerEmail) {
        await flagNeedsOperator(t, m, { actor: "system", reason: `capital partner ${owed.partnerId} has no PayPal email; the advance cannot be repaid`, detail: { partnerId: owed.partnerId, owedMinor, deliveryId: jobDeliveryId } });
        return null;
      }
    }

    const shares = payoutShares(outcome.amountMinor, owedMinor);
    if (owed.blocked.length > 0 && shares.freelancerShareMinor > 0) {
      // The freelancer is never paid while any balance is unpaid, and one payout can repay only one partner.
      await flagNeedsOperator(t, m, { actor: "system", reason: "the freelancer still owes advance balances that this payout cannot repay (another capital partner or currency)", detail: { blocked: owed.blocked, deliveryId: jobDeliveryId } });
      return null;
    }
    const allocation = allocateRepayment(shares.partnerShareMinor, owed.dues);
    const repaid = owed.dues.filter((_, i) => allocation[i]!.principalMinor + allocation[i]!.feeMinor > 0);
    const releaseMinor = shares.partnerShareMinor + shares.freelancerShareMinor;
    const refundMinor = Math.max(0, m.amountMinor - outcome.amountMinor);
    if (releaseMinor === 0 && refundMinor === 0) return skip("nothing to pay or refund");

    const claim: ReleaseClaim = {
      deliveryId: jobDeliveryId!,
      action: outcome.action === "partial" ? "partial" : "release",
      ruleIds: outcome.ruleIds,
      reason: outcome.reason,
      releaseMinor,
      refundMinor,
      currency: contract.currency,
      captureId: m.paypalCaptureId,
      freelancerEmail,
      partnerEmail,
      shares,
      advances: repaid,
      ...(jobId ? { jobId } : {}),
      claimedAt: now.toISOString(),
    };
    // Both ops are claimed before any PayPal call, so a retry of this job can finish either and nothing else can start one.
    if (releaseMinor > 0) await claimOp(tx, "payout", milestoneId, claim);
    if (refundMinor > 0) await claimOp(tx, "refund", milestoneId, claim);
    await audit(t, { actor: "policy", event: "release.claimed", milestoneId, contractId: m.contractId, detail: { ...claim } });
    return { claim, contractId: m.contractId };
  });
}

/** True when this op belongs to the claim and was claimed but never answered by PayPal. */
function unsent(op: OpRow | undefined, claim: ReleaseClaim): op is OpRow {
  return op?.status === "sent" && !op.paypalId && parseClaim(op.request)?.deliveryId === claim.deliveryId;
}

/**
 * Runs when the review window closes, or right away on early approval / client confirmation of a partial.
 * Sends the payout (and the refund of an unverified share) but never marks the milestone released:
 * the settle job does that when PayPal's webhook confirms the payout (CLAUDE.md rule 7).
 * A throw makes pg-boss retry this same job (same job id, so it keeps the lease), which resumes the same claim with the
 * same PayPal-Request-Id; nothing else ever re-enqueues a release. A call PayPal rejected outright, or one still failing
 * on the last retry, is recorded as failed and flagged for an operator instead of thrown.
 * `clock` exists for tests; production uses the wall clock.
 */
export async function release(job: Job<JobData>, clock: () => Date = () => new Date()): Promise<void> {
  const db = getDb();
  const milestoneId = job.data.milestoneId;
  const jobDeliveryId = typeof job.data.deliveryId === "string" && job.data.deliveryId ? job.data.deliveryId : null;
  const jobId = typeof job.id === "string" && job.id ? job.id : null;

  const claimed = await claimRelease(db, milestoneId, jobDeliveryId, jobId, clock());
  if (!claimed) return;
  const { claim, contractId } = claimed;
  const ctx: MoneyContext = { client: paypal(), requestIdFor: (kind, key) => requestIdFor(db, kind, key) };
  const lastAttempt = isLastAttempt(job as { retryCount?: unknown; retryLimit?: unknown });
  /** Retries (throws) a transient failure; records a final one as failed and flags an operator. Returns only when final. */
  const fail = async (kind: "payout" | "refund", err: unknown): Promise<void> => {
    const error = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof PayPalError ? err.status : null;
    const final = paypalFailure(err, lastAttempt);
    await audit(db, { actor: "paypal", event: `paypal.${kind}_error`, milestoneId, contractId, detail: { deliveryId: claim.deliveryId, error, httpStatus, final, retryCount: job.retryCount ?? null } });
    if (!final) throw err; // pg-boss retries with the same PayPal-Request-Id
    await recordResponse(db, kind, milestoneId, { status: "failed", response: { error: { message: error, httpStatus, body: err instanceof PayPalError ? err.body : null, final } } });
    const why = final === "rejected" ? `PayPal rejected the ${kind} (HTTP ${httpStatus})` : `The ${kind} call still failed on the last retry; PayPal may or may not have received it`;
    await flagFromJob(db, milestoneId, why, { error, httpStatus, final });
  };

  const ops = await releaseOps(db, milestoneId);
  if (claim.releaseMinor > 0 && unsent(ops.payout, claim)) {
    let results: { payout?: { batch_header?: { payout_batch_id?: string; batch_status?: string } } };
    try {
      results = (await executeRelease(ctx, payoutPlan(milestoneId, claim))) as typeof results;
    } catch (err) {
      // A final payout failure stops here: the refund half is not sent, the operator decides.
      return fail("payout", err);
    }
    const batch = results.payout?.batch_header;
    const denied = batch?.batch_status === "DENIED";
    // Recorded before the refund call, so a failing refund never loses the payout result.
    await recordResponse(db, "payout", milestoneId, {
      ...(batch?.payout_batch_id ? { paypalId: batch.payout_batch_id } : {}),
      ...(denied ? { status: "failed" as const } : {}),
      response: results.payout ?? {},
    });
    await audit(db, {
      actor: "paypal",
      event: "paypal.payout",
      milestoneId,
      contractId,
      detail: {
        payoutBatchId: batch?.payout_batch_id ?? null,
        batchStatus: batch?.batch_status ?? null,
        deliveryId: claim.deliveryId,
        action: claim.action,
        ruleIds: claim.ruleIds,
        amountMinor: claim.releaseMinor,
        currency: claim.currency,
        ...claim.shares,
      },
    });
    if (denied) await flagFromJob(db, milestoneId, "PayPal denied the payout batch", { payoutBatchId: batch?.payout_batch_id ?? null });
  }

  if (claim.refundMinor > 0 && unsent(ops.refund, claim)) {
    let results: { refund?: { id?: string; status?: string } };
    try {
      results = (await executeRelease(ctx, refundPlan(milestoneId, claim))) as typeof results;
    } catch (err) {
      return fail("refund", err);
    }
    const r = results.refund;
    const status = r?.status === "COMPLETED" ? "succeeded" : r?.status === "FAILED" || r?.status === "CANCELLED" ? "failed" : undefined;
    await recordResponse(db, "refund", milestoneId, { ...(r?.id ? { paypalId: r.id } : {}), ...(status ? { status } : {}), response: r ?? {} });
    await audit(db, {
      actor: "paypal",
      event: "paypal.refund",
      milestoneId,
      contractId,
      detail: { refundId: r?.id ?? null, refundStatus: r?.status ?? null, refundMinor: claim.refundMinor, currency: claim.currency, deliveryId: claim.deliveryId },
    });
    if (status === "failed") await flagFromJob(db, milestoneId, `PayPal refund ${r?.status ?? "failed"}`, { refundId: r?.id ?? null });
  }
}
