import { rm } from "node:fs/promises";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Job } from "pg-boss";
import {
  AUDIT_EVENTS,
  CommitPayload,
  UploadPayload,
  VERIFIABLE_STATUSES,
  VerdictOutput,
  VerdictResult,
  audit,
  checkDemoRepo,
  decisionDeliveryId,
  deliveries,
  enqueue,
  hasAudit,
  loadDeliveryContext,
  milestones,
  releaseDelaySeconds,
  reviewWindowSeconds,
  statusForDecision,
  transition,
  type CriterionSpec,
  type Db,
  type EvidenceSummary,
  type MilestoneStatus,
  type StoredDecision,
} from "@milestone/core";
import { decide } from "@milestone/money";
import { describeModelError, isModelCallError, detectInjection, enforce, formatVerdictComment, isModelConfigured, judge, overall, postVerdictComment, runDeterministicStage, runUploadStage, safePath, uploadRoot, type DeterministicOutput, type EvidenceReader, type JudgeInput } from "@milestone/verify";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";
import { createEvidenceReader, createUploadEvidenceReader, git, scrubVerdictPaths } from "../lib/evidence.ts";

/**
 * One setup step; the deterministic stage clones the repo itself, so the lockfile check runs in the checkout.
 * Lifecycle scripts never run (--ignore-scripts here, npm_config_ignore_scripts in the stage's environment).
 * --prefer-offline reuses the stage's npm cache instead of revalidating every package.
 */
const SETUP = [["sh", "-c", "if [ -f package-lock.json ]; then npm ci --prefer-offline --ignore-scripts; elif [ -f package.json ]; then npm install --prefer-offline --ignore-scripts; fi"]];

