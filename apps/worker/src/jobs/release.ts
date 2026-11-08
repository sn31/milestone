import type { Job } from "pg-boss";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import {
  AUDIT_EVENTS,
  OP_KINDS,
  PolicyDecision,
  RECORDED_SHOWCASE_TEXT,
  RELEASABLE_STATUSES,
  advances as advancesTable,
  asRecord,
  audit,
  claimOp,
  contracts as contractsTable,
  decisionDeliveryId,
  ledgerEntries,
  ledgerRefs,
  milestones,
  paypalOps,
  payoutReceiver,
  recordedForShowcase,
  requiredNotPassed,
  transition,
  type Db,
  type MilestoneStatus,
  type OpRow,
  type Tx,
} from "@milestone/core";
import { PayPalError, advanceRepayment, applyReviewWindow, executeRelease, loadAdvanceBalances, moneyContextFor, openDisputesFor, remainingOwed, type ReleasePlan, type ReviewWindowState } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { paypal } from "../lib/paypal.ts";
import {
  allocateRepayment,
  flagNeedsOperator,
  isFlaggedForOperator,
  parseClaim,
  payoutShares,
  releaseOps,
  itemOutcomes,
  type ClaimAdvance,
  type OpView,
  type ReleaseClaim,
} from "./claim.ts";
import { LEASE_MS, isLastAttempt, paypalFailure } from "./retry.ts";

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

/** States in which the claiming job may still finish its own PayPal calls (a retry after a crash or a failed refund call). */
export const RESUMABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["review", "needs_client", "released", "partial_released"]);

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

/**
 * Who may resume a claim's unanswered PayPal calls: "own" for the claiming job, "expired" once LEASE_MS has passed
 * since claimedAt (or when claimedAt is unreadable), "held" while another job's lease is live.
 */
