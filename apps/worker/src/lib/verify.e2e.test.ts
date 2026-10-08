/**
 * End to end against the local Postgres and a throwaway local git repo. Opt in: MILESTONE_E2E=1.
 * enqueue is mocked so no real release job is scheduled; GitHub and the model are off (no tokens).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, inArray } from "drizzle-orm";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enqueued: Array<{ name: string; milestoneId: string; data: unknown; opts: unknown }> = [];
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (name: string, milestoneId: string, data: unknown, opts: unknown) => { enqueued.push({ name, milestoneId, data, opts }); return "job"; },
}));

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

describe("review window", () => {
  it("is clamped to at least 30 seconds, so 0 cannot skip review", async () => {
    const { reviewWindowSeconds } = await import("../jobs/verify.js");
    expect(reviewWindowSeconds(172_800, "0")).toBe(30);
    expect(reviewWindowSeconds(172_800, "-5")).toBe(30);
    expect(reviewWindowSeconds(172_800, "90")).toBe(90);
    expect(reviewWindowSeconds(0, "")).toBe(30);
    expect(reviewWindowSeconds(172_800, "")).toBe(172_800);
    expect(reviewWindowSeconds(172_800, "abc")).toBe(172_800);
  });
});

describe.skipIf(!run)("verify job end to end", async () => {
  const { auditLog, contracts, milestones, criteria, deliveries } = await import("@milestone/core");
  const { getDb } = await import("./db.js");
  const { verify } = await import("../jobs/verify.js");
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_${tag}`;
  let repo: string;
  let sha: string;
  let tamperSha: string;
  let laterSha: string;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
    process.env.REVIEW_WINDOW_SECONDS = "60";
    repo = await mkdtemp(join(tmpdir(), "milestone-e2e-repo-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "e2e", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"", fail: "node -e \"process.exit(1)\"" } }));
    await writeFile(join(repo, "README.md"), "# e2e\n");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", ...a], { cwd: repo }).toString().trim();
    g("init", "-q", "-b", "main"); g("add", "."); g("commit", "-qm", "feat: add readme");
    sha = g("rev-parse", "HEAD");
    // A delivery that makes its own tests pass by rewriting the test script.
    g("checkout", "-qb", "tamper");
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "e2e", version: "1.0.0", scripts: { test: "exit 0", fail: "node -e \"process.exit(1)\"" } }));
    g("add", "."); g("commit", "-qm", "chore: faster tests");
    tamperSha = g("rev-parse", "HEAD");
    // The same script rewrite in an earlier commit, then a delivery commit that only adds a file:
    // the first-parent diff misses it, a baseline from funding or the PR base catches it.
    await writeFile(join(repo, "CHANGELOG.md"), "- faster tests\n");
    g("add", "."); g("commit", "-qm", "docs: changelog");
    laterSha = g("rev-parse", "HEAD");
    g("checkout", "-q", "main");
    const db = getDb();
    await db.insert(contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "e2e", scopeText: "e2e", currency: "USD", totalMinor: 30000, repoFullName: `e2e/${tag}`, status: "active" });
  });

  afterAll(async () => {
    const db = getDb();
    const ids = (await db.select({ id: milestones.id }).from(milestones).where(eq(milestones.contractId, contractId))).map((r) => r.id);
    await db.delete(auditLog).where(eq(auditLog.contractId, contractId));
    if (ids.length) {
      await db.delete(auditLog).where(inArray(auditLog.milestoneId, ids));
      await db.delete(deliveries).where(inArray(deliveries.milestoneId, ids));
      await db.delete(criteria).where(inArray(criteria.milestoneId, ids));
      await db.delete(milestones).where(inArray(milestones.id, ids));
    }
    await db.delete(contracts).where(eq(contracts.id, contractId));
    if (repo) await rm(repo, { recursive: true, force: true });
  });

  type MilestoneInsert = typeof milestones.$inferInsert;
  async function setup(seq: number, crit: Array<{ kind: "test" | "file" | "judgment"; spec: Record<string, unknown>; required: boolean }>, opts: { sha?: string; milestone?: Partial<MilestoneInsert>; payload?: Record<string, unknown> } = {}) {
    const db = getDb();
    const milestoneId = `mst_e2e_${tag}_${seq}`;
    await db.insert(milestones).values({ id: milestoneId, contractId, seq, title: `m${seq}`, amountMinor: 10000, status: "funded", ...opts.milestone });
    await db.insert(criteria).values(crit.map((c, i) => ({ id: `crt_e2e_${tag}_${seq}_${i}`, milestoneId, kind: c.kind, description: `${c.kind} ${i}`, spec: c.spec, required: c.required })));
    const deliveryId = `dlv_e2e_${tag}_${seq}`;
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "github_pr", ref: `e2e/${tag}#${seq}`, payload: { sha: opts.sha ?? sha, title: "m", body: "", branch: `m${seq}-x`, clone_url: `file://${repo}`, ...opts.payload } });
    const job = { id: "j", name: "verify", data: { milestoneId, deliveryId } } as unknown as Job<{ milestoneId: string } & Record<string, unknown>>;
    const state = async () => ({
      m: (await db.query.milestones.findFirst({ where: (m, { eq }) => eq(m.id, milestoneId) }))!,
      d: (await db.query.deliveries.findFirst({ where: (d, { eq }) => eq(d.id, deliveryId) }))!,
      audits: (await db.select({ event: auditLog.event }).from(auditLog).where(eq(auditLog.milestoneId, milestoneId)).orderBy(asc(auditLog.createdAt))).map((r) => r.event),
    });
    return { job, state, milestoneId, deliveryId };
  }

  it("all deterministic criteria pass -> review, release scheduled after the window; a retry changes nothing", { timeout: 120_000 }, async () => {
    const t = await setup(1, [{ kind: "test", spec: { command: "npm test" }, required: true }, { kind: "file", spec: { path: "README.md" }, required: true }]);
    await verify(t.job);
    const s = await t.state();
    expect(s.d.result).toBe("pass");
    expect(s.d.model).toBe("deterministic-only");
    expect(s.m.status).toBe("review");
    expect(s.m.decision).toMatchObject({ action: "release", deliveryId: t.deliveryId });
    expect(s.m.reviewEndsAt).not.toBeNull();
    const tamper = (s.d.evidence as Array<{ id: string; status?: string; summary: string }>).find((e) => e.id === "evd_tamper_check");
    expect(tamper?.status).toBe("pass");
    expect(tamper?.summary).toMatch(/no baseline recorded/);
    const rel = enqueued.filter((e) => e.milestoneId === t.milestoneId);
    expect(rel).toHaveLength(1);
    expect(rel[0]).toMatchObject({ name: "release", data: { deliveryId: t.deliveryId }, opts: { dedupe: t.deliveryId } });
    await verify(t.job);
    const s2 = await t.state();
    expect(s2.audits).toEqual(s.audits);
    expect(s2.m.reviewEndsAt?.getTime()).toBe(s.m.reviewEndsAt?.getTime());
    expect(s.audits).toEqual(["milestone.verifying", "verdict.stored", "policy.decided", "milestone.review"]);
  });

  it("a judgment criterion with no model -> unclear -> needs_client", { timeout: 120_000 }, async () => {
    const t = await setup(2, [{ kind: "test", spec: { command: "npm test" }, required: true }, { kind: "judgment", spec: {}, required: false }]);
    await verify(t.job);
    const s = await t.state();
    expect(s.m.status).toBe("needs_client");
    expect(s.m.decision?.ruleIds).toEqual(["P3"]);
    const v = s.d.verdict as { criteria: Array<{ status: string }> };
    expect(v.criteria.map((c) => c.status)).toEqual(["pass", "unclear"]);
  });

  it("a failing required test -> held", { timeout: 120_000 }, async () => {
    const t = await setup(3, [{ kind: "test", spec: { command: "npm run fail" }, required: true }, { kind: "file", spec: { path: "missing.txt" }, required: false }]);
    await verify(t.job);
    const s = await t.state();
    expect(s.d.result).toBe("fail");
    expect(s.m.status).toBe("held");
    expect(s.m.decision?.ruleIds).toEqual(["P2"]);
  });

  it("a delivery that edits package.json scripts: tamper check -> unclear -> needs_client, nothing released", { timeout: 120_000 }, async () => {
    const t = await setup(4, [{ kind: "test", spec: { command: "npm test" }, required: true }, { kind: "file", spec: { path: "README.md" }, required: true }], { sha: tamperSha });
    await verify(t.job);
    const s = await t.state();
    const evidence = s.d.evidence as Array<{ id: string; criterion_id?: string; status?: string; summary: string }>;
    expect(evidence.find((e) => e.id === "evd_tamper_check")).toMatchObject({ status: "unclear" });
    expect(evidence.find((e) => e.criterion_id === `crt_e2e_${tag}_4_0`)?.summary).toMatch(/tamper check.*package\.json scripts changed/);
    const v = s.d.verdict as { criteria: Array<{ status: string }> };
    expect(v.criteria.map((c) => c.status)).toEqual(["unclear", "pass"]);
    expect(s.d.result).toBe("fail");
    expect(s.m.status).toBe("needs_client");
    expect(s.m.decision).toMatchObject({ action: "ask_client", deliveryId: t.deliveryId });
    expect(enqueued.filter((e) => e.milestoneId === t.milestoneId)).toEqual([]);
  });

  const crit2 = [{ kind: "test" as const, spec: { command: "npm test" }, required: true }, { kind: "file" as const, spec: { path: "README.md" }, required: true }];
  async function tamperEvidence(t: Awaited<ReturnType<typeof setup>>) {
    await verify(t.job);
    const s = await t.state();
    const evidence = s.d.evidence as Array<{ id: string; criterion_id?: string; status?: string; summary: string }>;
    return { s, tamper: evidence.find((e) => e.id === "evd_tamper_check")!, tests: evidence.find((e) => e.criterion_id === t.milestoneId.replace("mst_", "crt_") + "_0")! };
  }

  it("without a baseline, a script rewrite in an earlier commit is missed by the first-parent fallback, and the evidence says so", { timeout: 120_000 }, async () => {
    const t = await setup(6, crit2, { sha: laterSha });
    const { s, tamper } = await tamperEvidence(t);
    expect(tamper).toMatchObject({ status: "pass" });
    expect(tamper.summary).toMatch(/first parent .* only \(no baseline recorded/);
    expect(s.m.status).toBe("review");
  });

  it("the funding-time baseline on the milestone catches a script rewrite in an earlier commit -> needs_client", { timeout: 120_000 }, async () => {
    const t = await setup(7, crit2, { sha: laterSha, milestone: { baselineSha: sha }, payload: { base_sha: tamperSha } });
    const { s, tamper, tests } = await tamperEvidence(t);
    expect(tamper).toMatchObject({ status: "unclear" });
    expect(tamper.summary).toMatch(/funding-time default branch baseline .*package\.json scripts changed/);
    expect(tests).toMatchObject({ status: "unclear" });
    expect(s.m.status).toBe("needs_client");
    expect(enqueued.filter((e) => e.milestoneId === t.milestoneId)).toEqual([]);
  });

  it("with no milestone baseline, the delivery's PR base sha is used", { timeout: 120_000 }, async () => {
    const t = await setup(8, crit2, { sha: laterSha, payload: { base_sha: sha } });
    const { s, tamper } = await tamperEvidence(t);
    expect(tamper.summary).toMatch(/pull request base baseline .*package\.json scripts changed/);
    expect(s.m.status).toBe("needs_client");
  });

  it("a recorded baseline that cannot be fetched fails closed -> needs_client", { timeout: 120_000 }, async () => {
    const t = await setup(9, crit2, { milestone: { baselineSha: "0123456789abcdef0123456789abcdef01234567" } });
    const { s, tamper, tests } = await tamperEvidence(t);
    expect(tamper).toMatchObject({ status: "unclear" });
    expect(tamper.summary).toMatch(/could not be fetched/);
    expect(tests).toMatchObject({ status: "unclear" });
    expect(s.m.status).toBe("needs_client");
  });

  it("re-entering verifying clears the previous delivery's response, window and decision", { timeout: 120_000 }, async () => {
    const stale = { action: "release", amountMinor: 10000, ruleIds: ["P1"], reason: "stale", deliveryId: "dlv_previous" };
    const future = new Date(Date.now() + 3_600_000);
    const t = await setup(5, [{ kind: "test", spec: { command: "npm test" }, required: true }, { kind: "judgment", spec: {}, required: false }], {
      milestone: { status: "held", clientResponse: "veto", reviewEndsAt: new Date(Date.now() - 1000), decision: stale, decidedAt: future },
    });
    await verify(t.job);
    const s = await t.state();
    expect(s.audits[0]).toBe("milestone.verifying");
    expect(s.m.status).toBe("needs_client");
    expect(s.m.clientResponse).toBeNull();
    expect(s.m.reviewEndsAt).toBeNull();
    expect(s.m.decision).toMatchObject({ action: "ask_client", deliveryId: t.deliveryId });
    expect(s.m.decidedAt!.getTime()).toBeLessThan(future.getTime());
  });
});
