import type { Job } from "pg-boss";
import { PolicyDecision, audit, recordOpResult, requestIdFor, transition, type Db, type MilestoneStatus } from "@milestone/core";
import { applyReviewWindow, executeRelease, type MoneyContext, type ReleasePlan, type ReviewWindowState } from "@milestone/money";
import type { JobData } from "../handlers.js";
import { getDb } from "../lib/db.js";
import { paypal } from "../lib/paypal.js";

// ---------- Pure helpers (unit-tested in apps/worker/test) ----------

/** States after which a release job has nothing left to do. */
export const SETTLED_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["released", "partial_released"]);

/** Client responses that count as approval before the review window closes. */
const EARLY_APPROVALS = new Set(["approve", "confirm_partial"]);

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

/** Mirrors executeRelease: the partner is repaid first, capped at the released amount; the freelancer gets the rest. */
export function payoutShares(releaseMinor: number, partnerOwedMinor: number): { partnerShareMinor: number; freelancerShareMinor: number } {
  const partnerShareMinor = Math.max(0, Math.min(partnerOwedMinor, releaseMinor));
  return { partnerShareMinor, freelancerShareMinor: releaseMinor - partnerShareMinor };
}

// ---------- DB helpers ----------

async function opSucceeded(db: Db, kind: string, key: string): Promise<boolean> {
  const op = await db.query.paypalOps.findFirst({ where: (o, { and, eq }) => and(eq(o.kind, kind), eq(o.key, key)) });
  return op?.status === "succeeded";
}

// ---------- Job ----------

/**
 * Runs when the review window closes, or right away on early approval / client confirmation of a partial.
 * Sends the payout (and the refund of an unverified share) but never marks the milestone released:
 * the settle job does that when PayPal's webhook confirms the payout (CLAUDE.md rule 7).
 */
export async function release(job: Job<JobData>): Promise<void> {
  const db = getDb();
  const milestoneId = job.data.milestoneId;
  const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!m) throw new Error(`milestone ${milestoneId} not found`);
  if (SETTLED_STATUSES.has(m.status)) return; // idempotent: already settled by the webhook

  const stored = parseDecision(m.decision);
  if (!stored) {
    await audit(db, { actor: "system", event: "release.skipped", milestoneId, contractId: m.contractId, detail: { reason: "milestone has no policy decision" } });
    return;
  }

  // Once the payout has been accepted the review window can no longer stop it; only finish a missing refund.
  const payoutSent = await opSucceeded(db, "payout", milestoneId);
  const outcome = payoutSent ? stored : applyReviewWindow(reviewWindowState(stored, m, new Date()));

  if (outcome.action === "hold") {
    await transition(db, milestoneId, "held", { actor: "policy", event: "milestone.held", detail: { reason: outcome.reason, ruleIds: outcome.ruleIds } });
    return;
  }
  if (outcome.action === "ask_client") {
    await audit(db, { actor: "policy", event: "release.waiting", milestoneId, contractId: m.contractId, detail: { reason: outcome.reason, ruleIds: outcome.ruleIds } });
    return;
  }

  const refundDue = m.amountMinor - outcome.amountMinor > 0;
  if (payoutSent && (!refundDue || (await opSucceeded(db, "refund", milestoneId)))) return; // nothing left to send

  const contract = await db.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
  if (!contract) throw new Error(`contract ${m.contractId} not found`);
  const freelancer = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) });
  if (!freelancer?.paypalEmail) throw new Error(`freelancer ${contract.freelancerId} has no PayPal email`);
  if (!m.paypalCaptureId) throw new Error(`milestone ${milestoneId} has no PayPal capture id`);

  // "repaid" too, so a retry that only finishes the refund replays exactly the original payout items.
  const advance = await db.query.advances.findFirst({ where: (a, { and, eq, inArray }) => and(eq(a.milestoneId, milestoneId), inArray(a.status, ["funded", "repaid"])) });
  let partner: ReleasePlan["partner"];
  if (advance) {
    const p = await db.query.users.findFirst({ where: (u, { eq }) => eq(u.id, advance.partnerId) });
    if (!p?.paypalEmail) throw new Error(`partner ${advance.partnerId} has no PayPal email`);
    const owed = advanceRepayment(advance, m.decidedAt);
    partner = { email: p.paypalEmail, amountMinor: owed.principalMinor + owed.feeMinor };
  }

  const ctx: MoneyContext = { client: paypal(), requestIdFor: (kind, key) => requestIdFor(db, kind, key) };
  const plan: ReleasePlan = {
    milestoneId,
    currency: contract.currency,
    captureId: m.paypalCaptureId,
    freelancerEmail: freelancer.paypalEmail,
    decision: outcome,
    milestoneAmountMinor: m.amountMinor,
    ...(partner ? { partner } : {}),
  };

  let results: { payout?: { batch_header?: { payout_batch_id?: string; batch_status?: string } }; refund?: { id?: string; status?: string } };
  try {
    results = (await executeRelease(ctx, plan)) as typeof results;
  } catch (err) {
    await audit(db, { actor: "paypal", event: "paypal.payout_error", milestoneId, contractId: m.contractId, detail: { error: err instanceof Error ? err.message : String(err) } });
    throw err; // pg-boss retries with the same PayPal-Request-Id
  }

  const batchId = results.payout?.batch_header?.payout_batch_id;
  if (results.payout) {
    await recordOpResult(db, await requestIdFor(db, "payout", milestoneId), { status: "succeeded", ...(batchId ? { paypalId: batchId } : {}), response: results.payout });
  }
  if (results.refund) {
    await recordOpResult(db, await requestIdFor(db, "refund", milestoneId), { status: "succeeded", ...(results.refund.id ? { paypalId: results.refund.id } : {}), response: results.refund });
  }

  const shares = payoutShares(outcome.amountMinor, partner?.amountMinor ?? 0);
  await audit(db, {
    actor: "paypal",
    event: "paypal.payout",
    milestoneId,
    contractId: m.contractId,
    detail: {
      payoutBatchId: batchId ?? null,
      batchStatus: results.payout?.batch_header?.batch_status ?? null,
      action: outcome.action,
      ruleIds: outcome.ruleIds,
      amountMinor: outcome.amountMinor,
      currency: contract.currency,
      ...shares,
      refundId: results.refund?.id ?? null,
      refundMinor: m.amountMinor - outcome.amountMinor,
    },
  });
}
