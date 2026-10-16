/**
 * The review route with an agent acting under a mandate ("Authorization: Bearer <token>"), against Postgres with
 * throwaway rows (opt in: MILESTONE_E2E=1). Covers every refusal code and one accepted early approval. enqueue is
 * mocked; every row created here is removed afterwards. Needs the seeded users usr_client and usr_freelancer.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ enqueued: [] as unknown[][], db: null as unknown }));
// A request with an Authorization header must never reach the cookie identity; this makes it loud if it does.
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getActor: async () => { throw new Error("cookie identity used"); } }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paypal", () => ({ paypal: () => { throw new Error("no PayPal client in this test"); } }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (...args: unknown[]) => { state.enqueued.push(args); return "job"; },
}));

import * as core from "@milestone/core";
import { and, eq, inArray } from "drizzle-orm";
import { POST as review } from "../src/app/api/milestones/[id]/review/route";

describe.skipIf(!e2e)("review route: agents under a mandate", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_ag_${tag}`;
  const eurContractId = `ctr_ag_eur_${tag}`;
  const otherContractId = `ctr_ag_o_${tag}`;
  const contractIds = [contractId, eurContractId, otherContractId];
  const milestoneIds: string[] = [];
  const deliveryIds: string[] = [];
  const mandateIds: string[] = [];
  const later = () => new Date(Date.now() + 86_400_000);

  const call = (id: string, action: unknown, token: string | null) =>
    review(
      new Request("http://localhost/api/milestones/x/review", {
        method: "POST",
        headers: token === null ? {} : { authorization: token.startsWith("Basic ") ? token : `Bearer ${token}` },
        body: JSON.stringify({ action }),
      }),
      { params: Promise.resolve({ id }) },
    );

  async function mandate(over: Partial<core.CreateMandateInput> = {}) {
    const r = await core.createMandate(db, { userId: "usr_client", agentName: `t-${tag}`, actions: ["read", "approve", "hold"], approveCapMinor: 20_000, currency: "USD", expiresAt: later(), ...over });
    mandateIds.push(r.mandate.id);
    return r;
  }
  async function delivery(milestoneId: string, verdict: Record<string, unknown>, receivedAt = new Date()) {
    const id = `dlv_ag_${tag}_${deliveryIds.length}`;
    deliveryIds.push(id);
    await db.insert(core.deliveries).values({ id, milestoneId, source: "manual", ref: "t", verdict, receivedAt });
    return id;
  }
  /** A milestone in `status` with a stored decision for a fresh delivery (all required criteria passing unless told). */
  async function milestone(n: string, o: { status?: core.MilestoneStatus; amountMinor?: number; decision?: Partial<core.PolicyDecision>; contract?: string; failCriterion?: boolean; reviewEndsAt?: Date } = {}) {
    const id = `mst_ag_${tag}_${n}`;
    milestoneIds.push(id);
    const amountMinor = o.amountMinor ?? 10_000;
    await db.insert(core.milestones).values({ id, contractId: o.contract ?? contractId, seq: milestoneIds.length, title: n, amountMinor, status: o.status ?? "review", reviewEndsAt: o.reviewEndsAt ?? new Date(Date.now() + 3_600_000) });
    const crit = `crt_ag_${tag}_${n}`;
    await db.insert(core.criteria).values({ id: crit, milestoneId: id, kind: "judgment", description: `${n} works`, required: true });
    const dlv = await delivery(id, { criteria: [{ criterion_id: crit, status: o.failCriterion ? "fail" : "pass" }] }, new Date(Date.now() - 60_000));
    const decision = { action: "release" as const, amountMinor, ruleIds: ["P6"], reason: "t", ...o.decision, deliveryId: dlv };
    await db.update(core.milestones).set({ decision }).where(eq(core.milestones.id, id));
    return { id, dlv };
  }
  const statusOf = async (id: string) => (await db.query.milestones.findFirst({ where: eq(core.milestones.id, id) }))?.status;
  const auditsOf = (id: string) => db.select().from(core.auditLog).where(eq(core.auditLog.milestoneId, id));

  beforeAll(async () => {
    state.db = db;
    await db.insert(core.contracts).values([
      { id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "t", scopeText: "t", currency: "USD", totalMinor: 100_000, status: "active" },
      { id: eurContractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "t", scopeText: "t", currency: "EUR", totalMinor: 100_000, status: "active" },
      { id: otherContractId, clientId: "usr_freelancer", freelancerId: "usr_freelancer", title: "o", scopeText: "o", currency: "USD", totalMinor: 100_000, status: "active" },
    ]);
  });
  beforeEach(() => { state.enqueued.length = 0; });
  afterAll(async () => {
    if (!e2e) return;
    await db.delete(core.auditLog).where(inArray(core.auditLog.contractId, contractIds));
    if (deliveryIds.length) await db.delete(core.deliveries).where(inArray(core.deliveries.id, deliveryIds));
    if (milestoneIds.length) await db.delete(core.criteria).where(inArray(core.criteria.milestoneId, milestoneIds));
    if (milestoneIds.length) await db.delete(core.milestones).where(inArray(core.milestones.id, milestoneIds));
    await db.delete(core.contracts).where(inArray(core.contracts.id, contractIds));
    if (mandateIds.length) await db.delete(core.agentMandates).where(inArray(core.agentMandates.id, mandateIds));
    await db.$client.end();
  });

  it("401 invalid_token for an unknown or malformed token, with no fallback to the cookie identity", async () => {
    const { id } = await milestone("badtoken");
    for (const t of ["msa_not-a-real-token", "nope", "Basic dXNlcjpwYXNz"]) {
      const res = await call(id, "approve", t);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ reason: "invalid_token" });
    }
    expect(state.enqueued).toHaveLength(0);
  });

  it("403 mandate_expired and 403 mandate_revoked", async () => {
    const { id } = await milestone("dead");
    const expired = await mandate();
    await db.update(core.agentMandates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(core.agentMandates.id, expired.mandate.id));
    const r1 = await call(id, "approve", expired.token);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ reason: "mandate_expired" });

    const revoked = await mandate();
    await core.revokeMandate(db, revoked.mandate.id, { userId: "usr_client" });
    const r2 = await call(id, "veto", revoked.token);
    expect(r2.status).toBe(403);
    expect(await r2.json()).toMatchObject({ reason: "mandate_revoked" });
    expect(state.enqueued).toHaveLength(0);
    expect(await statusOf(id)).toBe("review");
  });

  it("403 when the mandate's user is not the contract's client", async () => {
    const { id } = await milestone("foreign", { contract: otherContractId });
    const { token } = await mandate();
    expect((await call(id, "approve", token)).status).toBe(403);
  });

  it("403 mandate_missing_action: approve without approve, veto/hold without hold", async () => {
    const { id } = await milestone("noaction");
    const readOnly = await mandate({ actions: ["read", "fund"] });
    const r1 = await call(id, "approve", readOnly.token);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ reason: "mandate_missing_action" });
    const r2 = await call(id, "veto", readOnly.token);
    expect(r2.status).toBe(403);
    expect(await r2.json()).toMatchObject({ reason: "mandate_missing_action" });
    expect(state.enqueued).toHaveLength(0);
    expect(await statusOf(id)).toBe("review");
    // Refused agent attempts are audited under the agent's actor.
    const rows = await auditsOf(id);
    expect(rows.map((r) => r.event).sort()).toEqual(["agent.approve_refused", "agent.veto_refused"]);
    expect(rows.every((r) => r.actor === core.agentActor(readOnly.mandate))).toBe(true);
  });

  it("403 mandate_cap_exceeded above the cap, with no cap, and in another currency", async () => {
    const { id } = await milestone("cap", { amountMinor: 25_000 });
    const { token } = await mandate();
    const r1 = await call(id, "approve", token);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ reason: "mandate_cap_exceeded", amountMinor: 25_000, capMinor: 20_000 });

    const { id: small } = await milestone("nocap");
    const noCap = await mandate({ approveCapMinor: null });
    const r2 = await call(small, "approve", noCap.token);
    expect(r2.status).toBe(403);
    expect(await r2.json()).toMatchObject({ reason: "mandate_cap_exceeded" });

    const { id: eur } = await milestone("eur", { contract: eurContractId });
    const r3 = await call(eur, "approve", token);
    expect(r3.status).toBe(403);
    expect(await r3.json()).toMatchObject({ reason: "mandate_cap_exceeded" });
    expect(state.enqueued).toHaveLength(0);
  });

  it("409 not_release_decision unless it is the policy's P6 release for the current delivery in review", async () => {
    const { token } = await mandate();
    const expectRefused = async (id: string, action = "approve") => {
      const res = await call(id, action, token);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "not_release_decision" });
    };
    // needs_client on ask_client: a human may approve it, an agent may not.
    await expectRefused((await milestone("ask", { status: "needs_client", decision: { action: "ask_client", amountMinor: 0, ruleIds: ["P3"] } })).id);
    // A "release" that is not the policy's P6 rule.
    await expectRefused((await milestone("notp6", { decision: { ruleIds: ["P4"] } })).id);
    // A partial in needs_client: confirm_partial is never an agent's, and neither is approve.
    const partial = await milestone("partial", { status: "needs_client", decision: { action: "partial", amountMinor: 5_000, ruleIds: ["P5"] } });
    await expectRefused(partial.id, "confirm_partial");
    await expectRefused(partial.id);
    // The decision was made for an older delivery than the milestone's latest one.
    const stale = await milestone("stale");
    await delivery(stale.id, { criteria: [] });
    await expectRefused(stale.id);
    expect(state.enqueued).toHaveLength(0);
  });

  it("409 required_criteria_not_passed when a required criterion did not pass", async () => {
    const { id } = await milestone("crit", { failCriterion: true });
    const { token } = await mandate();
    const res = await call(id, "approve", token);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ reason: "required_criteria_not_passed", criteria: ["crit works"] });
    expect(state.enqueued).toHaveLength(0);
  });

  it("accepts an early approval of the policy's release within the cap, audited as the agent, and updates last_used_at", async () => {
    const { id, dlv } = await milestone("ok", { amountMinor: 20_000 });
    const { token, mandate: md } = await mandate();
    const res = await call(id, "approve", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: "release" });
    expect(state.enqueued).toEqual([["release", id, { deliveryId: dlv }, { dedupe: `client-approve-${dlv}` }]]);
    const [row] = await db.select().from(core.auditLog).where(and(eq(core.auditLog.milestoneId, id), eq(core.auditLog.event, "client.approve")));
    expect(row).toMatchObject({ actor: `agent:t-${tag} for usr_client`, detail: { deliveryId: dlv, via: "agent", mandateId: md.id, onBehalfOf: "usr_client" } });
    const [after] = await db.select().from(core.agentMandates).where(eq(core.agentMandates.id, md.id));
    expect(after?.lastUsedAt).toBeInstanceOf(Date);
    expect((await db.query.milestones.findFirst({ where: eq(core.milestones.id, id) }))?.clientResponse).toBe("approve");
  });

  it("veto with hold in the mandate holds the milestone, audited as the agent", async () => {
    const { id } = await milestone("veto");
    const { token, mandate: md } = await mandate({ actions: ["hold"] });
    const res = await call(id, "veto", token);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "held", changed: true });
    expect(await statusOf(id)).toBe("held");
    const [row] = await db.select().from(core.auditLog).where(and(eq(core.auditLog.milestoneId, id), eq(core.auditLog.event, "client.veto")));
    expect(row?.actor).toBe(core.agentActor(md));
  });
});