function uploadPayloadOf(raw: Record<string, unknown> | null): UploadPayload {
  const parsed = UploadPayload.safeParse(raw ?? {});
  if (!parsed.success) throw new Error(`upload delivery payload is invalid: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  return parsed.data;
}

/** Commit deliveries (GitHub PR, manual) share one payload shape: clone_url + sha. */
function commitPayloadOf(raw: Record<string, unknown> | null): CommitPayload {
  const parsed = CommitPayload.safeParse(raw ?? {});
  if (!parsed.success) throw new Error("delivery payload has no sha or clone_url");
  return parsed.data;
}

/**
 * Enters "verifying" under a row lock and clears everything that belonged to the previous delivery
 * (client response, review window, decision), so a stale decision can never be released for this one.
 * Returns the status found when the milestone could not enter verifying. A milestone flagged for an operator
 * (milestone.needs_operator) never leaves held through a new delivery: an operator resolves it by hand.
 */
async function enterVerifying(db: Db, milestoneId: string, deliveryId: string): Promise<MilestoneStatus | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ status: milestones.status, contractId: milestones.contractId }).from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!row) throw new Error(`milestone ${milestoneId} not found`);
    if (!VERIFIABLE_STATUSES.has(row.status)) return row.status;
    if (await hasAudit(tx, { event: AUDIT_EVENTS.needsOperator, milestoneId })) {
      await audit(tx, { actor: "system", event: AUDIT_EVENTS.verifyRefusedNeedsOperator, milestoneId, contractId: row.contractId, detail: { deliveryId, status: row.status } });
      return row.status;
    }
    await transition(tx, milestoneId, "verifying", { actor: "system", event: AUDIT_EVENTS.milestoneVerifying, detail: { deliveryId } });
    await tx.update(milestones).set({ clientResponse: null, reviewEndsAt: null, decision: null, decidedAt: null }).where(eq(milestones.id, milestoneId));
    return null;
  });
}

/**
 * The baseline whose test suite grades the delivery (rule 9): the default branch head recorded at funding, else the
 * PR's base commit. With neither, the stage falls back to the first parent and says so in its evidence.
 */
export function tamperBaseline(milestoneBaselineSha: string | null, payload: Pick<CommitPayload, "base_sha">): { baselineSha: string; baselineSource: string } | null {
  if (milestoneBaselineSha) return { baselineSha: milestoneBaselineSha, baselineSource: "funding-time default branch" };
  if (payload.base_sha) return { baselineSha: payload.base_sha, baselineSource: "pull request base" };
  return null;
}

type OnEvidence = (item: EvidenceSummary) => Promise<void>;

/**
 * Progress while the stage runs: each evidence item is appended to deliveries.evidence as its check finishes, so the
 * contract page's poller shows the checks land one by one. Only while the delivery has no verdict: the verdict write
 * replaces the column with the final list (the same items, in the same order), so its meaning once verified is
 * unchanged. A failed progress write is logged and never fails the verification.
 */
export function evidenceProgress(db: Db, deliveryId: string): { reset(): Promise<void>; append: OnEvidence } {
  return {
    async reset() {
      // A retried job starts its progress over instead of appending to the last attempt's.
      await db.update(deliveries).set({ evidence: [] }).where(and(eq(deliveries.id, deliveryId), isNull(deliveries.verdict)));
    },
    async append(item) {
      try {
        await db
          .update(deliveries)
          .set({ evidence: sql`coalesce(${deliveries.evidence}, '[]'::jsonb) || jsonb_build_array(${JSON.stringify(item)}::jsonb)` })
          .where(and(eq(deliveries.id, deliveryId), isNull(deliveries.verdict)));
      } catch (e) {
        console.warn(`[verify] ${deliveryId}: could not record progress for ${item.id}:`, (e as Error).message);
      }
    },
  };
}

/**
 * Deterministic stage: the client's baseline suite against the delivered code, plus the gaming scan. A delivery whose
 * dependencies do not install (setup runs with the baseline's dev dependencies and lockfile) becomes failing evidence
 * instead of a retry loop.
 */
async function deterministic(payload: CommitPayload, criteria: CriterionSpec[], baselineSha: string | null, onEvidence?: OnEvidence): Promise<DeterministicOutput | { evidence: EvidenceSummary[]; workdir: null; baseline: null }> {
  try {
    return await runDeterministicStage({ repoUrl: payload.clone_url, sha: payload.sha, criteria, setup: SETUP, pullRequest: { title: payload.title, body: payload.body }, ...tamperBaseline(baselineSha, payload), ...(onEvidence ? { onEvidence } : {}) });
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.startsWith("setup failed")) throw e; // clone/fetch problems are retried by pg-boss
    const evidence: EvidenceSummary[] = criteria
      .filter((c) => c.kind === "test" || c.kind === "build" || c.kind === "file")
      .map((c) => ({ id: `evd_${c.id}`, criterion_id: c.id, kind: "log" as const, status: c.kind === "file" ? ("unclear" as const) : ("fail" as const), summary: `${msg}; the delivery could not be installed with the client's baseline test setup` }));
    return { evidence, workdir: null, baseline: null };
  }
}

/** The rationale prefix of a criterion the model was not asked about because its call failed (verdict-view shows it; MODEL_FAILED_RATIONALE in apps/web status/lines.ts mirrors it). */
export const MODEL_FAILED_RATIONALE = "not judged: the model call failed";

type Injection = { suspected: boolean; hits: Array<{ source: string; match: string }> };
type Milestone = NonNullable<JudgeInput["milestone"]>;

/**
 * Judge with the model when one is configured; otherwise deterministic evidence only and everything else unclear.
 *
 * A model call that throws (401, 429/529 after the SDK's retries, 400, a dropped connection) is caught here, at the
 * judgment stage boundary: the deterministic results stand, every criterion they do not settle is unclear with the
 * failure named, and the verdict is stored so decide() runs (P3 sends it to the client). The job completes instead of
 * pg-boss re-running clone, install and tests, and the milestone never strands in "verifying". The model never decides:
 * unclear is the honest verdict when it could not be asked.
 */
