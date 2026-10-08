import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { and, eq, inArray, sql } from "drizzle-orm";
import { accounts, advances, audit, auditLog, ledgerEntries, milestones, paypalOps, postTransaction, recordOpResult, requestIdFor, type Db, type MilestoneStatus } from "@milestone/core";
import { fundAdvance, paypalMode, type MoneyContext, type PayPalClient } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { partnerPaypal } from "../lib/partner-paypal.ts";
import { isLastAttempt, paypalFailure } from "./release.ts";

/** The op kind fundAdvance uses; its key is the advance id. */
export const ADVANCE_OP_KIND = "advance-payout";
/** Milestone states in which an accepted advance may still be paid out (nothing has been released yet). */
export const FUNDABLE_STATUSES: ReadonlySet<MilestoneStatus> = new Set(["funded", "verifying"]);
export const advanceLedgerRef = (advanceId: string) => `advance:${advanceId}`;
export const ADVANCE_NEEDS_OPERATOR_EVENT = "advance.needs_operator";

/** Whether this advance was ever flagged for an operator; once flagged, the job never acts on it again. */
export async function isAdvanceFlagged(q: Db, advanceId: string): Promise<boolean> {
  const [row] = await q
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(and(eq(auditLog.event, ADVANCE_NEEDS_OPERATOR_EVENT), sql`${auditLog.detail}->>'advanceId' = ${advanceId}`))
    .limit(1);
  return row !== undefined;
}

/**
 * Claims the advance's paypal_ops row as "sent" on its own connection, so the claim is committed before the PayPal
 * call whatever happens to the caller's transaction (as release.ts claimOp). A row that already exists keeps its
 * request id; a never-sent "pending" row moves to "sent". Returns the request id.
 */
