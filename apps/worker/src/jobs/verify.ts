import { rm } from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import type { Job } from "pg-boss";
import { audit, deliveries, enqueue, milestones, transition, VerdictOutput, VerdictResult, type CriterionSpec, type Db, type EvidenceSummary, type MilestoneStatus, type PolicyDecision } from "@milestone/core";
import { decide } from "@milestone/money";
import { detectInjection, enforce, formatVerdictComment, judge, overall, postVerdictComment, runDeterministicStage, type DeterministicOutput } from "@milestone/verify";
import type { JobData } from "../handlers.js";
import { getDb } from "../lib/db.js";
import { createEvidenceReader, git } from "../lib/evidence.js";

/** The decision stored on the milestone names the delivery it was made for; the release job checks it. */
export type StoredDecision = PolicyDecision & { deliveryId: string };

/** The review window can be shortened for demos, never skipped. */
export const MIN_REVIEW_WINDOW_SECONDS = 30;

const VERIFIABLE: readonly MilestoneStatus[] = ["funded", "held", "verifying"];

interface DeliveryPayload {
  sha: string;
  title: string;
  body: string;
  branch: string;
  clone_url: string;
  /** The pull request's base commit when the delivery was merged (GitHub webhook), if recorded. */
  base_sha: string | null;
}

/**
 * One setup step; the deterministic stage clones the repo itself, so the lockfile check runs in the checkout.
 * Lifecycle scripts never run (--ignore-scripts here, npm_config_ignore_scripts in the stage's environment).
 */
const SETUP = [["sh", "-c", "if [ -f package-lock.json ]; then npm ci --ignore-scripts; elif [ -f package.json ]; then npm install --ignore-scripts; fi"]];

function payloadOf(raw: Record<string, unknown> | null): DeliveryPayload {
  const p = raw ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const out = { sha: str("sha"), title: str("title"), body: str("body"), branch: str("branch"), clone_url: str("clone_url"), base_sha: str("base_sha") || null };
  if (!out.sha || !out.clone_url) throw new Error("delivery payload has no sha or clone_url");
  return out;
}

export function reviewWindowSeconds(contractWindow: number, override = process.env.REVIEW_WINDOW_SECONDS): number {
  const env = Number(override);
  const chosen = override !== undefined && override.trim() !== "" && Number.isFinite(env) ? Math.floor(env) : contractWindow;
  return Math.max(MIN_REVIEW_WINDOW_SECONDS, Number.isFinite(chosen) ? chosen : MIN_REVIEW_WINDOW_SECONDS);
}

function decisionDeliveryId(decision: unknown): string | null {
  const id = decision && typeof decision === "object" ? (decision as { deliveryId?: unknown }).deliveryId : undefined;
  return typeof id === "string" ? id : null;
}

/**
 * Enters "verifying" under a row lock and clears everything that belonged to the previous delivery
 * (client response, review window, decision), so a stale decision can never be released for this one.
 * Returns the status found when the milestone could not enter verifying.
 */
async function enterVerifying(db: Db, milestoneId: string, deliveryId: string): Promise<MilestoneStatus | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ status: milestones.status }).from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!row) throw new Error(`milestone ${milestoneId} not found`);
    if (!VERIFIABLE.includes(row.status)) return row.status;
    await transition(tx as unknown as Db, milestoneId, "verifying", { actor: "system", event: "milestone.verifying", detail: { deliveryId } });
    await tx.update(milestones).set({ clientResponse: null, reviewEndsAt: null, decision: null, decidedAt: null }).where(eq(milestones.id, milestoneId));
    return null;
  });
}

/**
 * The tamper check's baseline: the default branch head recorded at funding, else the PR's base commit. With
 * neither, the stage falls back to the first parent and says so in its evidence.
 */
export function tamperBaseline(milestoneBaselineSha: string | null, payload: Pick<DeliveryPayload, "base_sha">): { baselineSha: string; baselineSource: string } | null {
  if (milestoneBaselineSha) return { baselineSha: milestoneBaselineSha, baselineSource: "funding-time default branch" };
  if (payload.base_sha) return { baselineSha: payload.base_sha, baselineSource: "pull request base" };
  return null;
}