export async function conclude(deliveryId: string, milestone: Milestone, criteria: CriterionSpec[], evidence: EvidenceSummary[], deliveryTexts: Array<{ source: string; text: string }>, reader: () => EvidenceReader, extra: Injection = { suspected: false, hits: [] }) {
  if (await isModelConfigured()) {
    // Built outside the catch: a reader that cannot be set up (the checkout, the database) is a job error pg-boss
    // retries, never a stored verdict that blames the model.
    const evidenceReader = reader();
    try {
      const r = await judge({ deliveryId, milestone, criteria, evidence, deliveryTexts, reader: evidenceReader });
      if (extra.suspected) r.verdict.suspected_injection = true;
      const judged = { toolCalls: r.toolCalls.map((c) => `${c.tool}${c.ok ? "" : " (failed)"}`), attachedEvidence: r.attachedEvidence };
      return { evidence, verdict: r.verdict, result: r.result, model: r.model, promptHash: r.promptHash as string | null, injectionHits: [...r.injectionHits, ...extra.hits], judged };
    } catch (e) {
      // Only a failed model call is recorded as unclear; anything else that threw is a job error for pg-boss to retry.
      if (!isModelCallError(e)) throw e;
      const failure = describeModelError(e);
      console.error(`[verify] ${deliveryId}: the model call failed (${failure}); recording judgment criteria as unclear`, e);
      return { ...checksOnly(deliveryId, criteria, evidence, deliveryTexts, extra, `${MODEL_FAILED_RATIONALE} (${failure})`), judged: { modelError: failure } };
    }
  }
  return checksOnly(deliveryId, criteria, evidence, deliveryTexts, extra, "not judged: no model configured");
}

/** The verdict from deterministic evidence alone: each criterion it settles keeps its result, every other one is unclear. */
function checksOnly(deliveryId: string, criteria: CriterionSpec[], evidence: EvidenceSummary[], deliveryTexts: Array<{ source: string; text: string }>, extra: Injection, unjudged: string) {
  const injection = detectInjection(deliveryTexts);
  const verdict = enforce({ delivery_id: deliveryId, criteria: [], suspected_injection: injection.suspected || extra.suspected }, { deliveryId, criteria, evidence });
  const byCriterion = new Map(evidence.filter((e) => e.criterion_id).map((e) => [e.criterion_id!, e]));
  for (const c of verdict.criteria) {
    const ev = byCriterion.get(c.criterion_id);
    c.rationale = ev?.status ? (ev.summary.split("\n")[0] ?? ev.summary) : unjudged;
  }
  return { evidence, verdict, result: overall(verdict, criteria), model: "deterministic-only", promptHash: null as string | null, injectionHits: [...injection.hits, ...extra.hits], judged: null };
}

async function produceVerdict(deliveryId: string, milestone: Milestone, payload: CommitPayload, criteria: CriterionSpec[], baselineSha: string | null, onEvidence?: OnEvidence) {
  const stage = await deterministic(payload, criteria, baselineSha, onEvidence);
  try {
    const commitMessage = stage.workdir ? await git(stage.workdir, ["log", "-1", "--format=%B", payload.sha]).catch(() => "") : "";
    const deliveryTexts = [
      { source: "pr_title", text: payload.title },
      { source: "pr_body", text: payload.body },
      { source: "commit_message", text: commitMessage },
    ].filter((t) => t.text.trim() !== "");
    const v = await conclude(deliveryId, milestone, criteria, stage.evidence, deliveryTexts, () =>
      createEvidenceReader({ workdir: stage.workdir, sha: payload.sha, baseline: stage.baseline, repoUrl: payload.clone_url, evidence: stage.evidence }),
    );
    // The stage already strips its workdir from summaries; the model's rationales may still quote a tool error.
    return stage.workdir ? scrubVerdictPaths(v, [stage.workdir]) : v;
  } finally {
    if (stage.workdir) await rm(stage.workdir, { recursive: true, force: true });
  }
}

/**
 * A commit delivery the demo lock refuses (DEMO_MODE=1 and not DEMO_REPO_URL; checkDemoRepo in @milestone/core): nothing
 * is cloned or run, no model is asked, and every criterion is unclear with the reason, so policy sends it to the client.
 * The web routes refuse such a delivery before it is queued; this is the second check, in front of the clone.
 */