async function claimAdvanceOp(db: Db, advanceId: string, request: Record<string, unknown>, now: Date): Promise<string> {
  await db
    .insert(paypalOps)
    .values({ id: randomUUID(), kind: ADVANCE_OP_KIND, key: advanceId, requestId: randomUUID(), status: "sent", request, updatedAt: now })
    .onConflictDoUpdate({ target: [paypalOps.kind, paypalOps.key], set: { status: "sent", request, updatedAt: now }, setWhere: eq(paypalOps.status, "pending") });
  const [row] = await db.select().from(paypalOps).where(and(eq(paypalOps.kind, ADVANCE_OP_KIND), eq(paypalOps.key, advanceId)));
  if (row?.status !== "sent" && row?.status !== "succeeded") throw new Error(`could not claim advance op ${advanceId} (status ${row?.status ?? "missing"})`);
  return row.requestId;
}

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

  let partner: PayPalClient;
  try {
    partner = (deps.partner ?? partnerPaypal)();
  } catch (err) {
    // Configuration (no partner credentials outside simulated mode): nothing was claimed or sent; pg-boss retries.
    await audit(db, { actor: "system", event: "advance.config_error", milestoneId: a.milestoneId, detail: { advanceId, error: err instanceof Error ? err.message : String(err) } });
    throw err;
  }
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

      // Not locked here: the claim below writes this row on another connection.
      const [op] = await tx.select().from(paypalOps).where(and(eq(paypalOps.kind, ADVANCE_OP_KIND), eq(paypalOps.key, adv.id)));
      if (op?.status === "failed") {
        await audit(t, { ...base, actor: "system", event: "advance.refused", detail: { advanceId: adv.id, reason: "an earlier payout for this advance failed; an operator must resolve it" } });
        return { kind: "operator", reason: "earlier payout failed" };
      }
      if (await isAdvanceFlagged(t, adv.id)) {
        await audit(t, { ...base, actor: "system", event: "advance.refused", detail: { advanceId: adv.id, reason: "the advance was flagged for an operator; the job never acts on it again", opStatus: op?.status ?? null } });
        return { kind: "operator", reason: "flagged for an operator" };
      }

      const contract = await tx.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, m.contractId) });
      if (!contract) throw new Error(`contract ${m.contractId} not found`);
      const freelancer = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, contract.freelancerId) });
      const partnerUser = await tx.query.users.findFirst({ where: (u, { eq }) => eq(u.id, adv.partnerId) });

      // Never pay an advance the release could no longer repay.
      const releaseClaimed = await tx
        .select({ id: paypalOps.id })
        .from(paypalOps)
        .where(and(eq(paypalOps.key, m.id), inArray(paypalOps.kind, ["payout", "refund"]), inArray(paypalOps.status, ["sent", "succeeded", "failed"])))
        .limit(1);
      // The release repays the partner by payout to this address (simulated PayPal pays the account email, as release.ts).
      const noPartnerEmail = !(partnerUser?.paypalEmail ?? (paypalMode() === "simulated" ? partnerUser?.email : null));
      const refusal =
        op?.status === "succeeded"
          ? null // PayPal already paid it: record the receivable whatever the milestone does now
          : !FUNDABLE_STATUSES.has(m.status)
            ? `milestone is ${m.status}`
            : releaseClaimed.length > 0
              ? "the release payout has already been claimed"
              : !freelancer?.paypalEmail
                ? "freelancer has no PayPal email"
                : noPartnerEmail
                  ? "the capital partner has no PayPal email, so the release could not repay it"
                  : null;
      if (refusal) {
        if (op || noPartnerEmail) {
          // op: the payout was claimed before, PayPal may have paid it, so it is never withdrawn. A person decides.
          await audit(t, { ...base, actor: "system", event: ADVANCE_NEEDS_OPERATOR_EVENT, detail: { advanceId: adv.id, reason: refusal, opStatus: op?.status ?? null, partnerId: adv.partnerId } });
          return { kind: "operator", reason: refusal };
        }
        await tx.delete(advances).where(and(eq(advances.id, adv.id), eq(advances.status, "offered")));
        await audit(t, { ...base, actor: "system", event: "advance.withdrawn", detail: { advanceId: adv.id, reason: refusal, principalMinor: adv.principalMinor, partnerId: adv.partnerId } });
        return { kind: "withdrawn", reason: refusal };
      }

      let payoutBatchId = op?.status === "succeeded" ? op.paypalId : null;
      let rid = op?.requestId ?? null;
      if (op?.status !== "succeeded") {
        // The claim commits on its own connection before the call; the call runs under the milestone lock.
        rid = await claimAdvanceOp(db, adv.id, { advanceId: adv.id, milestoneId: m.id, principalMinor: adv.principalMinor, currency: contract.currency, jobId: job.id ?? null }, clock());
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
    // The transaction rolled back; the op row's "sent" claim (committed separately) keeps the request id for the retry.
    const final = paypalFailure(err, isLastAttempt(job as { retryCount?: unknown; retryLimit?: unknown }));
    const error = err instanceof Error ? err.message : String(err);
    await audit(db, { actor: "paypal", event: "paypal.advance_payout_error", milestoneId: a.milestoneId, detail: { advanceId, error, final, retryCount: job.retryCount ?? null } });
    if (!final) throw err;
    const [op] = await db.select().from(paypalOps).where(and(eq(paypalOps.kind, ADVANCE_OP_KIND), eq(paypalOps.key, advanceId))).limit(1);
    if (op) await recordOpResult(db, op.requestId, { status: "failed", response: { error: { message: error, final } } });
    await audit(db, { actor: "system", event: ADVANCE_NEEDS_OPERATOR_EVENT, milestoneId: a.milestoneId, detail: { advanceId, reason: final === "rejected" ? "PayPal rejected the advance payout" : "the advance payout still failed on the last retry; PayPal may or may not have received it", error, final } });
    return;
  }
  if (outcome.kind === "funded") console.log(`[advance] ${advanceId} funded (batch ${outcome.payoutBatchId ?? "unknown"})`);
  else console.log(`[advance] ${advanceId} ${outcome.kind}: ${"reason" in outcome ? outcome.reason : ""}`);
}
