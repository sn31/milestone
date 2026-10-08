import type { Job } from "pg-boss";
import { and, eq, inArray } from "drizzle-orm";
import { accounts, advances, audit, ledgerEntries, milestones, paypalOps, postTransaction, recordOpResult, requestIdFor, type Db, type MilestoneStatus } from "@milestone/core";
import { fundAdvance, type MoneyContext, type PayPalClient } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { partnerPaypal } from "../lib/partner-paypal.ts";
import { isLastAttempt, paypalFailure } from "./release.ts";

/** The op kind fundAdvance uses; its key is the advance id. */
export const ADVANCE_OP_KIND = "advance-payout";
/** Milestone states in which an accepted advance may still be paid out (nothing has been released yet). */
export const FUNDABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["funded", "verifying"]);
export const advanceLedgerRef = (advanceId: string) => `advance:${advanceId}`;

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

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

/**
 * Pays an accepted advance out of the capital partner's PayPal account and opens the receivable.
 *
 * Everything happens under SELECT ... FOR UPDATE on the milestone row, the lock the release job takes before it claims
 * the payout: a release either claims first (then this job withdraws the offer and pays nothing) or sees the advance
 * funded and repays the partner first. The PayPal call is made inside that lock with the PayPal-Request-Id of the
 * advance's paypal_ops row, so a retry after a crash replays the same id and PayPal cannot pay twice; a retry after
 * success finds the advance funded and sends nothing. The ledger entry (debit partner receivable, credit partner cash,
 * ref advance:<id>) is posted once, guarded by its ref, in the same transaction as the status change.
 */