export function refusedVerdict(deliveryId: string, criteria: CriterionSpec[], reason: string) {
  return { ...checksOnly(deliveryId, criteria, [], [], { suspected: false, hits: [] }, `not verified: delivery refused, ${reason}`), judged: { refused: reason } };
}

/** Excerpt of each delivered file's text that goes into the judge's prompt; injection detection reads all of it. */
const EXCERPT = 4_000;

/**
 * File delivery: the upload stage (format, size, dimensions, pages, words, required strings), then the judge with
 * view_file. No repository, so no tamper check: nothing in an upload controls what the checks run.
 */
async function produceUploadVerdict(deliveryId: string, milestone: Milestone, payload: UploadPayload, criteria: CriterionSpec[], onEvidence?: OnEvidence) {
  const root = uploadRoot();
  const files = await Promise.all(payload.files.map(async (f) => ({ ...f, absPath: await safePath(root, f.path) })));
  const stage = await runUploadStage({ files, criteria, ...(onEvidence ? { onEvidence } : {}) });
  const texts = stage.inspections.filter((i) => i.text?.trim()).map((i) => ({ source: `file ${i.name}`, text: i.text! }));
  const full = detectInjection(texts);
  const deliveryTexts = [
    { source: "file_names", text: payload.files.map((f) => f.name).join("\n") },
    ...texts.map((t) => ({ source: t.source, text: t.text.length > EXCERPT ? `${t.text.slice(0, EXCERPT)}\n[excerpt; use view_file for the rest]` : t.text })),
  ];
  const v = await conclude(deliveryId, milestone, criteria, stage.evidence, deliveryTexts, () => createUploadEvidenceReader({ root, files: payload.files, evidence: stage.evidence }), full);
  return scrubVerdictPaths(v, [root]);
}

type DeliveryContext = NonNullable<Awaited<ReturnType<typeof loadDeliveryContext>>>;

/**
 * Step 1: the verdict, once per delivery. Enters verifying, runs the stage for the delivery's source (upload files, or
 * a commit to clone) and stores the verdict; returns the stored one. null when the milestone cannot be verified now.
 */