export function leaseState(claim: Pick<ReleaseClaim, "jobId" | "claimedAt">, jobId: string | null, now: Date, leaseMs = LEASE_MS): "own" | "expired" | "held" {
  if (jobId && claim.jobId === jobId) return "own";
  const at = Date.parse(claim.claimedAt);
  if (!Number.isFinite(at)) return "expired";
  return now.getTime() - at >= leaseMs ? "expired" : "held";
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

/** An advance balance a payout claim may repay: what the ledger says is still owed on it, with its partner and currency. */
export interface OpenDue extends ClaimAdvance {
  partnerId: string;
  currency: string;
}

export interface BlockedDue {
  advanceId: string;
  partnerId: string;
  currency: string;
  remainingMinor: number;
}

/**
 * Pure. Nets each open balance against what payout claims still in flight are about to repay (principal first, then
 * fee), drops the settled ones, and picks the dues this payout repays: one payout repays one partner in one currency,
 * so the dues are those of the first remaining balance's partner in `currency`; the rest comes back as `blocked`.
 */
export function netDues(open: readonly OpenDue[], inFlight: ReadonlyMap<string, number>, currency: string): { partnerId: string | null; dues: ClaimAdvance[]; blocked: BlockedDue[] } {
  const remaining: OpenDue[] = [];
  for (const o of open) {
    const pending = inFlight.get(o.advanceId) ?? 0;
    const p = Math.min(o.principalMinor, pending);
    const due = { ...o, principalMinor: o.principalMinor - p, feeMinor: Math.max(0, o.feeMinor - (pending - p)) };
    if (due.principalMinor + due.feeMinor > 0) remaining.push(due);
  }
  const partnerId = remaining[0]?.partnerId ?? null;
  const mine = remaining.filter((r) => r.partnerId === partnerId && r.currency === currency);
  const blocked = remaining
    .filter((r) => !mine.includes(r))
    .map((r) => ({ advanceId: r.advanceId, partnerId: r.partnerId, currency: r.currency, remainingMinor: r.principalMinor + r.feeMinor }));
  return {
    partnerId: mine.length > 0 ? partnerId : null,
    dues: mine.map((r) => ({ advanceId: r.advanceId, milestoneId: r.milestoneId, principalMinor: r.principalMinor, feeMinor: r.feeMinor })),
    blocked,
  };
}

// ---------- DB helpers ----------

type MilestoneRow = typeof milestones.$inferSelect;
type AdvanceDbRow = typeof advancesTable.$inferSelect;
type OpenAdvance = { a: AdvanceDbRow; decidedAt: Date | null; currency: string };

type Owed =
  | { kind: "ok"; partnerId: string | null; dues: ClaimAdvance[]; blocked: BlockedDue[] }
  | { kind: "operator"; reason: string; detail: Record<string, unknown> };

/** An accepted own advance whose payout was claimed but never confirmed: PayPal may have paid it, a person decides. */
async function unconfirmedOwnAdvance(tx: Tx, own: readonly AdvanceDbRow[]): Promise<Extract<Owed, { kind: "operator" }> | null> {
  for (const a of own.filter((x) => x.status === "offered")) {
    const [op] = await tx
      .select({ status: paypalOps.status, response: paypalOps.response })
      .from(paypalOps)
      .where(and(eq(paypalOps.kind, OP_KINDS.advancePayout), eq(paypalOps.key, a.id)));
    const rejected = op?.status === "failed" && asRecord(asRecord(op.response).error).final === "rejected";
    if (op && !rejected) return { kind: "operator", reason: "an advance payout for this milestone was sent but never confirmed; PayPal may have paid it", detail: { advanceId: a.id, advanceOpStatus: op.status } };
  }
  return null;
}

/**
 * The freelancer's advances on OTHER milestones whose balance this release collects, row-locked so two claims
 * serialize on them, oldest funding first: shortfall, or funded where that milestone is released / partial_released,
 * or held after a full refund (nothing was ever repaid out of it).
 */
async function carriedAdvances(tx: Tx, m: MilestoneRow, freelancerId: string): Promise<OpenAdvance[]> {
  const candidates = await tx
    .select({ id: advancesTable.id, milestoneStatus: milestones.status, milestoneAmountMinor: milestones.amountMinor, decidedAt: milestones.decidedAt, currency: contractsTable.currency })
    .from(advancesTable)
    .innerJoin(milestones, eq(milestones.id, advancesTable.milestoneId))
    .innerJoin(contractsTable, eq(contractsTable.id, milestones.contractId))
    .where(and(eq(contractsTable.freelancerId, freelancerId), ne(advancesTable.milestoneId, m.id), inArray(advancesTable.status, ["funded", "shortfall"])));
  if (candidates.length === 0) return [];
  const info = new Map(candidates.map((c) => [c.id, c]));
  const locked = await tx.select().from(advancesTable).where(inArray(advancesTable.id, [...info.keys()])).orderBy(advancesTable.id).for("update");
  const heldRefs = locked.filter((a) => info.get(a.id)?.milestoneStatus === "held").map((a) => ledgerRefs.refund(a.milestoneId));
  const refunds = heldRefs.length > 0 ? await tx.select({ ref: ledgerEntries.ref, amountMinor: ledgerEntries.amountMinor }).from(ledgerEntries).where(and(inArray(ledgerEntries.ref, heldRefs), eq(ledgerEntries.direction, "debit"))) : [];
  const refunded = (milestoneId: string) => refunds.filter((r) => r.ref === ledgerRefs.refund(milestoneId)).reduce((sum, r) => sum + r.amountMinor, 0);
  return locked
    .filter((a) => {
      const c = info.get(a.id);
      if (!c) return false;
      if (a.status === "shortfall") return true;
      if (a.status !== "funded") return false;
      if (c.milestoneStatus === "released" || c.milestoneStatus === "partial_released") return true;
      return c.milestoneStatus === "held" && refunded(a.milestoneId) >= c.milestoneAmountMinor;
    })
    .sort((x, y) => (x.fundedAt?.getTime() ?? 0) - (y.fundedAt?.getTime() ?? 0) || x.id.localeCompare(y.id))
    .map((a) => ({ a, decidedAt: info.get(a.id)!.decidedAt, currency: info.get(a.id)!.currency }));
}

/**
 * What other payout claims already sent (but whose partner item has not settled, so not in the ledger yet) are about
 * to repay on these advances, per advance id. Only ops whose claim names one of the advances are read.
 */
async function inFlightRepayments(tx: Tx, milestoneId: string, advanceIds: readonly string[]): Promise<Map<string, number>> {
  const ids = JSON.stringify({ ids: advanceIds });
  const sent = await tx
    .select({ request: paypalOps.request, response: paypalOps.response })
    .from(paypalOps)
    .where(
      and(
        eq(paypalOps.kind, OP_KINDS.payout),
        eq(paypalOps.status, "sent"),
        ne(paypalOps.key, milestoneId),
        sql`jsonb_path_exists(${paypalOps.request}, ${"$.claim.advances[*] ? (@.advanceId == $ids[*])"}::jsonpath, ${ids}::jsonb)`,
      ),
    );
  const inFlight = new Map<string, number>();
  for (const op of sent) {
    if (itemOutcomes(op.response).partner) continue;
    const c = parseClaim(op.request);
    if (!c) continue;
    allocateRepayment(c.shares.partnerShareMinor, c.advances).forEach((x, i) => {
      const id = c.advances[i]!.advanceId;
      inFlight.set(id, (inFlight.get(id) ?? 0) + x.principalMinor + x.feeMinor);
    });
  }
  return inFlight;
}

/**
 * Everything the freelancer still owes capital partners, as of this claim: this milestone's own advance (funded or
 * shortfall; serialized by the milestone lock, which the advance job and settle take too, so not locked again here)
 * and the carried ones (carriedAdvances). Each balance comes from the ledger (advance:<id> debit minus the repayment
 * credits booked for it) plus the unpaid part of its fee, netted against in-flight claims (netDues). "operator" when
 * the state cannot be trusted.
 */
async function owedAdvances(tx: Tx, m: MilestoneRow, freelancerId: string, currency: string): Promise<Owed> {
  const own = await tx.select().from(advancesTable).where(eq(advancesTable.milestoneId, m.id)).orderBy(advancesTable.id);
  const unconfirmed = await unconfirmedOwnAdvance(tx, own);
  if (unconfirmed) return unconfirmed;

  const open: OpenAdvance[] = [
    ...own.filter((a) => a.status === "funded" || a.status === "shortfall").map((a) => ({ a, decidedAt: m.decidedAt, currency })),
    ...(await carriedAdvances(tx, m, freelancerId)),
  ];
  if (open.length === 0) return { kind: "ok", partnerId: null, dues: [], blocked: [] };

  const inFlight = await inFlightRepayments(tx, m.id, open.map(({ a }) => a.id));
  const balances = await loadAdvanceBalances(tx, open.map(({ a }) => ({ id: a.id, milestoneId: a.milestoneId, partnerId: a.partnerId })));
  const dues: OpenDue[] = [];
  for (const { a, decidedAt, currency: cur } of open) {
    const bal = balances.get(a.id);
    if (!bal || bal.fundedMinor <= 0) return { kind: "operator", reason: `advance ${a.id} is ${a.status} but its funding is not in the ledger`, detail: { advanceId: a.id } };
    dues.push({ advanceId: a.id, milestoneId: a.milestoneId, partnerId: a.partnerId, currency: cur, ...remainingOwed(bal, advanceRepayment(a, decidedAt).feeMinor) });
  }
  return { kind: "ok", ...netDues(dues, inFlight, currency) };
}

/** Claims a paypal_ops row for this release ("sent" with the claim) and checks it is this claim's. */
async function claimReleaseOp(tx: Tx, kind: typeof OP_KINDS.payout | typeof OP_KINDS.refund, key: string, claim: ReleaseClaim): Promise<void> {
  const row = await claimOp(tx, kind, key, { claim });
  if (row.status !== "sent" || parseClaim(row.request)?.deliveryId !== claim.deliveryId) throw new Error(`could not claim ${kind} op ${key}`);
}

/**
 * Stores PayPal's answer. The PayPal id is always written (R8), whatever the op's status; the status only moves while the
 * op is still sent; per-item outcomes and reversals the settle job may already have written are kept.
 */
async function recordResponse(db: Db, kind: string, key: string, set: { paypalId?: string; status?: "failed" | "succeeded"; response: unknown }): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key))).for("update");
    if (!row) return;
    const prev = asRecord(row.response);
    const response = { ...asRecord(set.response), ...(prev.items ? { items: prev.items } : {}), ...(prev.reversals ? { reversals: prev.reversals } : {}), ...(prev.webhook ? { webhook: prev.webhook } : {}) };
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
    await flagNeedsOperator(tx, m, { actor: "paypal", reason, detail });
  });
}

