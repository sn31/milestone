/**
 * The aup job and ensureAupCheck against Postgres (opt in: MILESTONE_E2E=1, on a scratch database), with the model
 * check stubbed (no network): a model flag puts the contract in review, a failed model call does too (fail closed),
 * a clear answer is stored as clear, a job for an older text or a decided contract does nothing, and with a model
 * configured ensureAupCheck sets "checking" and enqueues the job (enqueue recorded, not sent). Rows are removed after.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ enqueued: [] as Array<{ name: string; key: string; data: Record<string, unknown>; opts: unknown }>, model: true }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (name: string, key: string, data: Record<string, unknown>, opts: unknown) => {
    fake.enqueued.push({ name, key, data, opts });
    return "job";
  },
}));
vi.mock("@milestone/verify", async (orig) => ({ ...(await orig<typeof import("@milestone/verify")>()), isModelConfigured: async () => fake.model }));

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

import * as core from "@milestone/core";
import { aupKeywordFlags, PAYPAL_AUP_SOURCE, type AupCheckResult } from "@milestone/verify";
import { eq, inArray } from "drizzle-orm";
import { ensureAup, runAupJob } from "../src/jobs/aup.ts";

describe.skipIf(!run)("the aup job", () => {
  const db = run ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const ids: string[] = [];
  let n = 0;

  async function contract(scope: string): Promise<string> {
    const id = `ctr_aupjob_${tag}_${++n}`;
    ids.push(id);
    await db.insert(core.contracts).values({ id, clientId: "usr_client", freelancerId: "usr_freelancer", title: `aup job ${n}`, scopeText: scope, currency: "USD", totalMinor: 1_000 });
    await db.insert(core.milestones).values({ id: `mst_aupjob_${tag}_${n}`, contractId: id, seq: 1, title: "One", amountMinor: 1_000 });
    await db.insert(core.criteria).values({ id: `crt_aupjob_${tag}_${n}`, milestoneId: `mst_aupjob_${tag}_${n}`, kind: "file", description: "README exists", spec: { path: "README.md" } });
    return id;
  }
  const row = async (id: string) => (await db.select().from(core.contracts).where(eq(core.contracts.id, id)))[0]!;
  /** A stubbed checkAcceptableUse: the real keyword pass plus the given model answer. */
  const stubCheck = (model: Partial<AupCheckResult>) => async (s: core.AupSubject): Promise<AupCheckResult> => ({
    mode: "model",
    model: "stub-model",
    policy: { ...PAYPAL_AUP_SOURCE },
    checkedAt: new Date().toISOString(),
    dropped: [],
    ...model,
    flags: [...aupKeywordFlags(s), ...(model.flags ?? [])],
  });

  afterAll(async () => {
    if (!run) return;
    await db.delete(core.auditLog).where(inArray(core.auditLog.contractId, ids));
    const ms = ids.map((_, i) => `mst_aupjob_${tag}_${i + 1}`);
    await db.delete(core.criteria).where(inArray(core.criteria.milestoneId, ms));
    await db.delete(core.milestones).where(inArray(core.milestones.id, ms));
    await db.delete(core.contracts).where(inArray(core.contracts.id, ids));
  });

  it("with a model configured, ensureAupCheck sets checking and enqueues one job for the text; the job stores a clear answer", async () => {
    fake.model = true;
    const id = await contract("A pricing page for a design studio.");
    expect(await ensureAup(db, id)).toEqual({ status: "checking", started: true });
    const c = await row(id);
    expect(c.aupStatus).toBe("checking");
    const sent = fake.enqueued.filter((e) => e.key === id);
    expect(sent).toEqual([{ name: "aup", key: id, data: { contractId: id, textHash: c.aupTextHash }, opts: { dedupe: `aup:${c.aupTextHash}` } }]);
    // Asking again while it runs changes nothing.
    expect(await ensureAup(db, id)).toEqual({ status: "checking", started: false });
    expect(fake.enqueued.filter((e) => e.key === id)).toHaveLength(1);

    expect(await runAupJob(db, { contractId: id, textHash: c.aupTextHash! }, stubCheck({ flags: [] }))).toEqual({ kind: "recorded", status: "clear" });
    expect(await row(id)).toMatchObject({ aupStatus: "clear", aupCheck: { mode: "model", model: "stub-model", flags: [] } });
  });

  it("a model flag with a quote puts the contract in review and audits the flag", async () => {
    fake.model = true;
    const id = await contract("A landing page for a fitness studio's members' raffle with cash prizes.");
    await ensureAup(db, id);
    const hash = (await row(id)).aupTextHash!;
    const out = await runAupJob(db, { contractId: id, textHash: hash }, stubCheck({ flags: [{ category: "gambling", section: "Activities Requiring Approval", quote: "raffle with cash prizes", rationale: "A prize draw.", confidence: 0.6, source: "model" }] }));
    expect(out).toEqual({ kind: "recorded", status: "review" });
    const flagged = await db.select().from(core.auditLog).where(eq(core.auditLog.contractId, id));
    expect(flagged.map((a) => a.event).sort()).toEqual([core.AUP_AUDIT.checked, core.AUP_AUDIT.flagged].sort());
    const detail = core.asRecord(flagged.find((a) => a.event === core.AUP_AUDIT.flagged)!.detail);
    expect(detail.flags).toEqual(expect.arrayContaining([expect.objectContaining({ category: "gambling", quote: "raffle with cash prizes", source: "model" })]));
  });

  it("a failed model call fails closed: review with the error, keyword flags kept", async () => {
    fake.model = true;
    const id = await contract("A pricing page for a design studio.");
    await ensureAup(db, id);
    const hash = (await row(id)).aupTextHash!;
    expect(await runAupJob(db, { contractId: id, textHash: hash }, stubCheck({ mode: "model_error", model: null, error: "APIConnectionError" }))).toEqual({ kind: "recorded", status: "review" });
    expect(await row(id)).toMatchObject({ aupStatus: "review", aupCheck: { mode: "model_error", error: "APIConnectionError", flags: [] } });
    expect(core.aupGate(await row(id))).toEqual({ refused: "aup_review" });
  });

  it("a job for an older text, or for a contract that is no longer checking, does nothing", async () => {
    fake.model = true;
    const id = await contract("A pricing page for a design studio.");
    await ensureAup(db, id);
    const old = (await row(id)).aupTextHash!;
    await db.update(core.contracts).set({ scopeText: "A pricing page for a design studio, with a FAQ." }).where(eq(core.contracts.id, id));
    expect(await runAupJob(db, { contractId: id, textHash: old }, stubCheck({}))).toEqual({ kind: "skipped", why: "stale" });
    // The changed text gets its own check (a new hash, a new job).
    expect(await ensureAup(db, id)).toEqual({ status: "checking", started: true });
    const fresh = (await row(id)).aupTextHash!;
    expect(fresh).not.toBe(old);
    await db.update(core.contracts).set({ aupStatus: "rejected" }).where(eq(core.contracts.id, id));
    expect(await runAupJob(db, { contractId: id, textHash: fresh }, stubCheck({}))).toEqual({ kind: "skipped", why: "not_checking" });
    expect(await ensureAup(db, id)).toEqual({ status: "rejected", started: false });
  });

  it("without a model the keyword pass is stored inline as keywords only, or review on a hit", async () => {
    fake.model = false;
    const clean = await contract("A pricing page for a design studio.");
    expect(await ensureAup(db, clean)).toEqual({ status: "keywords_only", started: true });
    const hit = await contract("A shop page for replica designer handbags.");
    expect(await ensureAup(db, hit)).toEqual({ status: "review", started: true });
    expect((await row(hit)).aupCheck).toMatchObject({ mode: "keywords", model: null, flags: [expect.objectContaining({ category: "ip_infringement", source: "keywords" })] });
    expect(fake.enqueued.filter((e) => e.key === clean || e.key === hit)).toEqual([]);
  });
});
