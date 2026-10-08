import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Executor } from "./db.ts";
import { auditLog, milestones } from "./schema.ts";
import type { CriterionSpec, MilestoneStatus, PolicyAction } from "./schemas.ts";

// ---------- States ----------

/** Legal transitions from the Implementation tab's state diagram (the ordinary, cause-free edges). */
export const TRANSITIONS: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  draft: ["funded"],
  funded: ["verifying"],
  verifying: ["review", "held", "needs_client"],
  review: ["released", "held"],
  held: ["verifying"],
  needs_client: ["released", "partial_released", "held"],
  released: [],
  partial_released: [],
};

/** Why a guarded edge may be taken. "reversal": PayPal returned / reversed a payout item after the milestone settled. */
export type TransitionCause = "reversal";

/**
 * Edges that only a stated cause may take; transition() refuses them otherwise. They are kept out of TRANSITIONS so
 * nothing that asks "may this milestone be held?" (canHold, finalise) ever treats a settled milestone as holdable.
 */
export const GUARDED_TRANSITIONS: ReadonlyArray<{ from: MilestoneStatus; to: MilestoneStatus; cause: TransitionCause }> = [
  { from: "released", to: "held", cause: "reversal" },
  { from: "partial_released", to: "held", cause: "reversal" },
];

/** Whether from -> to is legal, given the cause (if any) the caller states. */
export function canTransition(from: MilestoneStatus, to: MilestoneStatus, cause?: TransitionCause): boolean {
  if (TRANSITIONS[from].includes(to)) return true;
  return cause !== undefined && GUARDED_TRANSITIONS.some((e) => e.from === from && e.to === to && e.cause === cause);
}

/** States a delivery may be submitted in. */
export const DELIVERABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["funded", "held"]);
/** States the verify job may (re-)enter verifying from: deliverable, or already verifying. */
export const VERIFIABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["funded", "held", "verifying"]);
/** The only states a new release may start from. */
export const RELEASABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["review", "needs_client"]);

/** Where a policy decision sends a verifying milestone. partial and ask_client wait for the client. */
export function statusForDecision(action: PolicyAction): "review" | "held" | "needs_client" {
  return action === "release" ? "review" : action === "hold" ? "held" : "needs_client";
}

/** The review window can be shortened for demos, never skipped. */
export const MIN_REVIEW_WINDOW_SECONDS = 30;

/** The review window to use: REVIEW_WINDOW_SECONDS when set to a number, else the contract's, never below the minimum. */
export function reviewWindowSeconds(contractWindow: number, override = process.env.REVIEW_WINDOW_SECONDS): number {
  const env = Number(override);
  const chosen = override !== undefined && override.trim() !== "" && Number.isFinite(env) ? Math.floor(env) : contractWindow;
  return Math.max(MIN_REVIEW_WINDOW_SECONDS, Number.isFinite(chosen) ? chosen : MIN_REVIEW_WINDOW_SECONDS);
}

// ---------- Audit ----------

