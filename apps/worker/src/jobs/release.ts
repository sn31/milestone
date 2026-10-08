import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  PolicyDecision,
  audit,
  criteria as criteriaTable,
  deliveries,
  milestones,
  paypalOps,
  requestIdFor,
  transition,
  type Db,
  type MilestoneStatus,
} from "@milestone/core";
import { applyReviewWindow, executeRelease, type MoneyContext, type ReleasePlan, type ReviewWindowState } from "@milestone/money";
import type { JobData } from "../handlers.js";
import { getDb } from "../lib/db.js";
import { paypal } from "../lib/paypal.js";

// ---------- Pure helpers (unit-tested in apps/worker/test) ----------

/** States after which a release job has nothing left to do, unless a claimed refund is still unfinished. */
export const SETTLED_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["released", "partial_released"]);

/** The only states a new release may start from. */
export const RELEASABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["review", "needs_client"]);

/** States in which an already-claimed release may still finish its PayPal calls (a retry after a crash, or a late refund). */
export const RESUMABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["review", "needs_client", "released", "partial_released"]);

/** paypal_ops statuses meaning "this payout (or refund) has started": the client can no longer veto or hold. */
export const STARTED_OP_STATUSES: ReadonlySet<string> = new Set(["sent", "succeeded"]);

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

/** paypal_ops key of the n-th payout attempt. The first attempt keeps the plain milestone id that executeRelease asks for. */
export function payoutOpKey(milestoneId: string, attempt: number): string {
  return attempt <= 1 ? milestoneId : `${milestoneId}:${attempt}`;
}

