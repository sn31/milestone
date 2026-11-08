/**
 * The PayPal Acceptable Use Policy gate through the routes a person uses, against Postgres with throwaway rows (opt in:
 * MILESTONE_E2E=1, on a scratch database seeded first: the routes act as the seeded demo users). No model: the check is
 * the keyword pass, run inline. Covers drafting (a flagged scope goes to review), signing and funding refused while in
 * review (each refusal audited), the operator's clear and reject on /ops, and a criteria edit re-checking the text.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ actor: { userId: "usr_client", role: "client" } as { userId: string; role: string }, db: null as unknown }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getActor: async () => state.actor }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@milestone/verify", async (orig) => ({ ...(await orig<typeof import("@milestone/verify")>()), isModelConfigured: async () => false }));
vi.mock("@/lib/paypal", async () => {
  const { createSimulatedPayPalClient } = await import("@milestone/money");
  const client = createSimulatedPayPalClient();
  return { paypal: () => client };
});

import * as core from "@milestone/core";
import { and, eq, inArray, like } from "drizzle-orm";
import { POST as createContract } from "../src/app/api/contracts/route";
import { POST as approve } from "../src/app/api/contracts/[id]/approve/route";
import { PATCH as editCriteria } from "../src/app/api/contracts/[id]/criteria/route";
import { POST as order } from "../src/app/api/milestones/[id]/order/route";
import { POST as resolveAup } from "../src/app/api/ops/aup/[contractId]/route";

describe.skipIf(!e2e)("PayPal AUP gate through the routes", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const contractIds: string[] = [];

  const actAs = (userId: string, role: string) => {
    state.actor = { userId, role };
  };
  const contractRow = async (id: string) => (await db.select().from(core.contracts).where(eq(core.contracts.id, id)))[0]!;
  const audits = async (contractId: string, event: string) => db.select().from(core.auditLog).where(and(eq(core.auditLog.contractId, contractId), eq(core.auditLog.event, event)));
  const firstMilestone = async (contractId: string) => (await db.select().from(core.milestones).where(eq(core.milestones.contractId, contractId)).orderBy(core.milestones.seq))[0]!;

  /** Drafts a contract through POST /api/contracts (no model: the demo compiler and the keyword pass). */
  async function draft(scope: string): Promise<string> {
    const form = new FormData();
    form.set("scope", scope);
    form.set("title", `aup ${tag}`);
    form.set("total", "30.00");
    form.set("currency", "USD");
    const res = await createContract(new Request("http://localhost/api/contracts", { method: "POST", body: form, headers: { accept: "application/json" } }));
    expect(res.status).toBe(303);
    const id = /\/contracts\/([^/?#]+)/.exec(new URL(res.headers.get("location")!).pathname)![1]!;
    contractIds.push(id);
    return id;
  }
  const sign = (contractId: string) => approve(new Request(`http://localhost/api/contracts/${contractId}/approve`, { method: "POST", body: new FormData(), headers: { accept: "application/json" } }), { params: Promise.resolve({ id: contractId }) });
  const fund = (milestoneId: string) => order(new Request(`http://localhost/api/milestones/${milestoneId}/order`, { method: "POST" }), { params: Promise.resolve({ id: milestoneId }) });
  const decide = (contractId: string, body: unknown) =>
    resolveAup(new Request(`http://localhost/api/ops/aup/${contractId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ contractId }) });

  beforeAll(() => {
    state.db = db;
  });
  beforeEach(() => actAs("usr_client", "client"));
  afterAll(async () => {
    if (!e2e) return;
    const ms = (await db.select({ id: core.milestones.id }).from(core.milestones).where(inArray(core.milestones.contractId, contractIds))).map((m) => m.id);
    await db.delete(core.auditLog).where(inArray(core.auditLog.contractId, contractIds));
    if (ms.length) {
      await db.delete(core.paypalOps).where(inArray(core.paypalOps.key, ms));
      await db.delete(core.auditLog).where(inArray(core.auditLog.milestoneId, ms));
      await db.delete(core.criteria).where(inArray(core.criteria.milestoneId, ms));
      await db.delete(core.milestones).where(inArray(core.milestones.id, ms));
    }
    await db.delete(core.contracts).where(inArray(core.contracts.id, contractIds));
    await db.delete(core.auditLog).where(like(core.auditLog.actor, `%${tag}%`));
  });

  it("a clean scope is checked when drafted (keywords only) and can be signed and funded", async () => {
    const id = await draft("A signup form with validation and a confirmation page for a bakery's newsletter.");
    const c = await contractRow(id);
    expect(c.aupStatus).toBe("keywords_only");
    expect(c.aupCheck).toMatchObject({ mode: "keywords", model: null, flags: [], policy: { url: expect.stringContaining("paypal.com/us/legalhub"), retrievedOn: "2026-11-07" } });
    expect(c.aupTextHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await audits(id, core.AUP_AUDIT.checked)).toHaveLength(1);

    expect((await sign(id)).status).toBe(303);
    actAs("usr_freelancer", "freelancer");
    expect((await sign(id)).status).toBe(303);
    expect((await contractRow(id)).status).toBe("active");
    actAs("usr_client", "client");
    const res = await fund((await firstMilestone(id)).id);
    expect(res.status, await res.clone().text()).toBe(200);
    expect(((await res.json()) as { orderId?: string }).orderId).toMatch(/\S/);
  });

  it("a flagged scope goes to review: neither party can sign, the client cannot fund, each refusal is audited; an operator clears it", async () => {
    const id = await draft("A promo page for an online casino with sports betting odds and a deposit form that takes crypto.");
    const c = await contractRow(id);
    expect(c.aupStatus).toBe("review");
    expect(c.aupCheck!.flags.map((f) => f.category).sort()).toEqual(["cryptocurrency", "gambling"]);
    for (const f of c.aupCheck!.flags) expect(core.aupContractText((await core.loadAupSubject(db, id))!.subject)).toContain(f.quote);
    const flagged = await audits(id, core.AUP_AUDIT.flagged);
    expect(flagged).toHaveLength(1);

    // Signing refused for both parties, with the reason, and audited.
    const r1 = await sign(id);
    expect(r1.status).toBe(409);
    expect(await r1.json()).toMatchObject({ reason: "aup_review" });
    actAs("usr_freelancer", "freelancer");
    expect((await sign(id)).status).toBe(409);
    expect((await contractRow(id)).freelancerApprovedAt).toBeNull();
    expect((await contractRow(id)).clientApprovedAt).toBeNull();
    const refusals = await audits(id, core.AUP_AUDIT.refused);
    expect(refusals.map((r) => core.asRecord(r.detail))).toEqual([
      expect.objectContaining({ action: "sign", reason: "aup_review", via: "approve_route" }),
      expect.objectContaining({ action: "sign", reason: "aup_review", via: "approve_route" }),
    ]);

    // Funding refused even if the contract were active (signatures written by hand here): no PayPal order is created.
    await db.update(core.contracts).set({ status: "active", clientApprovedAt: new Date(), freelancerApprovedAt: new Date() }).where(eq(core.contracts.id, id));
    actAs("usr_client", "client");
    const m = await firstMilestone(id);
    const f1 = await fund(m.id);
    expect(f1.status).toBe(409);
    expect(await f1.json()).toMatchObject({ reason: "aup_review" });
    expect(await db.select().from(core.paypalOps).where(and(eq(core.paypalOps.key, m.id), eq(core.paypalOps.kind, core.OP_KINDS.order)))).toEqual([]);
    expect((await audits(id, core.AUP_AUDIT.refused)).map((r) => core.asRecord(r.detail).action)).toContain("fund");

    // Only an operator, with a note, from review.
    expect((await decide(id, { action: "clear", note: "checked" })).status).toBe(403);
    actAs("usr_platform", "platform");
    expect((await decide(id, { action: "clear" })).status).toBe(400);
    expect((await decide(id, { action: "clear", note: `sandbox demo only ${tag}` })).status).toBe(200);
    expect((await decide(id, { action: "reject", note: "again" })).status).toBe(409);
    const cleared = await contractRow(id);
    expect(cleared.aupStatus).toBe("cleared");
    expect(cleared.aupCheck?.resolution).toMatchObject({ action: "clear", by: "usr_platform" });
    expect(await audits(id, core.AUP_AUDIT.cleared)).toHaveLength(1);

    actAs("usr_client", "client");
    expect((await fund(m.id)).status).toBe(200);
  });

  it("a rejected contract stays refused", async () => {
    const id = await draft("Landing page for a ponzi scheme that promises get rich quick returns.");
    expect((await contractRow(id)).aupStatus).toBe("review");
    actAs("usr_platform", "platform");
    expect((await decide(id, { action: "reject", note: `no ${tag}` })).status).toBe(200);
    expect(await audits(id, core.AUP_AUDIT.rejected)).toHaveLength(1);
    actAs("usr_freelancer", "freelancer");
    const r = await sign(id);
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ reason: "aup_rejected" });
  });

  it("a criteria edit re-checks the contract text: a flagged edit sends a clear contract to review", async () => {
    const id = await draft("A pricing page with three plans and a FAQ for a design studio.");
    expect((await contractRow(id)).aupStatus).toBe("keywords_only");
    const before = (await contractRow(id)).aupTextHash;
    const m = await firstMilestone(id);
    const res = await editCriteria(
      new Request(`http://localhost/api/contracts/${id}/criteria`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ milestoneId: m.id, operations: [{ op: "add", criterion: { kind: "judgment", description: "The page lists the forex trading signals the studio sells", spec: {} } }] }),
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(res.status).toBe(200);
    const after = await contractRow(id);
    expect(after.aupTextHash).not.toBe(before);
    expect(after.aupStatus).toBe("review");
    expect(after.aupCheck!.flags).toEqual([expect.objectContaining({ category: "securities", source: "keywords", quote: expect.stringContaining("forex trading") })]);
    expect((await sign(id)).status).toBe(409);
  });
});
