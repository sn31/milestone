/**
 * Review route and advance routes against the local Postgres with throwaway rows (opt in: MILESTONE_E2E=1).
 * The session and enqueue are mocked; every row created here is removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { e2e, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ actor: { userId: "usr_client", role: "client" } as { userId: string; role: string }, enqueued: [] as unknown[][], db: null as unknown }));
vi.mock("@/lib/session", async (orig) => ({ ...(await orig<typeof import("@/lib/session")>()), getActor: async () => state.actor }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paypal", () => ({ paypal: () => { throw new Error("no PayPal client in this test"); } }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (...args: unknown[]) => { state.enqueued.push(args); return "job"; },
}));

import * as core from "@milestone/core";
import { eq, inArray } from "drizzle-orm";
import { POST as review } from "../src/app/api/milestones/[id]/review/route";
import { GET as offer } from "../src/app/api/advances/offer/route";
import { POST as accept } from "../src/app/api/advances/accept/route";

describe.skipIf(!e2e)("review and advance routes against Postgres", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_t_${tag}`;
  const otherContractId = `ctr_o_${tag}`;
  const mid = (n: string) => `mst_t_${tag}_${n}`;
  const milestoneIds: string[] = [];
  const deliveryIds: string[] = [];
  const opKeys: string[] = [];

  const actAs = (userId: string, role: string) => { state.actor = { userId, role }; };
  const call = (id: string, action: unknown) =>
    review(new Request("http://localhost/api/milestones/x/review", { method: "POST", body: JSON.stringify({ action }) }), { params: Promise.resolve({ id }) });
  const getOffer = (milestoneId: string) => offer(new Request(`http://localhost/api/advances/offer?milestoneId=${milestoneId}`));
  const acceptReq = (milestoneId: string) => accept(new Request("http://localhost/api/advances/accept", { method: "POST", body: JSON.stringify({ milestoneId }) }));

  async function milestone(n: string, v: Partial<typeof core.milestones.$inferInsert> & { contract?: string }) {
    const { contract, ...rest } = v;
    const id = mid(n);
    milestoneIds.push(id);
    await db.insert(core.milestones).values({ id, contractId: contract ?? contractId, seq: milestoneIds.length, title: n, amountMinor: 10_000, status: "review", ...rest });
    return id;
  }
  async function delivery(milestoneId: string, verdict: Record<string, unknown>) {
    const id = `dlv_t_${tag}_${deliveryIds.length}`;
    deliveryIds.push(id);
    await db.insert(core.deliveries).values({ id, milestoneId, source: "manual", ref: "t", verdict });
    return id;
  }

  beforeAll(async () => {
    state.db = db;
    await db.insert(core.contracts).values({ id: contractId, clientId: "usr_client", freelancerId: "usr_freelancer", title: "t", scopeText: "t", currency: "USD", totalMinor: 100_000, status: "active" });
    // Someone else's contract: usr_partner stands in as the client and the freelancer.
    await db.insert(core.contracts).values({ id: otherContractId, clientId: "usr_partner", freelancerId: "usr_partner", title: "o", scopeText: "o", currency: "USD", totalMinor: 100_000, status: "active" });
  });
  beforeEach(() => { state.enqueued.length = 0; actAs("usr_client", "client"); });
  afterAll(async () => {
    if (!e2e) return;
    const cids = [contractId, otherContractId];
    await db.delete(core.auditLog).where(inArray(core.auditLog.contractId, cids));
    await db.delete(core.advances).where(inArray(core.advances.milestoneId, milestoneIds));
    await db.delete(core.paypalOps).where(inArray(core.paypalOps.key, opKeys));
    await db.delete(core.deliveries).where(inArray(core.deliveries.id, deliveryIds));
    await db.delete(core.criteria).where(inArray(core.criteria.milestoneId, milestoneIds));
    await db.delete(core.milestones).where(inArray(core.milestones.id, milestoneIds));
    await db.delete(core.contracts).where(inArray(core.contracts.id, cids));
  });

  describe("POST /api/milestones/[id]/review", () => {
    it("404 for an unknown milestone, 403 for a non-client and for another contract's client", async () => {
      const id = await milestone("auth", {});
      expect((await call(`nope_${tag}`, "approve")).status).toBe(404);
      actAs("usr_freelancer", "freelancer");
      const asFreelancer = await call(id, "approve");
      expect(asFreelancer.status).toBe(403);
      actAs("usr_partner", "partner");
      expect((await call(id, "veto")).status).toBe(403);
      actAs("usr_client", "client");
      expect((await call(mid("other"), "approve")).status).toBe(404);
      const foreign = await milestone("foreign", { contract: otherContractId });
      expect((await call(foreign, "approve")).status).toBe(403);
      expect(state.enqueued).toHaveLength(0);
    });

    it("409 recorded_for_showcase on a milestone recorded with simulator ids when PayPal is the real sandbox", async () => {
      const id = await milestone("recorded", { status: "needs_client", paypalOrderId: "SIM-ORD-SHOW410A7Q", paypalCaptureId: "SIM-CAP-SHOW410K2F" });
      const saved = process.env.PAYPAL_MODE;
      process.env.PAYPAL_MODE = "sandbox";
      try {
        const res = await call(id, "approve");
        expect(res.status).toBe(409);
        expect(await res.json()).toMatchObject({ reason: "recorded_for_showcase" });
        actAs("usr_freelancer", "freelancer");
        const adv = await acceptReq(id);
        expect(adv.status).toBe(409);
        expect(await adv.json()).toMatchObject({ reason: "recorded_for_showcase" });
      } finally {
        if (saved === undefined) delete process.env.PAYPAL_MODE;
        else process.env.PAYPAL_MODE = saved;
      }
      expect(state.enqueued).toHaveLength(0);
      const m = await db.query.milestones.findFirst({ where: eq(core.milestones.id, id) });
      expect(m?.clientResponse ?? null).toBeNull();
    });

    it("400 for an unknown action", async () => {
      expect((await call(mid("auth"), "burn")).status).toBe(400);
    });

    it("409 review_window_closed once the window has passed", async () => {
      const id = await milestone("closed", { reviewEndsAt: new Date(Date.now() - 60_000) });
      const res = await call(id, "veto");
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "review_window_closed" });
      expect((await db.query.milestones.findFirst({ where: eq(core.milestones.id, id) }))?.status).toBe("review");
    });

    it("409 required_criteria_not_passed when the verdict does not pass a required criterion", async () => {
      const id = await milestone("crit", {});
      const crit = `crt_t_${tag}`;
      await db.insert(core.criteria).values({ id: crit, milestoneId: id, kind: "judgment", description: "hero renders", required: true });
      const dlv = await delivery(id, { criteria: [{ criterion_id: crit, status: "fail" }] });
      await db.update(core.milestones).set({ decision: { action: "release", amountMinor: 10_000, ruleIds: [], reason: "t", deliveryId: dlv } as never }).where(eq(core.milestones.id, id));
      const res = await call(id, "approve");
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "required_criteria_not_passed", criteria: ["hero renders"] });
      expect(state.enqueued).toHaveLength(0);
    });

    it("409 needs_operator when a payout was claimed for a different delivery", async () => {
      const id = await milestone("ops", {});
      const dlv = await delivery(id, { criteria: [] });
      await db.update(core.milestones).set({ decision: { action: "release", amountMinor: 10_000, ruleIds: [], reason: "t", deliveryId: dlv } as never }).where(eq(core.milestones.id, id));
      opKeys.push(id);
      await db.insert(core.paypalOps).values({ id: `op_t_${tag}`, kind: "payout", key: id, requestId: randomUUID(), status: "failed", request: { claim: { deliveryId: "dlv_someone_else" } } });
      const res = await call(id, "approve");
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "needs_operator" });
    });

    it("an op claimed for this very delivery says the payout has already started", async () => {
      const id = await milestone("sent", {});
      const dlv = await delivery(id, { criteria: [] });
      await db.update(core.milestones).set({ decision: { action: "release", amountMinor: 10_000, ruleIds: [], reason: "t", deliveryId: dlv } as never }).where(eq(core.milestones.id, id));
      opKeys.push(id);
      await db.insert(core.paypalOps).values({ id: `op_t2_${tag}`, kind: "payout", key: id, requestId: randomUUID(), status: "sent", request: { claim: { deliveryId: dlv } } });
      const res = await call(id, "veto");
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "payout_sent" });
    });

    it("approve with nothing blocking queues the release job; veto inside the window holds", async () => {
      const ok = await milestone("ok", {});
      const dlv = await delivery(ok, { criteria: [] });
      await db.update(core.milestones).set({ decision: { action: "release", amountMinor: 10_000, ruleIds: [], reason: "t", deliveryId: dlv } as never }).where(eq(core.milestones.id, ok));
      const res = await call(ok, "approve");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, queued: "release" });
      expect(state.enqueued[0]).toEqual(["release", ok, { deliveryId: dlv }, { dedupe: `client-approve-${dlv}` }]);

      const v = await milestone("veto", { reviewEndsAt: new Date(Date.now() + 3_600_000) });
      const held = await call(v, "veto");
      expect(held.status).toBe(200);
      expect(await held.json()).toMatchObject({ ok: true, status: "held", changed: true });
      expect((await db.query.milestones.findFirst({ where: eq(core.milestones.id, v) }))?.status).toBe("held");
    });
  });

  describe("advances routes", () => {
    it("offer: freelancer only (403 for client and partner, 403 for someone else's milestone), 400/404 for bad input", async () => {
      const id = await milestone("adv-auth", { status: "funded", advanceEligible: true });
      actAs("usr_client", "client");
      expect((await getOffer(id)).status).toBe(403);
      actAs("usr_partner", "partner");
      expect((await getOffer(id)).status).toBe(403);
      actAs("usr_freelancer", "freelancer");
      expect((await offer(new Request("http://localhost/api/advances/offer"))).status).toBe(400);
      expect((await getOffer(`nope_${tag}`)).status).toBe(404);
      const foreign = await milestone("adv-foreign", { contract: otherContractId, status: "funded", advanceEligible: true });
      expect((await getOffer(foreign)).status).toBe(403);
    });

    it("offer: an ineligible milestone is priced as not eligible with the reason (the route answers 200, not 409)", async () => {
      const id = await milestone("adv-no", { status: "funded", advanceEligible: false });
      actAs("usr_freelancer", "freelancer");
      const res = await getOffer(id);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ milestoneId: id, advance: null, offer: { eligible: false, reason: expect.any(String) }, terms: null });
    });

    it("accept: freelancer only, and an ineligible milestone is 409 not_eligible with no advance created", async () => {
      const id = await milestone("adv-acc", { status: "funded", advanceEligible: false });
      actAs("usr_client", "client");
      expect((await acceptReq(id)).status).toBe(403);
      actAs("usr_freelancer", "freelancer");
      const res = await acceptReq(id);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ reason: "not_eligible" });
      expect(await db.select().from(core.advances).where(eq(core.advances.milestoneId, id))).toHaveLength(0);
      expect(state.enqueued).toHaveLength(0);
    });
  });
});