/** Inverse of payoutOpKey; null when the key is not one of this milestone's payout keys. */
export function payoutAttempt(milestoneId: string, key: string): number | null {
  if (key === milestoneId) return 1;
  const prefix = `${milestoneId}:`;
  if (!key.startsWith(prefix)) return null;
  const n = Number(key.slice(prefix.length));
  return Number.isInteger(n) && n >= 2 ? n : null;
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

/** Shares for a (re-)payment: a party whose item already succeeded in an earlier attempt is never paid again. */
export function planShares(releaseMinor: number, partnerOwedMinor: number, paid: { partner: boolean; freelancer: boolean }) {
  const s = payoutShares(releaseMinor, partnerOwedMinor);
  return { partnerShareMinor: paid.partner ? 0 : s.partnerShareMinor, freelancerShareMinor: paid.freelancer ? 0 : s.freelancerShareMinor };
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

/** Reads the per-item outcomes stored on a payout op's response JSON. */
export function itemOutcomes(response: unknown): Partial<Record<PayoutParty, ItemOutcome>> {
  const items = response && typeof response === "object" ? (response as { items?: unknown }).items : undefined;
  const out: Partial<Record<PayoutParty, ItemOutcome>> = {};
  if (!items || typeof items !== "object") return out;
  for (const party of ["partner", "freelancer"] as const) {
    const v = (items as Record<string, unknown>)[party];
    if (!v || typeof v !== "object") continue;
    const r = v as Record<string, unknown>;
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

/** Which parties have been paid by any earlier attempt. */
export function paidParties(responses: readonly unknown[]): { partner: boolean; freelancer: boolean } {
  const paid = { partner: false, freelancer: false };
  for (const r of responses) {
    const items = itemOutcomes(r);
    if (items.partner?.status === "succeeded") paid.partner = true;
    if (items.freelancer?.status === "succeeded") paid.freelancer = true;
  }
  return paid;
}

/**
 * What a release job claimed, stored on its paypal_ops rows (request.claim) before any PayPal call. A retry replays the
 * claim exactly; the settle job reads the action, shares and refund from it.
 */
export interface ReleaseClaim {
  deliveryId: string;
  attempt: number;
  action: "release" | "partial";
  ruleIds: string[];
  reason: string;
  /** Released to the parties in this attempt (partner + freelancer shares). */
  releaseMinor: number;
  /** Refunded to the client by this claim; 0 when there is none or an earlier claim already refunded. */
  refundMinor: number;
  currency: string;
  captureId: string;
  freelancerEmail: string;
  partnerEmail: string | null;
  shares: { partnerShareMinor: number; freelancerShareMinor: number };
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

export function parseClaim(request: unknown): ReleaseClaim | null {
  const c = request && typeof request === "object" ? (request as { claim?: unknown }).claim : undefined;
  if (!c || typeof c !== "object") return null;
  const r = c as Record<string, unknown>;
  const shares = r.shares as Record<string, unknown> | undefined;
  if (typeof r.deliveryId !== "string" || !isInt(r.attempt) || (r.action !== "release" && r.action !== "partial")) return null;
  if (!isInt(r.releaseMinor) || !isInt(r.refundMinor) || typeof r.currency !== "string" || typeof r.captureId !== "string" || typeof r.freelancerEmail !== "string") return null;
  if (!shares || !isInt(shares.partnerShareMinor) || !isInt(shares.freelancerShareMinor)) return null;
  return {
    deliveryId: r.deliveryId,
    attempt: r.attempt,
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
  };
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

// ---------- DB helpers ----------

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Q = Db | Tx;
export type OpRow = typeof paypalOps.$inferSelect;

/** This milestone's payout ops (every attempt, oldest first) and its refund op. */
export async function releaseOps(q: Q, milestoneId: string): Promise<{ payouts: Array<OpRow & { attempt: number }>; refund: OpRow | undefined }> {
  const rows = await q
    .select()
    .from(paypalOps)
    .where(
      or(
        and(eq(paypalOps.kind, "payout"), or(eq(paypalOps.key, milestoneId), sql`starts_with(${paypalOps.key}, ${`${milestoneId}:`})`)),
        and(eq(paypalOps.kind, "refund"), eq(paypalOps.key, milestoneId)),
      ),
    );
  const payouts = rows
    .filter((r) => r.kind === "payout")
    .map((r) => ({ ...r, attempt: payoutAttempt(milestoneId, r.key) }))
    .filter((r): r is OpRow & { attempt: number } => r.attempt !== null)
    .sort((a, b) => a.attempt - b.attempt);
  return { payouts, refund: rows.find((r) => r.kind === "refund") };
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

/** Stores PayPal's answer without losing per-item outcomes the settle job may already have written. */
async function recordResponse(db: Db, kind: string, key: string, set: { paypalId?: string; status?: "sent" | "succeeded" | "failed"; response: unknown }): Promise<void> {
  await db
    .update(paypalOps)
    .set({
      ...(set.paypalId ? { paypalId: set.paypalId } : {}),
      ...(set.status ? { status: set.status } : {}),
      response: sql`${JSON.stringify(set.response ?? {})}::jsonb || jsonb_build_object('items', coalesce(${paypalOps.response} -> 'items', '{}'::jsonb))`,
      updatedAt: new Date(),
    })
    .where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key), inArray(paypalOps.status, ["sent", "pending"])));
}

// ---------- Job ----------

interface Claimed {
  claim: ReleaseClaim;
  contractId: string;
}

/**
 * Locks the milestone, checks the job is still current and the client has not stopped it, and claims the paypal_ops
 * rows (status "sent") in the same transaction. The review route takes the same lock and refuses veto / hold once a
 * claimed op exists, so a veto either lands before the claim (and this job skips) or is refused.
 */
async function claimRelease(db: Db, milestoneId: string, jobDeliveryId: string | null): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!m) throw new Error(`milestone ${milestoneId} not found`);
    const skip = async (reason: string, extra: Record<string, unknown> = {}) => {
      await audit(t, { actor: "system", event: "release.skipped", milestoneId, contractId: m.contractId, detail: { reason, jobDeliveryId, status: m.status, ...extra } });
      return null;
    };
    const decId = decisionDeliveryId(m.decision);
    const ops = await releaseOps(tx, milestoneId);

    // Resume: this delivery's release was already claimed (crash or retry after the PayPal call, or a refund to finish).
    const mine = [...ops.payouts, ...(ops.refund ? [ops.refund] : [])].map((o) => parseClaim(o.request)).filter((c): c is ReleaseClaim => c !== null && c.deliveryId === jobDeliveryId);
    const resume = mine.sort((a, b) => b.attempt - a.attempt)[0];
    if (resume) {
      if (decId !== jobDeliveryId) return skip("the claimed release belongs to an older decision", { claimedFor: resume.deliveryId });
      if (!RESUMABLE_STATUSES.has(m.status)) return skip(`claimed release cannot resume while milestone is ${m.status}`);
      return { claim: resume, contractId: m.contractId };
    }

    const stale = staleReason({ jobDeliveryId, decisionDeliveryId: decId, status: m.status });
    if (stale) return skip(stale);
    const stored = parseDecision(m.decision);
    if (!stored) return skip("milestone has no policy decision");
    const latest = ops.payouts.at(-1);
    if (latest?.status === "sent" || ops.refund?.status === "sent") return skip("another release is still in flight");

    const outcome = clientOutcome(stored, m, new Date());
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
    if (!freelancer?.paypalEmail) throw new Error(`freelancer ${contract.freelancerId} has no PayPal email`);
    if (!m.paypalCaptureId) throw new Error(`milestone ${milestoneId} has no PayPal capture id`);

    const advance = await tx.query.advances.findFirst({ where: (a, { and, eq, inArray }) => and(eq(a.milestoneId, milestoneId), inArray(a.status, ["funded", "repaid"])) });
    let partnerEmail: string | null = null;
    let owedMinor = 0;
    if (advance) {
      const p = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, advance.partnerId) });
      if (!p?.paypalEmail) throw new Error(`partner ${advance.partnerId} has no PayPal email`);
      const owed = advanceRepayment(advance, m.decidedAt);
      partnerEmail = p.paypalEmail;
      owedMinor = owed.principalMinor + owed.feeMinor;
    }

    const paid = paidParties(ops.payouts.map((o) => o.response));
    const shares = planShares(outcome.amountMinor, owedMinor, paid);
    const releaseMinor = shares.partnerShareMinor + shares.freelancerShareMinor;
    const refundDue = Math.max(0, m.amountMinor - outcome.amountMinor);
    const refundMinor = !ops.refund || ops.refund.status === "pending" ? refundDue : 0;
    if (releaseMinor === 0 && refundMinor === 0) return skip("nothing left to pay or refund", { paid, refundOp: ops.refund?.status ?? null });

    const attempt = !latest ? 1 : latest.status === "pending" ? latest.attempt : latest.attempt + 1;
    const claim: ReleaseClaim = {
      deliveryId: jobDeliveryId!,
      attempt,
      action: outcome.action === "partial" ? "partial" : "release",
      ruleIds: outcome.ruleIds,
      reason: outcome.reason,
      releaseMinor,
      refundMinor,
      currency: contract.currency,
      captureId: m.paypalCaptureId,
      freelancerEmail: freelancer.paypalEmail,
      partnerEmail,
      shares,
    };
    if (releaseMinor > 0) await claimOp(tx, "payout", payoutOpKey(milestoneId, attempt), claim);
    if (refundMinor > 0) await claimOp(tx, "refund", milestoneId, claim);
    await audit(t, { actor: "policy", event: "release.claimed", milestoneId, contractId: m.contractId, detail: { ...claim, paidBefore: paid } });
    return { claim, contractId: m.contractId };
  });
}

