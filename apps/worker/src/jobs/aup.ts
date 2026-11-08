import type { Job } from "pg-boss";
import { enqueue, ensureAupCheck, loadAupSubject, recordAupCheck, type AupDeps, type AupStatus, type Executor } from "@milestone/core";
import { aupKeywordFlags, checkAcceptableUse, isModelConfigured, PAYPAL_AUP_SOURCE } from "@milestone/verify";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";

/** The actor the check's audit rows carry. */
export const AUP_ACTOR = "verifier";

/** What ensureAupCheck needs in the worker: the keyword pass, the model switch and the aup queue. */
export const aupDeps: AupDeps = {
  keywords: aupKeywordFlags,
  modelConfigured: () => isModelConfigured(),
  // Keyed on the contract (enqueue's key argument) and the text hash: one check per contract text.
  enqueue: (contractId, hash) => enqueue("aup", contractId, { contractId, textHash: hash }, { dedupe: `aup:${hash}` }),
  policy: { ...PAYPAL_AUP_SOURCE },
};

export type AupJobOutcome = { kind: "recorded"; status: AupStatus | "stale" | "rejected" | "missing" } | { kind: "skipped"; why: "missing" | "stale" | "not_checking" };

/**
 * The aup job ({ contractId, textHash }): runs the PayPal Acceptable Use Policy check (keyword pass, then Claude) on the
 * contract text that hashes to textHash and stores the result. A job for an older text (the criteria were edited since)
 * or for a contract no longer `checking` (an operator already decided, or a newer check finished) does nothing.
 * checkAcceptableUse never throws for a model problem: a failed call is recorded as model_error, which the rule sends to
 * an operator (fail closed). Nothing here is retried: a stored result is final for that text.
 */
export async function runAupJob(db: Executor, data: { contractId: string; textHash: string }, check: typeof checkAcceptableUse = checkAcceptableUse): Promise<AupJobOutcome> {
  const s = await loadAupSubject(db, data.contractId);
  if (!s) return { kind: "skipped", why: "missing" };
  if (s.hash !== data.textHash) return { kind: "skipped", why: "stale" };
  if (s.contract.aupStatus !== "checking") return { kind: "skipped", why: "not_checking" };
  const result = await check(s.subject);
  const { dropped, ...record } = result;
  if (dropped.length) console.log(`[aup] ${data.contractId}: parser dropped ${dropped.length} model flag(s): ${dropped.map((d) => `${d.category} (${d.reason})`).join(", ")}`);
  return { kind: "recorded", status: await recordAupCheck(db, data.contractId, data.textHash, record, AUP_ACTOR) };
}

export async function aup(job: Job<JobData>): Promise<void> {
  const contractId = typeof job.data.contractId === "string" ? job.data.contractId : job.data.milestoneId;
  const textHash = typeof job.data.textHash === "string" ? job.data.textHash : "";
  const out = await runAupJob(getDb(), { contractId, textHash });
  console.log(`[aup] ${contractId}: ${out.kind === "recorded" ? out.status : `skipped (${out.why})`}`);
}

/** The worker's ensureAupCheck (the auto-fund job calls it before funding). */
export function ensureAup(db: Executor, contractId: string) {
  return ensureAupCheck(db, contractId, aupDeps, AUP_ACTOR);
}