/** Deterministic stage; a delivery whose dependencies do not install becomes failing evidence instead of a retry loop. */
async function deterministic(payload: DeliveryPayload, criteria: CriterionSpec[], baselineSha: string | null): Promise<DeterministicOutput | { evidence: EvidenceSummary[]; workdir: null; baseline: null }> {
  try {
    return await runDeterministicStage({ repoUrl: payload.clone_url, sha: payload.sha, criteria, setup: SETUP, ...tamperBaseline(baselineSha, payload) });
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.startsWith("setup failed")) throw e; // clone/fetch problems are retried by pg-boss
    const evidence: EvidenceSummary[] = criteria
      .filter((c) => c.kind === "test" || c.kind === "build" || c.kind === "file")
      .map((c) => ({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log" as const, status: c.kind === "file" ? ("unclear" as const) : ("fail" as const), summary: `${msg}; the delivery could not be installed` }));
    return { evidence, workdir: null, baseline: null };
  }
}

async function produceVerdict(deliveryId: string, payload: DeliveryPayload, criteria: CriterionSpec[], baselineSha: string | null) {
  const stage = await deterministic(payload, criteria, baselineSha);
  try {
    const commitMessage = stage.workdir ? await git(stage.workdir, ["log", "-1", "--format=%B", payload.sha]).catch(() => "") : "";
    const deliveryTexts = [
      { source: "pr_title", text: payload.title },
      { source: "pr_body", text: payload.body },
      { source: "commit_message", text: commitMessage },
    ].filter((t) => t.text.trim() !== "");

    if (process.env.ANTHROPIC_API_KEY) {
      const reader = createEvidenceReader({ workdir: stage.workdir, sha: payload.sha, baseline: stage.baseline, repoUrl: payload.clone_url, evidence: stage.evidence });
      const r = await judge({ deliveryId, criteria, evidence: stage.evidence, deliveryTexts, reader });
      return { evidence: stage.evidence, verdict: r.verdict, result: r.result, model: r.model, promptHash: r.promptHash as string | null, injectionHits: r.injectionHits };
    }

    // No model configured: deterministic evidence only; everything else is unclear.
    const injection = detectInjection(deliveryTexts);
    const verdict = enforce({ delivery_id: deliveryId, criteria: [], suspected_injection: injection.suspected }, { deliveryId, criteria, evidence: stage.evidence });
    const byCriterion = new Map(stage.evidence.filter((e) => e.criterion_id).map((e) => [e.criterion_id!, e]));
    for (const c of verdict.criteria) {
      const ev = byCriterion.get(c.criterion_id);
      c.rationale = ev?.status ? (ev.summary.split("\n")[0] ?? ev.summary) : "not judged: no model configured";
    }
    return { evidence: stage.evidence, verdict, result: overall(verdict, criteria), model: "deterministic-only", promptHash: null, injectionHits: injection.hits };
  } finally {
    if (stage.workdir) await rm(stage.workdir, { recursive: true, force: true });
  }
}

async function loadAll(db: Db, deliveryId: string) {
  const delivery = await db.query.deliveries.findFirst({ where: (d, { eq }) => eq(d.id, deliveryId) });
  if (!delivery) throw new Error(`delivery ${deliveryId} not found`);
  const milestone = await db.query.milestones.findFirst({ where: (m, { eq }) => eq(m.id, delivery.milestoneId) });
  if (!milestone) throw new Error(`milestone ${delivery.milestoneId} not found`);
  const contract = await db.query.contracts.findFirst({ where: (c, { eq }) => eq(c.id, milestone.contractId) });
  if (!contract) throw new Error(`contract ${milestone.contractId} not found`);
  const rows = await db.query.criteria.findMany({ where: (c, { eq }) => eq(c.milestoneId, milestone.id), orderBy: (c, { asc }) => asc(c.id) });
  const criteria: CriterionSpec[] = rows.map((r) => ({ id: r.id, kind: r.kind, description: r.description, spec: r.spec, required: r.required }));
  return { delivery, milestone, contract, criteria };
}

/** Deterministic stage -> judge -> verdict on the delivery -> decide() -> state + release schedule -> PR comment. Safe to retry at every step. */
export async function verify(job: Job<JobData>): Promise<void> {
  const deliveryId = job.data.deliveryId;
  if (typeof deliveryId !== "string" || !deliveryId) throw new Error("verify job needs a deliveryId");
  const db = getDb();
  let { delivery, milestone, contract, criteria } = await loadAll(db, deliveryId);
  const payload = payloadOf(delivery.payload);

  // 1. Verdict, once per delivery.
  if (!delivery.verdict || !delivery.result || !delivery.verifiedAt) {
    const blocked = await enterVerifying(db, milestone.id, deliveryId);
    if (blocked) {
      console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${blocked}, nothing to verify`);
      return;
    }
    const v = await produceVerdict(deliveryId, payload, criteria, milestone.baselineSha);
    const stored = await db
      .update(deliveries)
      .set({ evidence: v.evidence, verdict: v.verdict, result: v.result, suspectedInjection: v.verdict.suspected_injection, model: v.model, promptHash: v.promptHash, verifiedAt: new Date() })
      .where(and(eq(deliveries.id, deliveryId), isNull(deliveries.verdict)))
      .returning({ id: deliveries.id });
    if (stored.length) {
      await audit(db, { actor: "verifier", event: "verdict.stored", milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, result: v.result, model: v.model, promptHash: v.promptHash, suspectedInjection: v.verdict.suspected_injection, injectionHits: v.injectionHits } });
    }
    ({ delivery, milestone, contract, criteria } = await loadAll(db, deliveryId));
  }
  const verdict = VerdictOutput.parse(delivery.verdict);
  const result = VerdictResult.parse(delivery.result);

  // 2. Decision, once per delivery: the stored decision names the delivery it was made for.
  let decision: PolicyDecision;
  if (milestone.decision && decisionDeliveryId(milestone.decision) === deliveryId) {
    decision = milestone.decision as StoredDecision;
  } else {
    if (milestone.status !== "verifying") {
      console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${milestone.status}, not deciding`);
      return;
    }
    const latest = await db.query.deliveries.findFirst({ where: (d, o) => o.eq(d.milestoneId, milestone.id), orderBy: (d, o) => [o.desc(d.receivedAt), o.desc(d.id)] });
    if (latest && latest.id !== deliveryId) {
      console.warn(`[verify] ${deliveryId}: delivery ${latest.id} superseded it, not deciding`);
      return;
    }
    decision = decide({
      verdict,
      criteria,
      milestone: { amountMinor: milestone.amountMinor, currency: contract.currency },
      contract: {
        confidenceThreshold: contract.confidenceThresholdPct / 100,
        ...(contract.perReleaseCapMinor !== null ? { perReleaseCapMinor: contract.perReleaseCapMinor } : {}),
      },
    });
    const stored: StoredDecision = { ...decision, deliveryId };
    const written = await db
      .update(milestones)
      .set({ decision: stored, decidedAt: new Date() })
      .where(and(eq(milestones.id, milestone.id), eq(milestones.status, "verifying"), isNull(milestones.decision)))
      .returning({ id: milestones.id });
    if (written.length) {
      await audit(db, { actor: "policy", event: "policy.decided", milestoneId: milestone.id, contractId: contract.id, detail: { ...stored } });
    }
    milestone = (await loadAll(db, deliveryId)).milestone;
    if (decisionDeliveryId(milestone.decision) !== deliveryId) {
      // The milestone moved on (another delivery, or the client) between our read and the write.
      console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} changed while deciding, leaving it`);
      return;
    }
    decision = milestone.decision as StoredDecision;
  }

  // 3. State and schedule. transition() is a no-op when already there; a milestone that has moved on is left alone.
  const target = decision.action === "release" ? "review" : decision.action === "hold" ? "held" : "needs_client"; // partial: the client confirms the share on the web
  const detail = { deliveryId, action: decision.action, ruleIds: decision.ruleIds };
  const milestoneId = milestone.id;
  const reviewEndsAt = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [row] = await tx.select({ status: milestones.status, decision: milestones.decision, reviewEndsAt: milestones.reviewEndsAt }).from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!row || decisionDeliveryId(row.decision) !== deliveryId || (row.status !== "verifying" && row.status !== target)) {
      console.warn(`[verify] ${deliveryId}: milestone ${milestoneId} is ${row?.status ?? "gone"} with another decision or state, leaving it`);
      return null;
    }
    if (target !== "review") {
      await transition(t, milestoneId, target, { actor: "policy", event: `milestone.${target}`, detail });
      return null;
    }
    let endsAt = row.reviewEndsAt;
    if (row.status === "verifying" || !endsAt) {
      endsAt = new Date(Date.now() + reviewWindowSeconds(contract.reviewWindowSeconds) * 1000);
      await tx.update(milestones).set({ reviewEndsAt: endsAt }).where(eq(milestones.id, milestoneId));
    }
    await transition(t, milestoneId, "review", { actor: "policy", event: "milestone.review", detail: { ...detail, reviewEndsAt: endsAt.toISOString() } });
    return endsAt;
  });
  if (reviewEndsAt) {
    // The release job re-checks the decision's deliveryId and the window; dedupe makes a retry a no-op.
    const delaySeconds = Math.max(0, Math.ceil((reviewEndsAt.getTime() - Date.now()) / 1000));
    await enqueue("release", milestoneId, { deliveryId }, { delaySeconds, dedupe: deliveryId });
  }

  // 4. PR comment, best effort and marker-deduplicated.
  const pr = /#(\d+)$/.exec(delivery.ref);
  const repoFullName = delivery.ref.replace(/#\d+$/, "");
  if (delivery.source === "github_pr" && pr) {
    const body = formatVerdictComment({ key: deliveryId, result, verdict, decision, title: `milestone ${milestone.seq}: ${milestone.title}` });
    try {
      const r = await postVerdictComment({ repoFullName, prNumber: Number(pr[1]), body });
      if (r.posted) await audit(db, { actor: "system", event: "github.commented", milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, url: r.url } });
    } catch (e) {
      console.error(`[verify] ${deliveryId}: PR comment failed:`, (e as Error).message);
      await audit(db, { actor: "system", event: "github.comment_failed", milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, error: (e as Error).message } });
    }
  }
}
