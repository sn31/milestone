/**
 * End to end against the local Postgres and a throwaway local git repo. Opt in: MILESTONE_E2E=1.
 * enqueue is mocked so no real release job is scheduled; GitHub and the model are off (no tokens).
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const enqueued: Array<{ name: string; milestoneId: string; data: unknown; opts: unknown }> = [];
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (name: string, milestoneId: string, data: unknown, opts: unknown) => { enqueued.push({ name, milestoneId, data, opts }); return "job"; },
}));

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

describe.skipIf(!run)("verify job end to end", async () => {
  const { contracts, milestones, criteria, deliveries } = await import("@milestone/core");
  const { getDb } = await import("./db.js");
  const { verify } = await import("../jobs/verify.js");
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_${tag}`;
  let repo: string;
  let sha: string;

  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GITHUB_TOKEN;
    process.env.REVIEW_WINDOW_SECONDS = "60";
    repo = await mkdtemp(join(tmpdir(), "milestone-e2e-repo-"));
    await writeFile(join(repo, "package.json"), JSON.stringify({ name: "e2e", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"", fail: "node -e \"process.exit(1)\"" } }));
    await writeFile(join(repo, "README.md"), "# e2e\n");
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.email=e2e@test", "-c", "user.name=e2e", ...a], { cwd: repo }).toString().trim();
    g("init", "-q"); g("add", "."); g("commit", "-qm", "feat: add readme");
    sha = g("rev-parse", "HEAD");
    const db = getDb();
    await db.insert(contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "e2e", scopeText: "e2e", currency: "USD", totalMinor: 30000, repoFullName: `e2e/${tag}`, status: "active" });
  });

  afterAll(async () => {
    const db = getDb();
    for (const t of ["audit_log where contract_id", "deliveries where milestone_id in (select id from milestones where contract_id", "criteria where milestone_id in (select id from milestones where contract_id", "milestones where contract_id", "contracts where id"]) {
      await db.$client.query(`delete from ${t} = $1${t.includes("(") ? ")" : ""}`, [contractId]);
    }
    await rm(repo, { recursive: true, force: true });
  });

  async function setup(seq: number, crit: Array<{ kind: "test" | "file" | "judgment"; spec: Record<string, unknown>; required: boolean }>) {
    const db = getDb();
    const milestoneId = `mst_e2e_${tag}_${seq}`;
    await db.insert(milestones).values({ id: milestoneId, contractId, seq, title: `m${seq}`, amountMinor: 10000, status: "funded" });
    await db.insert(criteria).values(crit.map((c, i) => ({ id: `crt_e2e_${tag}_${seq}_${i}`, milestoneId, kind: c.kind, description: `${c.kind} ${i}`, spec: c.spec, required: c.required })));
    const deliveryId = `dlv_e2e_${tag}_${seq}`;
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "github_pr", ref: `e2e/${tag}#${seq}`, payload: { sha, title: "m", body: "", branch: `m${seq}-x`, clone_url: `file://${repo}` } });
    const job = { id: "j", name: "verify", data: { milestoneId, deliveryId } } as unknown as Job<{ milestoneId: string } & Record<string, unknown>>;
    const state = async () => ({
      m: (await db.query.milestones.findFirst({ where: (m, { eq }) => eq(m.id, milestoneId) }))!,
      d: (await db.query.deliveries.findFirst({ where: (d, { eq }) => eq(d.id, deliveryId) }))!,
      audits: (await db.$client.query(`select event from audit_log where milestone_id = $1 order by created_at`, [milestoneId])).rows.map((r: { event: string }) => r.event),
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
    expect(s.m.decision?.action).toBe("release");
    expect(s.m.reviewEndsAt).not.toBeNull();
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
});
