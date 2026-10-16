import { createHash } from "node:crypto";
import type { Job } from "pg-boss";
import { AUDIT_EVENTS, accounts, asString, audit, decisionDeliveryId, ledgerEntries, loadMilestone, type Db } from "@milestone/core";
import { callPayPalTool, findOpenedDispute, getDispute, parseDispute, type DisputeEventInfo, type OpenPayPalMcpOptions } from "@milestone/money";
import { compileEvidencePack, draftResponse, type EvidencePack, type EvidencePackInput, type PackDispute } from "@milestone/verify";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { paypal } from "../lib/paypal.ts";

/**
 * The dispute copilot's job, enqueued by the PayPal webhook on CUSTOMER.DISPUTE.CREATED with { milestoneId, disputeId }.
 * Builds the evidence pack from the milestone's own record, drafts the response, and stores both in the audit detail
 * of "dispute.drafted" (no schema change) with their hashes; the activity page redacts both for everyone but the
 * contract's freelancer. Idempotent: a dispute is drafted once.
 */
export async function dispute(job: Job<JobData>): Promise<void> {
  const disputeId = asString(job.data.disputeId);
  if (!disputeId) throw new Error("dispute job needs disputeId");
  await draftDispute(getDb(), disputeId);
}

/** Loads the milestone's record as compileEvidencePack takes it. Exported for the e2e test and the page. */
export async function loadPackInput(db: Db, milestoneId: string, disputeInfo: EvidencePackInput["dispute"] = null): Promise<EvidencePackInput | null> {
  const loaded = await loadMilestone(db, milestoneId);
  if (!loaded) return null;
  const { milestone, contract } = loaded;
  // Deterministic checks first, judgment last (criteria have no position of their own).
  const kindOrder = ["test", "build", "file", "upload", "visual", "judgment"];
  const criteria = (await db.query.criteria.findMany({ where: (t, { eq }) => eq(t.milestoneId, milestone.id), orderBy: (t, { asc }) => [asc(t.id)] })).sort(
    (a, b) => kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  // The delivery the decision was made for; else the latest one.
  const decided = decisionDeliveryId(milestone.decision);
  const delivery =
    (decided ? await db.query.deliveries.findFirst({ where: (t, { eq }) => eq(t.id, decided) }) : undefined) ??
    (await db.query.deliveries.findFirst({ where: (t, { eq }) => eq(t.milestoneId, milestone.id), orderBy: (t, { desc }) => [desc(t.receivedAt)] })) ??
    null;
  // The milestone's rows plus the contract-wide ones (signatures).
  const auditRows = await db.query.auditLog.findMany({
    where: (t, { and, eq, isNull, or }) => or(eq(t.milestoneId, milestone.id), and(eq(t.contractId, contract.id), isNull(t.milestoneId))),
  });
  // Every transaction that touched this milestone's escrow account, in full (both legs).
  const ledgerRows = await db.query.ledgerEntries.findMany({
    where: (t, { inArray, eq }) => inArray(t.txnId, db.select({ txnId: ledgerEntries.txnId }).from(ledgerEntries).where(eq(ledgerEntries.account, accounts.held(milestone.id)))),
  });
  return { contract, milestone, criteria, delivery, auditRows, ledgerRows, dispute: disputeInfo };
}

/**
 * PayPal's current view of the dispute: get_dispute through PayPal's MCP server (read-only, allowlisted), falling back
 * to REST on any error, then to the webhook's copy. The path used (and why the MCP read was not) goes into the pack.
 */
export async function readDispute(disputeId: string, webhookCopy: PackDispute, mcp: OpenPayPalMcpOptions = {}): Promise<PackDispute> {
  const merge = (live: DisputeEventInfo | null, readVia: NonNullable<PackDispute["readVia"]>, readFallback: string | null): PackDispute | null =>
    live
      ? { id: disputeId, reason: live.reason ?? webhookCopy.reason ?? null, amountMinor: live.amountMinor ?? webhookCopy.amountMinor ?? null, currency: live.currency ?? webhookCopy.currency ?? null, readVia, ...(readFallback ? { readFallback } : {}) }
      : null;
  let fallback: string;
  try {
    const res = await callPayPalTool("get_dispute", { dispute_id: disputeId }, mcp);
    const got = merge(parseDispute(res.data), res.simulated ? "simulated_mcp" : "paypal_mcp", null);
    if (got) return got;
    fallback = "get_dispute returned no dispute";
  } catch (e) {
    fallback = `MCP get_dispute failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 300);
    console.warn(`[dispute] ${disputeId}: ${fallback}; trying REST`);
  }
  try {
    const got = merge(parseDispute(await getDispute(paypal(), disputeId)), "rest", fallback);
    if (got) return got;
  } catch (e) {
    console.warn(`[dispute] ${disputeId}: GET dispute failed, using the webhook's copy: ${e instanceof Error ? e.message : e}`);
  }
  return { ...webhookCopy, readVia: "webhook", readFallback: fallback };
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
    where: (t, { and, eq, sql }) => and(eq(t.event, AUDIT_EVENTS.disputeDrafted), sql`${t.detail}->>'disputeId' = ${disputeId}`),
  });
  if (already) return { kind: "already" };

  const detail = (opened.detail ?? {}) as { reason?: string | null; amountMinor?: number | null; currency?: string | null };
  const webhookCopy: PackDispute = { id: disputeId, reason: detail.reason ?? null, amountMinor: detail.amountMinor ?? null, currency: detail.currency ?? null };
  const info = await readDispute(disputeId, webhookCopy);

  const input = await loadPackInput(db, opened.milestoneId, info);
  if (!input) return { kind: "unknown" };
  const pack = compileEvidencePack(input);
  const draft = await draftResponse(pack);
  await audit(db, {
    actor: "verifier",
    event: AUDIT_EVENTS.disputeDrafted,
    milestoneId: opened.milestoneId,
    ...(opened.contractId ? { contractId: opened.contractId } : {}),
    // The pack and draft are the freelancer's working copy: the activity page shows anyone else only these hashes.
    detail: { disputeId, packHash: pack.hash, draftHash: createHash("sha256").update(JSON.stringify(draft)).digest("hex"), pack, draft },
  });
  return { kind: "drafted", pack };
}