// ---------- Job ----------

interface Claimed {
  claim: ReleaseClaim;
  contractId: string;
}

/** The claiming job's lease expired: this job takes the claim over (same ops, same PayPal-Request-Ids). */
async function takeOverLease(tx: Tx, previous: ReleaseClaim, ops: readonly OpRow[], jobId: string, now: Date): Promise<ReleaseClaim> {
  const claim: ReleaseClaim = { ...previous, jobId, claimedAt: now.toISOString() };
  for (const op of ops) {
    if (op.status === "sent" && !op.paypalId && parseClaim(op.request)?.deliveryId === claim.deliveryId) {
      await tx.update(paypalOps).set({ request: { ...asRecord(op.request), claim }, updatedAt: now }).where(and(eq(paypalOps.id, op.id), eq(paypalOps.status, "sent")));
    }
  }
  return claim;
}

/** Pure. The claim for a new release: the shares, the advances the partner share actually repays, and the refund. */
function buildClaim(input: {
  deliveryId: string;
  outcome: PolicyDecision;
  milestoneAmountMinor: number;
  currency: string;
  captureId: string;
  freelancerEmail: string;
  partnerEmail: string | null;
  shares: ReleaseClaim["shares"];
  dues: readonly ClaimAdvance[];
  jobId: string;
  now: Date;
}): ReleaseClaim {
  const { shares, dues, outcome } = input;
  const allocation = allocateRepayment(shares.partnerShareMinor, dues);
  return {
    deliveryId: input.deliveryId,
    action: outcome.action === "partial" ? "partial" : "release",
    ruleIds: outcome.ruleIds,
    reason: outcome.reason,
    releaseMinor: shares.partnerShareMinor + shares.freelancerShareMinor,
    refundMinor: Math.max(0, input.milestoneAmountMinor - outcome.amountMinor),
    currency: input.currency,
    captureId: input.captureId,
    freelancerEmail: input.freelancerEmail,
    partnerEmail: input.partnerEmail,
    shares,
    advances: dues.filter((_, i) => allocation[i]!.principalMinor + allocation[i]!.feeMinor > 0),
    jobId: input.jobId,
    claimedAt: input.now.toISOString(),
  };
}

