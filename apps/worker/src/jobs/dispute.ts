import type { Job } from "pg-boss";
import { audit, ledgerEntries, type Db } from "@milestone/core";
import { findOpenedDispute, getDispute, parseDispute } from "@milestone/money";
import { compileEvidencePack, draftResponse, type EvidencePack, type EvidencePackInput } from "@milestone/verify";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { paypal } from "../lib/paypal.ts";

/**
 * The dispute copilot's job, enqueued by the PayPal webhook on CUSTOMER.DISPUTE.CREATED with { milestoneId, disputeId }.
 * Builds the evidence pack from the milestone's own record, drafts the response, and stores both in the audit detail
 * of "dispute.drafted" (no schema change). Idempotent: a dispute is drafted once.
 */
export async function dispute(job: Job<JobData>): Promise<void> {
  const disputeId = typeof job.data.disputeId === "string" ? job.data.disputeId : null;
  if (!disputeId) throw new Error("dispute job needs disputeId");
  await draftDispute(getDb(), disputeId);
}

/** Loads the milestone's record as compileEvidencePack takes it. Exported for the e2e test and the page. */
export async function loadPackInput(db: Db, milestoneId: string, disputeInfo: EvidencePackInput["dispute"] = null): Promise<EvidencePackInput | null> {
  const milestone = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
  if (!milestone) return null;
  const contract = await db.query.contracts.findFirst({ where: (t, { eq }) => eq(t.id, milestone.contractId) });
  if (!contract) return null;
  // Deterministic checks first, judgment last (criteria have no position of their own).
  const kindOrder = ["test", "build", "file", "upload", "visual", "judgment"];
  const criteria = (await db.query.criteria.findMany({ where: (t, { eq }) => eq(t.milestoneId, milestone.id), orderBy: (t, { asc }) => [asc(t.id)] })).sort(
    (a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // The delivery the decision was made for; else the latest one.
  const decided = (milestone.decision as { deliveryId?: unknown } | null)?.deliveryId;
  const delivery =
    (typeof decided === "string" ? await db.query.deliveries.findFirst({ where: (t, { eq }) => eq(t.id, decided) }) : undefined) ??
    (await db.query.deliveries.findFirst({ where: (t, { eq }) => eq(t.milestoneId, milestone.id), orderBy: (t, { desc }) => [desc(t.receivedAt)] })) ??
    null;
  // The milestone's rows plus the contract-wide ones (signatures).
  const auditRows = await db.query.auditLog.findMany({
    where: (t, { and, eq, isNull, or }) => or(eq(t.milestoneId, milestone.id), and(eq(t.contractId, contract.id), isNull(t.milestoneId))),
  });
  // Every transaction that touched this milestone's escrow account, in full (both legs).
  const ledgerRows = await db.query.ledgerEntries.findMany({
    where: (t, { inArray, eq }) => inArray(t.txnId, db.select({ txnId: ledgerEntries.txnId }).from(ledgerEntries).where(eq(ledgerEntries.account, `held:${milestone.id}`))),
  });
  return { contract, milestone, criteria, delivery, auditRows, ledgerRows, dispute: disputeInfo };
}

export type DraftOutcome = { kind: "drafted"; pack: EvidencePack } | { kind: "already" } | { kind: "unknown" };

export async function draftDispute(db: Db, disputeId: string): Promise<DraftOutcome> {
  const opened = await findOpenedDispute(db, disputeId);
  if (!opened?.milestoneId) {
    console.warn(`[dispute] ${disputeId}: no dispute.opened row`);
    return { kind: "unknown" };
  }
  const already = await db.query.auditLog.findFirst({
    columns: { id: true },
    where: (t, { and, eq, sql }) => and(eq(t.event, "dispute.drafted"), sql`${t.detail}->>'disputeId' = ${disputeId}`),
  });
  if (already) return { kind: "already" };

  const detail = (opened.detail ?? {}) as { reason?: string | null; amountMinor?: number | null; currency?: string | null };
  let info: EvidencePackInput["dispute"] = { id: disputeId, reason: detail.reason ?? null, amountMinor: detail.amountMinor ?? null, currency: detail.currency ?? null };
  // PayPal's current view, when it answers; the webhook's copy is enough otherwise.
  try {
    const live = parseDispute(await getDispute(paypal(), disputeId));
    if (live) info = { id: disputeId, reason: live.reason ?? info.reason ?? null, amountMinor: live.amountMinor ?? info.amountMinor ?? null, currency: live.currency ?? info.currency ?? null };
  } catch (e) {
    console.warn(`[dispute] ${disputeId}: GET dispute failed, using the webhook's copy: ${e instanceof Error ? e.message : e}`);
  }

  const input = await loadPackInput(db, opened.milestoneId, info);
  if (!input) return { kind: "unknown" };
  const pack = compileEvidencePack(input);
  const draft = await draftResponse(pack);
  await audit(db, {
    actor: "verifier",
    event: "dispute.drafted",
    milestoneId: opened.milestoneId,
    ...(opened.contractId ? { contractId: opened.contractId } : {}),
    detail: { disputeId, packHash: pack.hash, pack, draft },
  });
  return { kind: "drafted", pack };
}
