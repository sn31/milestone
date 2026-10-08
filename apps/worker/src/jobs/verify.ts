import { rm } from "node:fs/promises";
import type { Job } from "pg-boss";
import { audit, enqueue, transition, VerdictOutput, VerdictResult, type CriterionSpec, type EvidenceSummary, type PolicyDecision } from "@milestone/core";
import { decide } from "@milestone/money";
import { detectInjection, enforce, formatVerdictComment, judge, overall, postVerdictComment, runDeterministicStage, type DeterministicOutput } from "@milestone/verify";
import type { JobData } from "../handlers.js";
import { getDb } from "../lib/db.js";
import { createEvidenceReader, git } from "../lib/evidence.js";

type Db = ReturnType<typeof getDb>;

interface DeliveryPayload {
  sha: string;
  title: string;
  body: string;
  branch: string;
  clone_url: string;
}

/** One setup step; the deterministic stage clones the repo itself, so the lockfile check runs in the checkout. */
const SETUP = [["sh", "-c", "if [ -f package-lock.json ]; then npm ci; elif [ -f package.json ]; then npm install; fi"]];

function payloadOf(raw: Record<string, unknown> | null): DeliveryPayload {
  const p = raw ?? {};
  const str = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  const out = { sha: str("sha"), title: str("title"), body: str("body"), branch: str("branch"), clone_url: str("clone_url") };
  if (!out.sha || !out.clone_url) throw new Error("delivery payload has no sha or clone_url");
  return out;
}

function reviewWindowSeconds(contractWindow: number): number {
  const env = Number(process.env.REVIEW_WINDOW_SECONDS);
  return process.env.REVIEW_WINDOW_SECONDS !== undefined && process.env.REVIEW_WINDOW_SECONDS !== "" && Number.isFinite(env) && env >= 0 ? Math.floor(env) : contractWindow;
}

/** Deterministic stage; a delivery whose dependencies do not install becomes failing evidence instead of a retry loop. */
async function deterministic(payload: DeliveryPayload, criteria: CriterionSpec[]): Promise<DeterministicOutput | { evidence: EvidenceSummary[]; workdir: null }> {
  try {
    return await runDeterministicStage({ repoUrl: payload.clone_url, sha: payload.sha, criteria, setup: SETUP });
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.startsWith("setup failed")) throw e; // clone/fetch problems are retried by pg-boss
    const evidence: EvidenceSummary[] = criteria
      .filter((c) => c.kind === "test" || c.kind === "build" || c.kind === "file")
      .map((c) => ({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log" as const, status: c.kind === "file" ? ("unclear" as const) : ("fail" as const), summary: `${msg}; the delivery could not be installed` }));
    return { evidence, workdir: null };
  }
}

async function produceVerdict(deliveryId: string, payload: DeliveryPayload, criteria: CriterionSpec[]) {
  const stage = await deterministic(payload, criteria);
  try {
    const commitMessage = stage.workdir ? await git(stage.workdir, ["log", "-1", "--format=%B", payload.sha]).catch(() => "") : "";
    const deliveryTexts = [
      { source: "pr_title", text: payload.title },
      { source: "pr_body", text: payload.body },
      { source: "commit_message", text: commitMessage },
    ].filter((t) => t.text.trim() !== "");

    if (process.env.ANTHROPIC_API_KEY) {
      const reader = createEvidenceReader({ workdir: stage.workdir, sha: payload.sha, repoUrl: payload.clone_url, evidence: stage.evidence });
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
    if (milestone.status !== "funded" && milestone.status !== "held" && milestone.status !== "verifying") {
      console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${milestone.status}, nothing to verify`);
      return;
    }
    await transition(db, milestone.id, "verifying", { actor: "system", event: "milestone.verifying", detail: { deliveryId } });
    const v = await produceVerdict(deliveryId, payload, criteria);
    const stored = await db.$client.query(
      `update deliveries set evidence = $2::jsonb, verdict = $3::jsonb, result = $4, suspected_injection = $5, model = $6, prompt_hash = $7, verified_at = now()
       where id = $1 and verdict is null returning id`,
      [deliveryId, JSON.stringify(v.evidence), JSON.stringify(v.verdict), v.result, v.verdict.suspected_injection, v.model, v.promptHash],
    );
    if (stored.rowCount) {
      await audit(db, { actor: "verifier", event: "verdict.stored", milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, result: v.result, model: v.model, promptHash: v.promptHash, suspectedInjection: v.verdict.suspected_injection, injectionHits: v.injectionHits } });
    }
    ({ delivery, milestone, contract, criteria } = await loadAll(db, deliveryId));
  }
  const verdict = VerdictOutput.parse(delivery.verdict);
  const result = VerdictResult.parse(delivery.result);
  const verifiedAt = delivery.verifiedAt!;

  // 2. Decision, once per verdict: a decision older than this verdict belongs to an earlier delivery.
  const decidedForThis = milestone.decidedAt !== null && milestone.decision !== null && milestone.decidedAt >= verifiedAt;
  let decision: PolicyDecision;
  if (decidedForThis) {
    decision = milestone.decision as PolicyDecision;
  } else {
    if (milestone.status !== "verifying") {
      console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${milestone.status}, not deciding`);
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
    await db.$client.query(`update milestones set decision = $2::jsonb, decided_at = now() where id = $1`, [milestone.id, JSON.stringify(decision)]);
    await audit(db, { actor: "policy", event: "policy.decided", milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, ...decision } });
    milestone = (await loadAll(db, deliveryId)).milestone;
  }

  // 3. State and schedule. transition() is a no-op when already there; a milestone that has moved on is left alone.
  const target = decision.action === "release" ? "review" : decision.action === "hold" ? "held" : "needs_client"; // partial: the client confirms the share on the web
  const detail = { deliveryId, action: decision.action, ruleIds: decision.ruleIds };
  if (milestone.status !== "verifying" && milestone.status !== target) {
    console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${milestone.status}, leaving it`);
  } else if (target === "review") {
    let endsAt = milestone.reviewEndsAt;
    if (milestone.status === "verifying" || !endsAt) {
      endsAt = new Date(Date.now() + reviewWindowSeconds(contract.reviewWindowSeconds) * 1000);
      await db.$client.query(`update milestones set review_ends_at = $2 where id = $1`, [milestone.id, endsAt]);
    }
    await transition(db, milestone.id, "review", { actor: "policy", event: "milestone.review", detail: { ...detail, reviewEndsAt: endsAt.toISOString() } });
    const delaySeconds = Math.max(0, Math.ceil((endsAt.getTime() - Date.now()) / 1000));
    await enqueue("release", milestone.id, { deliveryId }, { delaySeconds, dedupe: deliveryId });
  } else {
    await transition(db, milestone.id, target, { actor: "policy", event: `milestone.${target}`, detail });
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