/**
 * Locks the milestone, applies the one-attempt gate, checks the job is still current and the client has not stopped it,
 * and claims the paypal_ops rows (status "sent") in the same transaction. The review route takes the same lock and
 * refuses veto / hold once a claimed op exists, so a veto either lands before the claim (and this job skips) or is refused.
 */
async function claimRelease(db: Db, milestoneId: string, jobDeliveryId: string | null, jobId: string, now: Date): Promise<Claimed | null> {
  return db.transaction(async (tx) => {
    const [m] = await tx.select().from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!m) throw new Error(`milestone ${milestoneId} not found`);
    const note = async (event: string, reason: string, extra: Record<string, unknown> = {}) => {
      await audit(tx, { actor: "system", event, milestoneId, contractId: m.contractId, detail: { reason, jobDeliveryId, status: m.status, ...extra } });
      return null;
    };
    const skip = (reason: string, extra: Record<string, unknown> = {}) => note(AUDIT_EVENTS.releaseSkipped, reason, extra);
    const flag = async (reason: string, detail: Record<string, unknown>) => {
      await flagNeedsOperator(tx, m, { actor: "system", reason, detail: { ...detail, deliveryId: jobDeliveryId } });
      return null;
    };
    // A milestone the showcase seed recorded with simulator ids, on the real sandbox: its capture never existed at
    // PayPal, so a payout would pay out money that was never captured and a refund would fail after it. Nothing is
    // claimed and nothing changes; the page shows the milestone as recorded for the showcase.
    if (recordedForShowcase(m)) return note(AUDIT_EVENTS.releaseRefusedRecorded, RECORDED_SHOWCASE_TEXT, { paypalCaptureId: m.paypalCaptureId, paypalOrderId: m.paypalOrderId });
    const decId = decisionDeliveryId(m.decision);
    const ops = await releaseOps(tx, milestoneId);
    const opList = [ops.payout, ops.refund].filter((o): o is OpRow => o !== undefined);

    const gate = releaseGate({ jobDeliveryId, decisionDeliveryId: decId, status: m.status, needsOperator: await isFlaggedForOperator(tx, milestoneId), ops: opList, jobId, now });
    if (gate.kind === "refuse") return note(AUDIT_EVENTS.releaseRefusedNeedsOperator, gate.reason, { ops: opList.map((o) => ({ kind: o.kind, status: o.status, paypalId: o.paypalId })) });
    if (gate.kind === "skip") return skip(gate.reason);
    if (gate.kind === "in_flight") return note(AUDIT_EVENTS.releaseSkippedInFlight, gate.reason, { jobId, claimJobId: gate.claim.jobId, claimedAt: gate.claim.claimedAt });
    if (gate.kind === "resume") {
      if (!gate.takeover) return { claim: gate.claim, contractId: m.contractId };
      const claim = await takeOverLease(tx, gate.claim, opList, jobId, now);
      await note(AUDIT_EVENTS.releaseLeaseTakenOver, "the claiming job's lease expired", { jobId, previousJobId: gate.claim.jobId, previousClaimedAt: gate.claim.claimedAt });
      return { claim, contractId: m.contractId };
    }

    // Dispute guard: while the buyer's PayPal dispute is open, nothing is claimed. Paying out now could pay the money
    // twice (PayPal refunds the buyer if the claim is accepted or lost). A milestone in review is held; it waits for an
    // operator, as any held milestone does.
    const disputes = await openDisputesFor(tx, milestoneId);
    if (disputes.length > 0) {
      if (m.status === "review") await transition(tx, milestoneId, "held", { actor: "system", event: AUDIT_EVENTS.milestoneHeld, detail: { reason: "a PayPal dispute on this milestone is open", disputeIds: disputes } });
      return note(AUDIT_EVENTS.releaseBlockedByDispute, "a PayPal dispute on this milestone is open", { disputeIds: disputes });
    }

    const stored = parseDecision(m.decision);
    if (!stored) return skip("milestone has no policy decision");
    const outcome = clientOutcome(stored, m, now);
    if (outcome.action === "hold") {
      await transition(tx, milestoneId, "held", { actor: "policy", event: AUDIT_EVENTS.milestoneHeld, detail: { reason: outcome.reason, ruleIds: outcome.ruleIds, deliveryId: jobDeliveryId } });
      return null;
    }
    if (outcome.action === "ask_client") {
      await audit(tx, { actor: "policy", event: AUDIT_EVENTS.releaseWaiting, milestoneId, contractId: m.contractId, detail: { reason: outcome.reason, ruleIds: outcome.ruleIds, deliveryId: jobDeliveryId } });
      return null;
    }
    if (m.status === "needs_client" && decId) {
      // The client cannot approve past a required criterion that did not pass.
      const delivery = await tx.query.deliveries.findFirst({ columns: { verdict: true }, where: (d, { eq }) => eq(d.id, decId) });
      const rows = await tx.query.criteria.findMany({ where: (c, { eq }) => eq(c.milestoneId, milestoneId) });
      const blocked = requiredNotPassed(delivery?.verdict, rows);
      if (blocked.length > 0) return skip("required criteria did not pass", { criteria: blocked });
    }

    const contract = await tx.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
    if (!contract) throw new Error(`contract ${m.contractId} not found`);
    const freelancerEmail = payoutReceiver(await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) }));
    if (!freelancerEmail) throw new Error(`freelancer ${contract.freelancerId} has no PayPal email`);
    if (!m.paypalCaptureId) throw new Error(`milestone ${milestoneId} has no PayPal capture id`);

    // The partner is repaid first: this milestone's advance and any balance carried from the freelancer's earlier ones.
    const owed = await owedAdvances(tx, m, contract.freelancerId, contract.currency);
    if (owed.kind === "operator") return flag(owed.reason, owed.detail);
    const owedMinor = owed.dues.reduce((sum, d) => sum + d.principalMinor + d.feeMinor, 0);
    let partnerEmail: string | null = null;
    if (owedMinor > 0 && owed.partnerId) {
      const partnerId = owed.partnerId;
      partnerEmail = payoutReceiver(await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, partnerId) }));
      if (!partnerEmail) return flag(`capital partner ${partnerId} has no PayPal email; the advance cannot be repaid`, { partnerId, owedMinor });
    }

    const shares = payoutShares(outcome.amountMinor, owedMinor);
    if (owed.blocked.length > 0 && shares.freelancerShareMinor > 0) {
      // The freelancer is never paid while any balance is unpaid, and one payout can repay only one partner.
      return flag("the freelancer still owes advance balances that this payout cannot repay (another capital partner or currency)", { blocked: owed.blocked });
    }
    const claim = buildClaim({
      deliveryId: jobDeliveryId!,
      outcome,
      milestoneAmountMinor: m.amountMinor,
      currency: contract.currency,
      captureId: m.paypalCaptureId,
      freelancerEmail,
      partnerEmail,
      shares,
      dues: owed.dues,
      jobId,
      now,
    });
    if (claim.releaseMinor === 0 && claim.refundMinor === 0) return skip("nothing to pay or refund");

    // Both ops are claimed before any PayPal call, so a retry of this job can finish either and nothing else can start one.
    if (claim.releaseMinor > 0) await claimReleaseOp(tx, OP_KINDS.payout, milestoneId, claim);
    if (claim.refundMinor > 0) await claimReleaseOp(tx, OP_KINDS.refund, milestoneId, claim);
    await audit(tx, { actor: "policy", event: AUDIT_EVENTS.releaseClaimed, milestoneId, contractId: m.contractId, detail: { ...claim } });
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

  const claimed = await claimRelease(db, milestoneId, jobDeliveryId, job.id, clock());
  if (!claimed) return;
  const { claim, contractId } = claimed;
  const ctx = moneyContextFor(db, paypal());
  const lastAttempt = isLastAttempt(job);
  /** Retries (throws) a transient failure; records a final one as failed and flags an operator. Returns only when final. */
  const fail = async (kind: typeof OP_KINDS.payout | typeof OP_KINDS.refund, err: unknown): Promise<void> => {
    const error = err instanceof Error ? err.message : String(err);
    const httpStatus = err instanceof PayPalError ? err.status : null;
    const final = paypalFailure(err, lastAttempt);
    await audit(db, { actor: "paypal", event: kind === OP_KINDS.payout ? AUDIT_EVENTS.paypalPayoutError : AUDIT_EVENTS.paypalRefundError, milestoneId, contractId, detail: { deliveryId: claim.deliveryId, error, httpStatus, final, retryCount: job.retryCount ?? null } });
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
      return fail(OP_KINDS.payout, err);
    }
    const batch = results.payout?.batch_header;
    const denied = batch?.batch_status === "DENIED";
    // Recorded before the refund call, so a failing refund never loses the payout result.
    await recordResponse(db, OP_KINDS.payout, milestoneId, {
      ...(batch?.payout_batch_id ? { paypalId: batch.payout_batch_id } : {}),
      ...(denied ? { status: "failed" as const } : {}),
      response: results.payout ?? {},
    });
    await audit(db, {
      actor: "paypal",
      event: AUDIT_EVENTS.paypalPayout,
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
      return fail(OP_KINDS.refund, err);
    }
    const r = results.refund;
    const status = r?.status === "COMPLETED" ? "succeeded" : r?.status === "FAILED" || r?.status === "CANCELLED" ? "failed" : undefined;
    await recordResponse(db, OP_KINDS.refund, milestoneId, { ...(r?.id ? { paypalId: r.id } : {}), ...(status ? { status } : {}), response: r ?? {} });
    await audit(db, {
      actor: "paypal",
      event: AUDIT_EVENTS.paypalRefund,
      milestoneId,
      contractId,
      detail: { refundId: r?.id ?? null, refundStatus: r?.status ?? null, refundMinor: claim.refundMinor, currency: claim.currency, deliveryId: claim.deliveryId },
    });
    if (status === "failed") await flagFromJob(db, milestoneId, `PayPal refund ${r?.status ?? "failed"}`, { refundId: r?.id ?? null });
  }
}
