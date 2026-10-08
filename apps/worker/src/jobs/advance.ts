import type { Job } from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import {
  AUDIT_EVENTS,
  OP_KINDS,
  accounts,
  advances,
  asString,
  audit,
  claimOp,
  hasAudit,
  ledgerEntries,
  ledgerRefs,
  milestones,
  paypalOps,
  payoutReceiver,
  postTransaction,
  recordOpResult,
  type MilestoneStatus,
} from "@milestone/core";
import { fundAdvance, moneyContextFor, type PayPalClient } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { partnerPaypal } from "../lib/partner-paypal.ts";
import { isLastAttempt, paypalFailure } from "./retry.ts";

/** Milestone states in which an accepted advance may still be paid out (nothing has been released yet). */
export const FUNDABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["funded", "verifying"]);

export interface AdvanceDeps {
  /** The capital partner's PayPal client; defaults to lib/partner-paypal.ts. */
  partner?: () => PayPalClient;
  clock?: () => Date;
}

type Outcome =
  | { kind: "funded"; payoutBatchId: string | null }
  | { kind: "done"; reason: string }
  | { kind: "withdrawn"; reason: string }
  | { kind: "operator"; reason: string };

/**
 * Why the advance must not be paid out now, one rule at a time, or null when it may be. An advance PayPal already
 * paid is never refused: its receivable is recorded whatever the milestone does now.
 */
export function refusalReason(r: {
  opStatus: string | null;
  milestoneStatus: MilestoneStatus;
  releaseClaimed: boolean;
  freelancerPaypalEmail: string | null;
  partnerReceiver: string | null;
}): string | null {
  if (r.opStatus === "succeeded") return null;
  if (!FUNDABLE_STATUSES.has(r.milestoneStatus)) return `milestone is ${r.milestoneStatus}`;
  // Never pay an advance the release could no longer repay.
  if (r.releaseClaimed) return "the release payout has already been claimed";
  if (!r.freelancerPaypalEmail) return "freelancer has no PayPal email";
  // The release repays the partner by payout to this address.
  if (!r.partnerReceiver) return "the capital partner has no PayPal email, so the release could not repay it";
  return null;
}

/**
 * Pays an accepted advance out of the capital partner's PayPal account and opens the receivable.
 *
 * Everything happens under SELECT ... FOR UPDATE on the advance and milestone rows, the milestone lock being the one the
 * release job takes before it claims the payout: a release either claims first (then this job pays nothing) or sees the
 * advance funded and repays the partner first. Before the PayPal call the advance's paypal_ops row is claimed as "sent"
 * on a separate connection, so the claim survives a rollback (a timeout, a crash): from then on the advance is never
 * withdrawn, because PayPal may have paid it. A retry that still finds the milestone fundable replays the same
 * PayPal-Request-Id (PayPal cannot pay twice); a retry that finds it no longer fundable flags advance.needs_operator,
 * and once flagged the job never acts on the advance again. The ledger entry (debit partner receivable, credit partner
 * cash, ref advance:<id>) is posted once, guarded by its ref, in the same transaction as the status change.
 */