async function ensureVerdict(db: Db, ctx: DeliveryContext): Promise<{ verdict: VerdictOutput; result: VerdictResult } | null> {
  const { delivery, milestone, contract, criteria } = ctx;
  const deliveryId = delivery.id;
  // Upload deliveries carry files; everything else (GitHub PR, manual) a commit to clone. A malformed payload fails the job.
  const source = delivery.source === "upload" ? { kind: "upload" as const, payload: uploadPayloadOf(delivery.payload) } : { kind: "commit" as const, payload: commitPayloadOf(delivery.payload) };
  let stored = { verdict: delivery.verdict, result: delivery.result };
  if (!delivery.verdict || !delivery.result || !delivery.verifiedAt) {
    const blocked = await enterVerifying(db, milestone.id, deliveryId);
    if (blocked) {
      console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${blocked}, nothing to verify`);
      return null;
    }
    const context: Milestone = { title: milestone.title, scope: contract.scopeText };
    const progress = evidenceProgress(db, deliveryId);
    await progress.reset();
    // Defence in depth behind the web routes: in DEMO_MODE a commit from anywhere but DEMO_REPO_URL is never cloned.
    const lock = source.kind === "commit" ? checkDemoRepo(source.payload.clone_url) : ({ ok: true } as const);
    if (!lock.ok) {
      console.warn(`[verify] ${deliveryId}: refused, not cloned (${lock.reason})`);
      await audit(db, { actor: "verifier", event: AUDIT_EVENTS.deliveryRefused, milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, source: delivery.source, repoUrl: source.kind === "commit" ? source.payload.clone_url.slice(0, 500) : null, reason: lock.reason } });
    }
    const v =
      source.kind === "upload"
        ? await produceUploadVerdict(deliveryId, context, source.payload, criteria, progress.append)
        : !lock.ok
          ? refusedVerdict(deliveryId, criteria, lock.reason)
          : await produceVerdict(deliveryId, context, source.payload, criteria, milestone.baselineSha, progress.append);
    const written = await db
      .update(deliveries)
      .set({ evidence: v.evidence, verdict: v.verdict, result: v.result, suspectedInjection: v.verdict.suspected_injection, model: v.model, promptHash: v.promptHash, verifiedAt: new Date() })
      .where(and(eq(deliveries.id, deliveryId), isNull(deliveries.verdict)))
      .returning({ id: deliveries.id });
    if (written.length) {
      await audit(db, { actor: "verifier", event: AUDIT_EVENTS.verdictStored, milestoneId: milestone.id, contractId: contract.id, detail: { deliveryId, result: v.result, model: v.model, promptHash: v.promptHash, suspectedInjection: v.verdict.suspected_injection, injectionHits: v.injectionHits, ...(v.judged ?? {}) } });
    }
    // Another run may have stored its verdict first: the stored one is the delivery's verdict.
    const [row] = await db.select({ verdict: deliveries.verdict, result: deliveries.result }).from(deliveries).where(eq(deliveries.id, deliveryId));
    if (!row) throw new Error(`delivery ${deliveryId} not found`);
    stored = row;
  }
  return { verdict: VerdictOutput.parse(stored.verdict), result: VerdictResult.parse(stored.result) };
}

/** The milestone's current status and stored decision (the steps after the verdict read them fresh). */
async function milestoneState(db: Db, milestoneId: string): Promise<{ status: MilestoneStatus; decision: StoredDecision | null }> {
  const [row] = await db.select({ status: milestones.status, decision: milestones.decision }).from(milestones).where(eq(milestones.id, milestoneId));
  if (!row) throw new Error(`milestone ${milestoneId} not found`);
  return row;
}

/**
 * Step 2: the decision, once per delivery: decide() on the stored verdict, written only while the milestone is
 * verifying without a decision. The stored decision names the delivery it was made for. null when the milestone moved
 * on (another delivery, or the client) and this delivery's decision does not apply.
 */
async function ensureDecision(db: Db, ctx: DeliveryContext, verdict: VerdictOutput): Promise<StoredDecision | null> {
  const { delivery, milestone, contract, criteria } = ctx;
  const deliveryId = delivery.id;
  const current = await milestoneState(db, milestone.id);
  if (current.decision && decisionDeliveryId(current.decision) === deliveryId) return current.decision;
  if (current.status !== "verifying") {
    console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} is ${current.status}, not deciding`);
    return null;
  }
  const latest = await db.query.deliveries.findFirst({ columns: { id: true }, where: (d, o) => o.eq(d.milestoneId, milestone.id), orderBy: (d, o) => [o.desc(d.receivedAt), o.desc(d.id)] });
  if (latest && latest.id !== deliveryId) {
    console.warn(`[verify] ${deliveryId}: delivery ${latest.id} superseded it, not deciding`);
    return null;
  }
  const decision = decide({
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
    await audit(db, { actor: "policy", event: AUDIT_EVENTS.policyDecided, milestoneId: milestone.id, contractId: contract.id, detail: { ...stored } });
  }
  const after = await milestoneState(db, milestone.id);
  if (!after.decision || decisionDeliveryId(after.decision) !== deliveryId) {
    // The milestone moved on (another delivery, or the client) between our read and the write.
    console.warn(`[verify] ${deliveryId}: milestone ${milestone.id} changed while deciding, leaving it`);
    return null;
  }
  return after.decision;
}

/**
 * Step 3: state and schedule. Moves a verifying milestone to the decision's state (transition() is a no-op when already
 * there; a milestone that has moved on is left alone), opens the review window once, and schedules the release job
 * for when it closes (the release job re-checks the decision's deliveryId and the window; dedupe makes a retry a no-op).
 */
async function applyDecision(db: Db, ctx: DeliveryContext, decision: StoredDecision): Promise<void> {
  const deliveryId = ctx.delivery.id;
  const milestoneId = ctx.milestone.id;
  const target = statusForDecision(decision.action); // partial: the client confirms the share on the web
  const detail = { deliveryId, action: decision.action, ruleIds: decision.ruleIds };
  const reviewEndsAt = await db.transaction(async (tx) => {
    const [row] = await tx.select({ status: milestones.status, decision: milestones.decision, reviewEndsAt: milestones.reviewEndsAt }).from(milestones).where(eq(milestones.id, milestoneId)).for("update");
    if (!row || decisionDeliveryId(row.decision) !== deliveryId || (row.status !== "verifying" && row.status !== target)) {
      console.warn(`[verify] ${deliveryId}: milestone ${milestoneId} is ${row?.status ?? "gone"} with another decision or state, leaving it`);
      return null;
    }
    if (target !== "review") {
      await transition(tx, milestoneId, target, { actor: "policy", event: `milestone.${target}`, detail });
      return null;
    }
    let endsAt = row.reviewEndsAt;
    if (row.status === "verifying" || !endsAt) {
      endsAt = new Date(Date.now() + reviewWindowSeconds(ctx.contract.reviewWindowSeconds) * 1000);
      await tx.update(milestones).set({ reviewEndsAt: endsAt }).where(eq(milestones.id, milestoneId));
    }
    await transition(tx, milestoneId, "review", { actor: "policy", event: AUDIT_EVENTS.milestoneReview, detail: { ...detail, reviewEndsAt: endsAt.toISOString() } });
    return endsAt;
  });
  if (reviewEndsAt) {
    await enqueue("release", milestoneId, { deliveryId }, { delaySeconds: releaseDelaySeconds(reviewEndsAt), dedupe: deliveryId });
  }
}

/** Step 4: the verdict as a PR comment, for GitHub PR deliveries; best effort and marker-deduplicated. */
async function commentOnPr(db: Db, ctx: DeliveryContext, verdict: VerdictOutput, result: VerdictResult, decision: StoredDecision): Promise<void> {
  const { delivery, milestone, contract } = ctx;
  const pr = /#(\d+)$/.exec(delivery.ref);
  if (delivery.source !== "github_pr" || !pr) return;
  const repoFullName = delivery.ref.replace(/#\d+$/, "");
  const body = formatVerdictComment({ key: delivery.id, result, verdict, decision, title: `milestone ${milestone.seq}: ${milestone.title}` });
  const base = { actor: "system", milestoneId: milestone.id, contractId: contract.id } as const;
  try {
    const r = await postVerdictComment({ repoFullName, prNumber: Number(pr[1]), body });
    if (r.posted) await audit(db, { ...base, event: AUDIT_EVENTS.githubCommented, detail: { deliveryId: delivery.id, url: r.url } });
  } catch (e) {
    console.error(`[verify] ${delivery.id}: PR comment failed:`, (e as Error).message);
    await audit(db, { ...base, event: AUDIT_EVENTS.githubCommentFailed, detail: { deliveryId: delivery.id, error: (e as Error).message } });
  }
}

/** Deterministic (or upload) stage -> judge -> verdict on the delivery -> decide() -> state + release schedule -> PR comment. Safe to retry at every step. */
export async function verify(job: Job<JobData>): Promise<void> {
  const deliveryId = job.data.deliveryId;
  if (typeof deliveryId !== "string" || !deliveryId) throw new Error("verify job needs a deliveryId");
  const db = getDb();
  const ctx = await loadDeliveryContext(db, deliveryId);
  if (!ctx) throw new Error(`delivery ${deliveryId} (or its milestone or contract) not found`);

  const judged = await ensureVerdict(db, ctx);
  if (!judged) return;
  const decision = await ensureDecision(db, ctx, judged.verdict);
  if (!decision) return;
  await applyDecision(db, ctx, decision);
  await commentOnPr(db, ctx, judged.verdict, judged.result, decision);
}