/**
 * Runs when the review window closes, or right away on early approval / client confirmation of a partial.
 * Sends the payout (and the refund of an unverified share) but never marks the milestone released:
 * the settle job does that when PayPal's webhook confirms the payout (CLAUDE.md rule 7).
 */
export async function release(job: Job<JobData>): Promise<void> {
  const db = getDb();
  const milestoneId = job.data.milestoneId;
  const jobDeliveryId = typeof job.data.deliveryId === "string" && job.data.deliveryId ? job.data.deliveryId : null;

  const claimed = await claimRelease(db, milestoneId, jobDeliveryId);
  if (!claimed) return;
  const { claim, contractId } = claimed;
  const ctx: MoneyContext = {
    client: paypal(),
    // executeRelease asks for ("payout", milestoneId); a re-pay attempt maps that to its own key, hence its own PayPal-Request-Id.
    requestIdFor: (kind, key) => requestIdFor(db, kind, kind === "payout" ? payoutOpKey(key, claim.attempt) : key),
  };
  const fail = async (event: string, err: unknown) => {
    await audit(db, { actor: "paypal", event, milestoneId, contractId, detail: { deliveryId: claim.deliveryId, attempt: claim.attempt, error: err instanceof Error ? err.message : String(err) } });
    throw err; // pg-boss retries with the same PayPal-Request-Id
  };

  const ops = await releaseOps(db, milestoneId);
  const payoutKey = payoutOpKey(milestoneId, claim.attempt);
  const payoutOp = ops.payouts.find((o) => o.key === payoutKey);
  let batch: { payout_batch_id?: string; batch_status?: string } | undefined;
  if (claim.releaseMinor > 0 && payoutOp?.status === "sent" && !payoutOp.paypalId && parseClaim(payoutOp.request)?.deliveryId === claim.deliveryId) {
    let results: { payout?: { batch_header?: { payout_batch_id?: string; batch_status?: string } } };
    try {
      results = (await executeRelease(ctx, payoutPlan(milestoneId, claim))) as typeof results;
    } catch (err) {
      return fail("paypal.payout_error", err);
    }
    batch = results.payout?.batch_header;
    // Recorded before the refund call, so a failing refund never loses the payout result.
    await recordResponse(db, "payout", payoutKey, {
      ...(batch?.payout_batch_id ? { paypalId: batch.payout_batch_id } : {}),
      ...(batch?.batch_status === "DENIED" ? { status: "failed" as const } : {}),
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
        attempt: claim.attempt,
        action: claim.action,
        ruleIds: claim.ruleIds,
        amountMinor: claim.releaseMinor,
        currency: claim.currency,
        ...claim.shares,
      },
    });
  }

  const refundOp = ops.refund;
  if (claim.refundMinor > 0 && refundOp?.status === "sent" && !refundOp.paypalId && parseClaim(refundOp.request)?.deliveryId === claim.deliveryId) {
    let results: { refund?: { id?: string; status?: string } };
    try {
      results = (await executeRelease(ctx, refundPlan(milestoneId, claim))) as typeof results;
    } catch (err) {
      return fail("paypal.refund_error", err);
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
  }
}
