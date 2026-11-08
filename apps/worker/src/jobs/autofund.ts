import type { Job } from "pg-boss";
import { activePaymentMethod, agentActor, asString, audit, autoFundMandates, loadMilestone, type AgentMandate, type Db } from "@milestone/core";
import { fundFromVault, type VaultFundResult } from "@milestone/money";
import { defaultBranchHead } from "@milestone/verify";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { ensureAup } from "./aup.ts";
import { paypal } from "../lib/paypal.ts";

/** The audit event of every auto-fund attempt (the result, or the refusal and its reason). */
export const AUTOFUND_EVENT = "agent.autofund";

/** What one auto-fund run decided, for the audit row and the tests. */
export type AutofundOutcome =
  | { kind: "skipped"; why: "milestone_missing" | "contract_mismatch" | "no_auto_fund_mandate" }
  | { kind: "result"; result: VaultFundResult; retry: boolean };

/** Whether pg-boss should run the job again: only a PayPal answer whose outcome is unknown (network, 5xx, 409, 429). */
export function shouldRetry(result: VaultFundResult): boolean {
  return !result.ok && result.kind === "paypal_error" && result.retryable;
}

function detailOf(result: VaultFundResult): Record<string, unknown> {
  if (result.ok) {
    return { outcome: result.kind, status: result.status, captureId: result.captureId, orderId: result.orderId, requestId: result.requestId, amountMinor: result.amountMinor, currency: result.currency, replayed: result.replayed };
  }
  switch (result.kind) {
    case "refused":
      return { outcome: "refused", reason: result.reason };
    case "paypal_error":
      return { outcome: "paypal_error", requestId: result.requestId, httpStatus: result.status, retryable: result.retryable, error: result.error.slice(0, 500) };
    case "not_completed":
      return { outcome: "not_completed", requestId: result.requestId, orderId: result.orderId, orderStatus: result.orderStatus };
    case "mismatch":
      return { outcome: "mismatch", requestId: result.requestId, captureId: result.captureId };
    case "rejected":
      return { outcome: "rejected", requestId: result.requestId, error: result.error.slice(0, 500) };
  }
}

/**
 * The auto-fund rule, enqueued by the settle job after a milestone reaches released, for the contract's next draft
 * milestone ({ milestoneId: that milestone, contractId, releasedMilestoneId }). No model is involved: the job acts as
 * the client's newest live mandate with auto_fund_next (audit actor agentActor(mandate)) and calls fundFromVault, the
 * one function in packages/money/src/policy/execute.ts that charges a saved PayPal and enforces the whole funding
 * guarantee under row locks. It funds exactly the milestone it was enqueued for, never "whatever is next now", so a
 * stale or repeated job cannot walk down the contract.
 *
 * Every run writes one agent.autofund audit row. A refusal is final (never retried). A PayPal error whose outcome is
 * unknown throws, and pg-boss retries: fundFromVault keeps the vault_charge op "sent", so the retry replays the same
 * PayPal-Request-Id and cannot charge twice. A duplicate enqueue finds the op succeeded and books it without a charge.
 */
export async function autofund(job: Job<JobData>): Promise<void> {
  const outcome = await runAutofund(getDb(), job);
  if (outcome.kind === "result" && outcome.retry) {
    const r = outcome.result as Extract<VaultFundResult, { kind: "paypal_error" }>;
    throw new Error(`autofund ${job.data.milestoneId}: PayPal did not answer definitely (${r.status}): ${r.error}`);
  }
}

/** One auto-fund run without the retry throw (exported for the tests). */
export async function runAutofund(db: Db, job: Job<JobData>, now: Date = new Date()): Promise<AutofundOutcome> {
  const milestoneId = asString(job.data.milestoneId);
  const contractId = asString(job.data.contractId);
  const releasedMilestoneId = asString(job.data.releasedMilestoneId) ?? null;
  const base = { jobId: job.id, via: "auto_fund", releasedMilestoneId };

  const found = milestoneId ? await loadMilestone(db, milestoneId) : null;
  if (!found) {
    await audit(db, { actor: "policy", event: AUTOFUND_EVENT, ...(contractId ? { contractId } : {}), detail: { ...base, milestoneId: milestoneId ?? null, outcome: "skipped", why: "milestone_missing" } });
    return { kind: "skipped", why: "milestone_missing" };
  }
  const { milestone, contract } = found;
  const scope = { milestoneId: milestone.id, contractId: contract.id };
  if (contractId && contractId !== contract.id) {
    await audit(db, { actor: "policy", event: AUTOFUND_EVENT, ...scope, detail: { ...base, outcome: "skipped", why: "contract_mismatch", jobContractId: contractId } });
    return { kind: "skipped", why: "contract_mismatch" };
  }

  // The mandate may have been revoked, expired or changed since the enqueue: read it again now.
  const [mandate]: AgentMandate[] = await autoFundMandates(db, contract.clientId, now);
  if (!mandate) {
    await audit(db, { actor: "policy", event: AUTOFUND_EVENT, ...scope, detail: { ...base, outcome: "skipped", why: "no_auto_fund_mandate" } });
    return { kind: "skipped", why: "no_auto_fund_mandate" };
  }
  // No saved PayPal is still passed through: fundFromVault refuses it (payment_method_missing) and audits the refusal.
  const paymentMethod = await activePaymentMethod(db, mandate.userId);
  // Right before funding: a contract whose text changed since its PayPal AUP check (or was never checked) is checked
  // again; fundFromVault then refuses anything but clear, keywords only or cleared (fundingAllows, aup_*).
  await ensureAup(db, contract.id);
  const result = await fundFromVault({ client: paypal(), db }, { mandate, paymentMethod, milestone, contract, via: "auto_fund", baselineSha: (c) => defaultBranchHead(c.repoFullName), now });
  const retry = shouldRetry(result);
  await audit(db, {
    actor: agentActor(mandate),
    event: AUTOFUND_EVENT,
    ...scope,
    detail: { ...base, mandateId: mandate.id, agentName: mandate.agentName, onBehalfOf: mandate.userId, attempt: (job as Partial<{ retryCount: number }>).retryCount ?? 0, willRetry: retry, ...detailOf(result) },
  });
  return { kind: "result", result, retry };
}