export async function advance(job: Job<JobData>, deps: AdvanceDeps = {}): Promise<void> {
  const db = getDb();
  const clock = deps.clock ?? (() => new Date());
  const advanceId = asString(job.data.advanceId);
  if (!advanceId) {
    await audit(db, { actor: "system", event: AUDIT_EVENTS.advanceSkipped, milestoneId: job.data.milestoneId, detail: { reason: "job has no advanceId", jobId: job.id } });
    return;
  }
  const a = await db.query.advances.findFirst({ where: (t, { eq }) => eq(t.id, advanceId) });
  if (!a) {
    await audit(db, { actor: "system", event: AUDIT_EVENTS.advanceSkipped, milestoneId: job.data.milestoneId, detail: { reason: "advance not found", advanceId } });
    return;
  }
  if (a.status !== "offered") return; // already funded (or repaid): a retry, nothing to send

  let partner: PayPalClient;
  try {
    partner = (deps.partner ?? partnerPaypal)();
  } catch (err) {
    // Configuration (no partner credentials outside simulated mode): nothing was claimed or sent; pg-boss retries.
    await audit(db, { actor: "system", event: AUDIT_EVENTS.advanceConfigError, milestoneId: a.milestoneId, detail: { advanceId, error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
  const ctx = moneyContextFor(db, partner);

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [adv] = await tx.select().from(advances).where(eq(advances.id, advanceId)).for("update");
      if (!adv) return { kind: "done", reason: "advance disappeared" };
      const [m] = await tx.select().from(milestones).where(eq(milestones.id, adv.milestoneId)).for("update");
      if (!m) throw new Error(`milestone ${adv.milestoneId} not found`);
      const base = { milestoneId: m.id, contractId: m.contractId } as const;
      if (adv.status !== "offered") return { kind: "done", reason: `advance is ${adv.status}` };

      // Not locked here: the claim below writes this row on another connection.
      const [op] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, OP_KINDS.advancePayout), eq(paypalOps.key, adv.id)));
      if (op?.status === "failed") {
        await audit(tx, { ...base, actor: "system", event: AUDIT_EVENTS.advanceRefused, detail: { advanceId: adv.id, reason: "an earlier payout for this advance failed; an operator must resolve it" } });
        return { kind: "operator", reason: "earlier payout failed" };
      }
      if (await hasAudit(tx, { event: AUDIT_EVENTS.advanceNeedsOperator, detail: ["advanceId", adv.id] })) {
        await audit(tx, { ...base, actor: "system", event: AUDIT_EVENTS.advanceRefused, detail: { advanceId: adv.id, reason: "the advance was flagged for an operator; the job never acts on it again", opStatus: op?.status ?? null } });
        return { kind: "operator", reason: "flagged for an operator" };
      }

      const contract = await tx.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
      if (!contract) throw new Error(`contract ${m.contractId} not found`);
      const freelancer = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) });
      const partnerReceiver = payoutReceiver(await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, adv.partnerId) }));
      const releaseClaimed = await tx
        .select({ id: paypalOps.id })
        .from(paypalOps)
        .where(and(eq(paypalOps.key, m.id), inArray(paypalOps.kind, [OP_KINDS.payout, OP_KINDS.refund]), inArray(paypalOps.status, ["sent", "succeeded", "failed"])))
        .limit(1);

      const refusal = refusalReason({ opStatus: op?.status ?? null, milestoneStatus: m.status, releaseClaimed: releaseClaimed.length > 0, freelancerPaypalEmail: freelancer?.paypalEmail ?? null, partnerReceiver });
      if (refusal) {
        if (op || !partnerReceiver) {
          // op: the payout was claimed before, PayPal may have paid it, so it is never withdrawn. A person decides.
          await audit(tx, { ...base, actor: "system", event: AUDIT_EVENTS.advanceNeedsOperator, detail: { advanceId: adv.id, reason: refusal, opStatus: op?.status ?? null, partnerId: adv.partnerId } });
          return { kind: "operator", reason: refusal };
        }
        await tx.delete(advances).where(and(eq(advances.id, adv.id), eq(advances.status, "offered")));
        await audit(tx, { ...base, actor: "system", event: AUDIT_EVENTS.advanceWithdrawn, detail: { advanceId: adv.id, reason: refusal, principalMinor: adv.principalMinor, partnerId: adv.partnerId } });
        return { kind: "withdrawn", reason: refusal };
      }

      let payoutBatchId = op?.status === "succeeded" ? op.paypalId : null;
      let rid = op?.requestId ?? null;
      if (op?.status !== "succeeded") {
        // The claim commits on its own connection (the pool) before the call; the call runs under the milestone lock.
        const request = { advanceId: adv.id, milestoneId: m.id, principalMinor: adv.principalMinor, currency: contract.currency, jobId: job.id };
        const claimed = await claimOp(db, OP_KINDS.advancePayout, adv.id, request, clock());
        if (claimed.status !== "sent" && claimed.status !== "succeeded") throw new Error(`could not claim advance op ${adv.id} (status ${claimed.status})`);
        rid = claimed.requestId;
        const batch = await fundAdvance(ctx, partner, adv.id, freelancer!.paypalEmail!, adv.principalMinor, contract.currency);
        payoutBatchId = batch.batch_header?.payout_batch_id ?? null;
        await recordOpResult(tx, rid, { status: "succeeded", ...(payoutBatchId ? { paypalId: payoutBatchId } : {}), response: batch });
      }

      const ref = ledgerRefs.advanceFunding(adv.id);
      const posted = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.ref, ref)).limit(1);
      if (posted.length === 0) {
        await postTransaction(tx, {
          ref,
          currency: contract.currency,
          entries: [
            { account: accounts.partnerReceivable(adv.partnerId), amountMinor: adv.principalMinor, direction: "debit" },
            { account: accounts.partnerCash(adv.partnerId), amountMinor: adv.principalMinor, direction: "credit" },
          ],
        });
      }
      const fundedAt = clock();
      await tx.update(advances).set({ status: "funded", fundedAt }).where(and(eq(advances.id, adv.id), eq(advances.status, "offered")));
      await audit(tx, {
        ...base,
        actor: "paypal",
        event: AUDIT_EVENTS.advanceFunded,
        detail: { advanceId: adv.id, partnerId: adv.partnerId, principalMinor: adv.principalMinor, currency: contract.currency, payoutBatchId, requestId: rid, offer: adv.offer },
      });
      return { kind: "funded", payoutBatchId };
    });
  } catch (err) {
    // The transaction rolled back; the op row's "sent" claim (committed separately) keeps the request id for the retry.
    const final = paypalFailure(err, isLastAttempt(job));
    const error = err instanceof Error ? err.message : String(err);
    await audit(db, { actor: "paypal", event: AUDIT_EVENTS.paypalAdvancePayoutError, milestoneId: a.milestoneId, detail: { advanceId, error, final, retryCount: job.retryCount ?? null } });
    if (!final) throw err;
    const [op] = await db.select({ requestId: paypalOps.requestId }).from(paypalOps).where(and(eq(paypalOps.kind, OP_KINDS.advancePayout), eq(paypalOps.key, advanceId))).limit(1);
    if (op) await recordOpResult(db, op.requestId, { status: "failed", response: { error: { message: error, final } } });
    await audit(db, { actor: "system", event: AUDIT_EVENTS.advanceNeedsOperator, milestoneId: a.milestoneId, detail: { advanceId, reason: final === "rejected" ? "PayPal rejected the advance payout" : "the advance payout still failed on the last retry; PayPal may or may not have received it", error, final } });
    return;
  }
  if (outcome.kind === "funded") console.log(`[advance] ${advanceId} funded (batch ${outcome.payoutBatchId ?? "unknown"})`);
  else console.log(`[advance] ${advanceId} ${outcome.kind}: ${outcome.reason}`);
}
