import { and, asc, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db, Executor } from "./db.ts";
import { accounts, ledgerRefs, postTransaction } from "./ledger.ts";
import { auditLog, milestones } from "./schema.ts";
import { toPayPalValue, type CriterionSpec, type MilestoneStatus, type PolicyAction } from "./schemas.ts";

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
  deliveryRefused: "delivery.refused",
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
  // Saved PayPal (vault) and agent funding
  vaultSetupStarted: "vault.setup_started",
  paymentMethodSaved: "vault.payment_method_saved",
  paymentMethodRemoved: "vault.payment_method_removed",
  vaultFundRefused: "vault.fund_refused",
  paypalVaultCharge: "paypal.vault_charge",
  paypalVaultChargeError: "paypal.vault_charge_error",
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

/** The contract's next unfunded milestone: its lowest-seq milestone still in draft; null when none is left. */
export async function nextDraftMilestone(q: Executor, contractId: string): Promise<typeof milestones.$inferSelect | null> {
  const [row] = await q.select().from(milestones).where(and(eq(milestones.contractId, contractId), eq(milestones.status, "draft"))).orderBy(asc(milestones.seq)).limit(1);
  return row ?? null;
}

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

// ---------- Funding (shared by the capture route, the PayPal webhook and the vault charge) ----------

/** The parts of a PayPal capture we act on (order capture response or PAYMENT.CAPTURE.* resource). */
export interface CaptureInfo {
  id: string;
  status: string;
  amount: { value: string; currency_code: string };
}

export type FundResult =
  | { kind: "funded"; status: "funded"; captureId: string }
  /** Nothing to do: the milestone is already past draft (repeated onApprove, double click, redelivered webhook). */
  | { kind: "already"; status: MilestoneStatus; captureId: string | null }
  /** PayPal holds the capture as PENDING; PAYMENT.CAPTURE.COMPLETED finishes the job. */
  | { kind: "pending"; status: "draft"; captureId: string; captureStatus: string }
  | { kind: "mismatch"; captureId: string }
  | { kind: "rejected"; httpStatus: 404 | 409; error: string }
  | { kind: "paypal_error"; error: unknown };

export function isCaptureInfo(v: unknown): v is CaptureInfo {
  const c = v as Partial<CaptureInfo> | null;
  return !!c && typeof c.id === "string" && typeof c.status === "string" && !!c.amount && typeof c.amount.value === "string" && typeof c.amount.currency_code === "string";
}

export interface FundFromCaptureOptions {
  /** The PayPal order the capture belongs to; recorded on the milestone (and in the funded audit row). */
  orderId?: string | null;
  /**
   * The verifier's tamper-check baseline (the default branch head), resolved outside the row lock and only on the path
   * that moves the milestone to funded. The caller supplies it (a network call); omitted, none is recorded.
   */
  baselineSha?: (contract: { repoFullName: string | null }) => Promise<string | null>;
  /** Extra fields for the milestone.funded audit row (e.g. the mandate and payment method of a vault charge). */
  detail?: Record<string, unknown>;
}

/**
 * Funds a draft milestone from a capture: amount check, then under SELECT ... FOR UPDATE on the milestone row the
 * capture id (and order id), the client -> held ledger entry (skipped when one with this capture id exists) and
 * draft -> funded, audited as `actor`. A PENDING capture only records its id. Idempotent; safe to call from the capture
 * route, the webhook and the vault charge concurrently. Makes no PayPal call.
 */
export async function fundMilestoneFromCapture(db: Db, milestoneId: string, capture: CaptureInfo, actor: string, opts: FundFromCaptureOptions = {}): Promise<FundResult> {
  const found = await loadMilestone(db, milestoneId);
  if (!found) return { kind: "rejected", httpStatus: 404, error: "milestone not found" };
  const { milestone: m, contract: c } = found;
  if (m.status !== "draft") return { kind: "already", status: m.status, captureId: m.paypalCaptureId };
  const orderId = opts.orderId ?? null;

  const expected = toPayPalValue(m.amountMinor, c.currency);
  if (capture.amount.currency_code !== c.currency || capture.amount.value !== expected) {
    await audit(db, {
      actor: "paypal",
      event: AUDIT_EVENTS.milestoneCaptureMismatch,
      milestoneId: m.id,
      contractId: c.id,
      detail: { captureId: capture.id, expected: { value: expected, currency: c.currency }, got: capture.amount },
    });
    return { kind: "mismatch", captureId: capture.id };
  }

  if (capture.status !== "COMPLETED") {
    const recorded = await db.transaction(async (tx) => {
      const [row] = await tx.select({ status: milestones.status, captureId: milestones.paypalCaptureId }).from(milestones).where(eq(milestones.id, m.id)).for("update");
      if (!row || row.status !== "draft") return row ?? null;
      if (row.captureId !== capture.id) {
        await tx.update(milestones).set({ paypalCaptureId: capture.id, ...(orderId ? { paypalOrderId: orderId } : {}) }).where(eq(milestones.id, m.id));
        await audit(tx, { actor: "paypal", event: AUDIT_EVENTS.milestoneCapturePending, milestoneId: m.id, contractId: c.id, detail: { captureId: capture.id, captureStatus: capture.status } });
      }
      return null;
    });
    if (recorded) return { kind: "already", status: recorded.status, captureId: recorded.captureId };
    return { kind: "pending", status: "draft", captureId: capture.id, captureStatus: capture.status };
  }

  // Outside the row lock: a network call. Recorded only by the call that moves the milestone to funded.
  const baselineSha = opts.baselineSha ? await opts.baselineSha(c).catch(() => null) : null;

  return db.transaction(async (tx): Promise<FundResult> => {
    const [row] = await tx.select({ status: milestones.status, captureId: milestones.paypalCaptureId }).from(milestones).where(eq(milestones.id, m.id)).for("update");
    if (!row) throw new Error(`milestone ${m.id} disappeared`);
    if (row.status !== "draft") return { kind: "already", status: row.status, captureId: row.captureId };

    await tx.update(milestones).set({ paypalCaptureId: capture.id, ...(orderId ? { paypalOrderId: orderId } : {}), ...(baselineSha ? { baselineSha } : {}) }).where(eq(milestones.id, m.id));
    const ref = ledgerRefs.capture(capture.id);
    const posted = await tx.query.ledgerEntries.findFirst({ where: (l) => eq(l.ref, ref) });
    if (!posted) {
      await postTransaction(tx, {
        ref,
        currency: c.currency,
        entries: [
          { account: accounts.client(c.clientId), amountMinor: m.amountMinor, direction: "debit" },
          { account: accounts.held(m.id), amountMinor: m.amountMinor, direction: "credit" },
        ],
      });
    }
    await transition(tx, m.id, "funded", {
      actor,
      event: AUDIT_EVENTS.milestoneFunded,
      detail: { ...opts.detail, orderId: orderId ?? m.paypalOrderId, captureId: capture.id, amountMinor: m.amountMinor, currency: c.currency, baselineSha },
    });
    return { kind: "funded", status: "funded", captureId: capture.id };
  });
}