export async function advance(job: Job<JobData>, deps: AdvanceDeps = {}): Promise<void> {
  const db = getDb();
  const clock = deps.clock ?? (() => new Date());
  const advanceId = str(job.data.advanceId);
  if (!advanceId) {
    await audit(db, { actor: "system", event: "advance.skipped", milestoneId: job.data.milestoneId, detail: { reason: "job has no advanceId", jobId: job.id } });
    return;
  }
  const a = await db.query.advances.findFirst({ where: (t, { eq }) => eq(t.id, advanceId) });
  if (!a) {
    await audit(db, { actor: "system", event: "advance.skipped", milestoneId: job.data.milestoneId, detail: { reason: "advance not found", advanceId } });
    return;
  }
  if (a.status !== "offered") return; // already funded (or repaid): a retry, nothing to send

  const partner = (deps.partner ?? partnerPaypal)();
  const ctx: MoneyContext = { client: partner, requestIdFor: (kind, key) => requestIdFor(db, kind, key) };

  let outcome: Outcome;
  try {
    outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const t = tx as unknown as Db;
      const [adv] = await tx.select().from(advances).where(eq(advances.id, advanceId)).for("update");
      if (!adv) return { kind: "done", reason: "advance disappeared" };
      const [m] = await tx.select().from(milestones).where(eq(milestones.id, adv.milestoneId)).for("update");
      if (!m) throw new Error(`milestone ${adv.milestoneId} not found`);
      const base = { milestoneId: m.id, contractId: m.contractId } as const;
      if (adv.status !== "offered") return { kind: "done", reason: `advance is ${adv.status}` };

      const [op] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, ADVANCE_OP_KIND), eq(paypalOps.key, adv.id))).for("update");
      if (op?.status === "failed") {
        await audit(t, { ...base, actor: "system", event: "advance.refused", detail: { advanceId: adv.id, reason: "an earlier payout for this advance failed; an operator must resolve it" } });
        return { kind: "operator", reason: "earlier payout failed" };
      }

      const contract = await tx.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
      if (!contract) throw new Error(`contract ${m.contractId} not found`);
      const freelancer = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) });

      // Never pay an advance the release could no longer repay.
      const releaseClaimed = await tx
        .select({ id: paypalOps.id })
        .from(paypalOps)
        .where(and(eq(paypalOps.key, m.id), inArray(paypalOps.kind, ["payout", "refund"]), inArray(paypalOps.status, ["sent", "succeeded", "failed"])))
        .limit(1);
      const refusal = !FUNDABLE_STATUSES.has(m.status)
        ? `milestone is ${m.status}`
        : releaseClaimed.length > 0
          ? "the release payout has already been claimed"
          : !freelancer?.paypalEmail
            ? "freelancer has no PayPal email"
            : null;
      if (refusal) {
        if (op && op.status !== "pending") {
          // A call was made for this advance before; PayPal may have paid it. A person decides.
          await audit(t, { ...base, actor: "system", event: "advance.needs_operator", detail: { advanceId: adv.id, reason: refusal, opStatus: op.status } });
          return { kind: "operator", reason: refusal };
        }
        await tx.delete(advances).where(and(eq(advances.id, adv.id), eq(advances.status, "offered")));
        await audit(t, { ...base, actor: "system", event: "advance.withdrawn", detail: { advanceId: adv.id, reason: refusal, principalMinor: adv.principalMinor, partnerId: adv.partnerId } });
        return { kind: "withdrawn", reason: refusal };
      }

      // Op row first (committed on its own connection), then the call with its request id.
      const rid = await requestIdFor(db, ADVANCE_OP_KIND, adv.id);
      let payoutBatchId = op?.status === "succeeded" ? op.paypalId : null;
      if (op?.status !== "succeeded") {
        await tx
          .update(paypalOps)
          .set({ status: "sent", request: { advanceId: adv.id, milestoneId: m.id, principalMinor: adv.principalMinor, currency: contract.currency, jobId: job.id ?? null }, updatedAt: clock() })
          .where(eq(paypalOps.requestId, rid));
        const batch = await fundAdvance(ctx, partner, adv.id, freelancer!.paypalEmail!, adv.principalMinor, contract.currency);
        payoutBatchId = batch.batch_header?.payout_batch_id ?? null;
        await recordOpResult(t, rid, { status: "succeeded", ...(payoutBatchId ? { paypalId: payoutBatchId } : {}), response: batch });
      }

      const ref = advanceLedgerRef(adv.id);
      const posted = await tx.select({ id: ledgerEntries.id }).from(ledgerEntries).where(eq(ledgerEntries.ref, ref)).limit(1);
      if (posted.length === 0) {
        await postTransaction(t, {
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
      await audit(t, {
        ...base,
        actor: "paypal",
        event: "advance.funded",
        detail: { advanceId: adv.id, partnerId: adv.partnerId, principalMinor: adv.principalMinor, currency: contract.currency, payoutBatchId, requestId: rid, offer: adv.offer },
      });
      return { kind: "funded", payoutBatchId };
    });
  } catch (err) {
    // The transaction rolled back; the op row (committed separately) keeps the request id for the retry.
    const final = paypalFailure(err, isLastAttempt(job as { retryCount?: unknown; retryLimit?: unknown }));
    const error = err instanceof Error ? err.message : String(err);
    await audit(db, { actor: "paypal", event: "paypal.advance_payout_error", milestoneId: a.milestoneId, detail: { advanceId, error, final, retryCount: job.retryCount ?? null } });
    if (!final) throw err;
    const [op] = await db.select().from(paypalOps).where(and(eq(paypalOps.kind, ADVANCE_OP_KIND), eq(paypalOps.key, advanceId))).limit(1);
    if (op) await recordOpResult(db, op.requestId, { status: "failed", response: { error: { message: error, final } } });
    await audit(db, { actor: "system", event: "advance.needs_operator", milestoneId: a.milestoneId, detail: { advanceId, reason: final === "rejected" ? "PayPal rejected the advance payout" : "the advance payout still failed on the last retry; PayPal may or may not have received it", error } });
    return;
  }
  if (outcome.kind === "funded") console.log(`[advance] ${advanceId} funded (batch ${outcome.payoutBatchId ?? "unknown"})`);
  else console.log(`[advance] ${advanceId} ${outcome.kind}: ${"reason" in outcome ? outcome.reason : ""}`);
}