/** Audit event names written by more than one place, or read back to make decisions. The strings are stored. */
export const AUDIT_EVENTS = {
  // Operator flags
  needsOperator: "milestone.needs_operator",
  opsResolved: "ops.resolved",
  advanceNeedsOperator: "advance.needs_operator",
  // Milestone lifecycle
  milestoneOrderCreated: "milestone.order_created",
  milestoneFunded: "milestone.funded",
  milestoneCapturePending: "milestone.capture_pending",
  milestoneCaptureMismatch: "milestone.capture_mismatch",
  milestoneVerifying: "milestone.verifying",
  milestoneReview: "milestone.review",
  milestoneHeld: "milestone.held",
  milestoneNeedsClient: "milestone.needs_client",
  milestoneReleased: "milestone.released",
  milestonePartialReleased: "milestone.partial_released",
  milestoneReversed: "milestone.reversed",
  milestoneSettleConflict: "milestone.settle_conflict",
  // Contracts and deliveries
  contractCreated: "contract.created",
  contractApproved: "contract.approved",
  deliveryManual: "delivery.manual",
  deliveryUpload: "delivery.upload",
  // Verify
  verdictStored: "verdict.stored",
  policyDecided: "policy.decided",
  verifyRefusedNeedsOperator: "verify.refused_needs_operator",
  githubCommented: "github.commented",
  githubCommentFailed: "github.comment_failed",
  // Release
  releaseClaimed: "release.claimed",
  releaseSkipped: "release.skipped",
  releaseSkippedInFlight: "release.skipped_in_flight",
  releaseRefusedNeedsOperator: "release.refused_needs_operator",
  releaseBlockedByDispute: "release.blocked_by_dispute",
  releaseLeaseTakenOver: "release.lease_taken_over",
  releaseWaiting: "release.waiting",
  // PayPal calls and webhooks
  paypalPayout: "paypal.payout",
  paypalPayoutError: "paypal.payout_error",
  paypalRefund: "paypal.refund",
  paypalRefundError: "paypal.refund_error",
  paypalPayoutFailed: "paypal.payout_failed",
  paypalPayoutUnclaimed: "paypal.payout_unclaimed",
  paypalPayoutHeld: "paypal.payout_held",
  paypalPayoutReversed: "paypal.payout_reversed",
  paypalPayoutItemConflict: "paypal.payout_item_conflict",
  paypalPayoutUnmatched: "paypal.payout_unmatched",
  paypalUnmatchedBatch: "paypal.unmatched_batch",
  paypalPayoutBatchUnmatched: "paypal.payout_batch_unmatched",
  paypalPayoutBatchDenied: "paypal.payout_batch_denied",
  paypalRefundSettled: "paypal.refund_settled",
  paypalRefundFailed: "paypal.refund_failed",
  paypalRefundUnmatched: "paypal.refund_unmatched",
  paypalCaptureUnmatched: "paypal.capture_unmatched",
  paypalDisputeUnmatched: "paypal.dispute_unmatched",
  paypalReceipt: "paypal.receipt",
  paypalReceiptFailed: "paypal.receipt_failed",
  paypalAdvancePayoutError: "paypal.advance_payout_error",
  receiptSkipped: "receipt.skipped",
  settleWaiting: "settle.waiting",
  ledgerSkipped: "ledger.skipped",
  ledgerPartnerExcess: "ledger.partner_excess",
  // Advances
  advanceAccepted: "advance.accepted",
  advanceSkipped: "advance.skipped",
  advanceRefused: "advance.refused",
  advanceWithdrawn: "advance.withdrawn",
  advanceFunded: "advance.funded",
  advanceConfigError: "advance.config_error",
  advanceRepaid: "advance.repaid",
  advanceShortfall: "advance.shortfall",
  advanceRepaymentFailed: "advance.repayment_failed",
  // Disputes
  disputeOpened: "dispute.opened",
  disputeUpdated: "dispute.updated",
  disputeResolved: "dispute.resolved",
  disputeDrafted: "dispute.drafted",
  disputeEvidenceSubmitted: "dispute.evidence_submitted",
  disputeEvidenceFailed: "dispute.evidence_failed",
  disputeClaimAccepted: "dispute.claim_accepted",
  disputeAcceptFailed: "dispute.accept_failed",
} as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[keyof typeof AUDIT_EVENTS];

export interface AuditInput {
  actor: string; // "system", "verifier", "policy", "paypal", or a user id
  event: string; // an AUDIT_EVENTS value, or a computed one such as `client.${action}`
  detail?: unknown;
  contractId?: string;
  milestoneId?: string;
}

export type AuditRow = typeof auditLog.$inferSelect;

export async function audit(db: Executor, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor: input.actor,
    event: input.event,
    detail: input.detail ?? null,
    contractId: input.contractId ?? null,
    milestoneId: input.milestoneId ?? null,
  });
}

/**
 * Whether any audit row has this event (and milestone, and detail->>key = value, when given). "Ever happened" checks:
 * hasAudit(q, { event: AUDIT_EVENTS.needsOperator, milestoneId }) is the release and verify jobs' "never again" gate;
 * hasAudit(q, { event: AUDIT_EVENTS.advanceNeedsOperator, detail: ["advanceId", id] }) the advance job's.
 */
export async function hasAudit(q: Executor, f: { event: string; milestoneId?: string; detail?: readonly [key: string, value: string] }): Promise<boolean> {
  const where: SQL[] = [eq(auditLog.event, f.event)];
  if (f.milestoneId !== undefined) where.push(eq(auditLog.milestoneId, f.milestoneId));
  if (f.detail) where.push(sql`${auditLog.detail}->>${f.detail[0]} = ${f.detail[1]}`);
  const [row] = await q.select({ id: auditLog.id }).from(auditLog).where(and(...where)).limit(1);
  return row !== undefined;
}

/**
 * THE definition of "flagged for an operator" (open case): a milestone whose latest milestone.needs_operator row has
 * no ops.resolved row for the same milestone at or after it. Returns milestoneId -> that latest needs_operator row,
 * for the given milestones, or for all milestones when `milestoneIds` is omitted (the /ops queue).
 * An ops.resolved closes the case for the queue only: the release and verify jobs still refuse a milestone that was
 * ever flagged (hasAudit), since an operator resolves it by hand (CLAUDE.md rule 8).
 */
export async function openOperatorFlags(q: Executor, milestoneIds?: readonly string[]): Promise<Map<string, AuditRow>> {
  const out = new Map<string, AuditRow>();
  if (milestoneIds && milestoneIds.length === 0) return out;
  const events = inArray(auditLog.event, [AUDIT_EVENTS.needsOperator, AUDIT_EVENTS.opsResolved]);
  const rows = await q
    .select()
    .from(auditLog)
    .where(milestoneIds ? and(events, inArray(auditLog.milestoneId, [...milestoneIds])) : events)
    .orderBy(desc(auditLog.createdAt));
  const resolvedAt = new Map<string, Date>();
  for (const r of rows) {
    if (!r.milestoneId) continue;
    if (r.event === AUDIT_EVENTS.needsOperator && !out.has(r.milestoneId)) out.set(r.milestoneId, r);
    if (r.event === AUDIT_EVENTS.opsResolved && !resolvedAt.has(r.milestoneId)) resolvedAt.set(r.milestoneId, r.createdAt);
  }
  for (const [id, flag] of out) {
    const r = resolvedAt.get(id);
    if (r && r >= flag.createdAt) out.delete(id);
  }
  return out;
}

// ---------- Transitions ----------

/**
 * Moves a milestone to `to`, refusing illegal transitions, and writes the audit entry in the same call.
 * A guarded edge (released / partial_released -> held) is taken only with opts.cause "reversal".
 * Idempotent: if the milestone is already in `to`, nothing happens and false is returned.
 */
export async function transition(
  db: Executor,
  milestoneId: string,
  to: MilestoneStatus,
  entry: Omit<AuditInput, "milestoneId" | "contractId">,
  opts: { cause?: TransitionCause } = {},
): Promise<boolean> {
  const [m] = await db.select({ status: milestones.status, contractId: milestones.contractId }).from(milestones).where(eq(milestones.id, milestoneId)).limit(1);
  if (!m) throw new Error(`milestone ${milestoneId} not found`);
  if (m.status === to) return false;
  if (!canTransition(m.status, to, opts.cause)) throw new Error(`illegal transition ${m.status} -> ${to} for milestone ${milestoneId}`);
  await db.update(milestones).set({ status: to }).where(eq(milestones.id, milestoneId));
  await audit(db, { ...entry, milestoneId, contractId: m.contractId, detail: { from: m.status, to, ...(entry.detail && typeof entry.detail === "object" ? entry.detail : { note: entry.detail }) } });
  return true;
}

// ---------- Loaders ----------

type MilestoneRow = typeof milestones.$inferSelect;

/** A milestone with its contract; null when either is missing. */
export async function loadMilestone(q: Executor, id: string) {
  const row = await q.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, id), with: { contract: true } });
  if (!row) return null;
  const { contract, ...milestone } = row;
  return { milestone: milestone satisfies MilestoneRow, contract };
}

/**
 * A delivery with its milestone, contract and the milestone's criteria (as CriterionSpec, ordered by id), in one
 * relational query; null when any of them is missing.
 */
export async function loadDeliveryContext(q: Executor, deliveryId: string) {
  const row = await q.query.deliveries.findFirst({
    where: (d, { eq }) => eq(d.id, deliveryId),
    with: { milestone: { with: { contract: true, criteria: { orderBy: (c, { asc }) => asc(c.id) } } } },
  });
  if (!row?.milestone?.contract) return null;
  const { milestone: m, ...delivery } = row;
  const { contract, criteria: rows, ...milestone } = m;
  const criteria: CriterionSpec[] = rows.map((r) => ({ id: r.id, kind: r.kind, description: r.description, spec: r.spec, required: r.required }));
  return { delivery, milestone: milestone satisfies MilestoneRow, contract, criteria };
}
