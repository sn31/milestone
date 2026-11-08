/**
 * Showcase rows recorded with simulator ids, on the real sandbox (PAYPAL_MODE=sandbox): the release and advance jobs
 * stop before PayPal is called, claim nothing and say why. Against the local Postgres; opt in: MILESTONE_E2E=1.
 * PayPal is a fake that records calls. Every row is tagged and removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
vi.mock("../src/lib/paypal.js", () => ({
  paypal: () => ({
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      throw new Error(`unexpected PayPal call ${method} ${path}`);
    },
  }),
}));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async () => "job",
}));

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

type AnyJob = Job<{ milestoneId: string } & Record<string, unknown>>;
const job = (data: Record<string, unknown> & { milestoneId: string }) => ({ id: randomUUID(), name: "x", data }) as unknown as AnyJob;

describe.skipIf(!run)("recorded showcase rows on the real sandbox", async () => {
  const { advances, contracts, deliveries, milestones, users } = await import("@milestone/core");
  const { PayPalClient } = await import("@milestone/money");
  const { getDb } = await import("../src/lib/db.ts");
  const { release } = await import("../src/jobs/release.ts");
  const { advance } = await import("../src/jobs/advance.ts");
  const db = run ? getDb() : (undefined as unknown as ReturnType<typeof getDb>);
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_rec_${tag}`;
  const clientId = `usr_e2e_rec_c_${tag}`;
  const freelancerId = `usr_e2e_rec_f_${tag}`;
  const partnerId = `usr_e2e_rec_p_${tag}`;
  const partnerCalls: string[] = [];
  const partner = new PayPalClient({
    clientId: "p",
    clientSecret: "s",
    env: "sandbox",
    refuseSimulatorIds: true,
    fetchImpl: async (url) => {
      partnerCalls.push(String(url));
      return new Response('{"access_token":"t","expires_in":3600}');
    },
  });
  const savedMode = process.env.PAYPAL_MODE;

  beforeAll(async () => {
    process.env.PAYPAL_MODE = "sandbox";
    await db.insert(users).values([
      { id: clientId, role: "client", name: "c", email: `c-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "f", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
      { id: partnerId, role: "partner", name: "p", email: `p-${tag}@e2e.test`, paypalEmail: `p-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "e2e", scopeText: "e2e", currency: "USD", totalMinor: 30_000, status: "active" });
  });

  afterAll(async () => {
    if (savedMode === undefined) delete process.env.PAYPAL_MODE;
    else process.env.PAYPAL_MODE = savedMode;
    if (!run) return;
    const q = (s: string, p: unknown[]) => db.$client.query(s, p);
    const ms = `(select id from milestones where contract_id = $1)`;
    await q(`delete from audit_log where contract_id = $1 or milestone_id in ${ms}`, [contractId]);
    await q(`delete from paypal_ops where key in ${ms} or key in (select id from advances where milestone_id in ${ms})`, [contractId]);
    await q(`delete from advances where milestone_id in ${ms}`, [contractId]);
    await q(`delete from deliveries where milestone_id in ${ms}`, [contractId]);
    await q(`delete from milestones where contract_id = $1`, [contractId]);
    await q(`delete from contracts where id = $1`, [contractId]);
    await q(`delete from users where id = any($1)`, [[clientId, freelancerId, partnerId]]);
  });

  const audits = async (milestoneId: string) => (await db.$client.query(`select event, detail from audit_log where milestone_id = $1 order by created_at`, [milestoneId])).rows as Array<{ event: string; detail: Record<string, unknown> }>;
  const ops = async (key: string) => (await db.$client.query(`select kind, status from paypal_ops where key = $1`, [key])).rows;

  it("release: a needs_client partial the client confirmed is refused before any claim or PayPal call", async () => {
    const milestoneId = `mst_e2e_rec_${tag}_1`;
    const deliveryId = `dlv_e2e_rec_${tag}_1`;
    await db.insert(milestones).values({
      id: milestoneId, contractId, seq: 1, title: "m1", amountMinor: 9000, status: "needs_client",
      paypalOrderId: "SIM-ORD-SHOW410A7Q", paypalCaptureId: "SIM-CAP-SHOW410K2F",
      decision: { action: "partial", amountMinor: 6000, ruleIds: ["P5"], reason: "2 of 3", deliveryId } as never, decidedAt: new Date(), clientResponse: "confirm_partial",
    });
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "upload", ref: "upload", verdict: { delivery_id: deliveryId, criteria: [], suspected_injection: false }, result: "partial", verifiedAt: new Date() });
    calls.length = 0;
    await release(job({ milestoneId, deliveryId }));
    expect(calls).toEqual([]);
    expect(await ops(milestoneId)).toEqual([]);
    const rows = await audits(milestoneId);
    expect(rows.map((r) => r.event)).toEqual(["release.refused_recorded"]);
    expect(rows[0]!.detail.paypalCaptureId).toBe("SIM-CAP-SHOW410K2F");
    const m = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) });
    expect(m?.status).toBe("needs_client");
  });

  it("release: in simulated mode the same row is not refused as recorded", async () => {
    process.env.PAYPAL_MODE = "simulated";
    try {
      const { recordedForShowcase } = await import("@milestone/core");
      expect(recordedForShowcase({ paypalOrderId: "SIM-ORD-SHOW410A7Q", paypalCaptureId: "SIM-CAP-SHOW410K2F" })).toBe(false);
    } finally {
      process.env.PAYPAL_MODE = "sandbox";
    }
  });

  it("advance: an offered advance on a recorded milestone is withdrawn without calling the partner's PayPal", async () => {
    const milestoneId = `mst_e2e_rec_${tag}_2`;
    const advanceId = `adv_e2e_rec_${tag}_2`;
    await db.insert(milestones).values({ id: milestoneId, contractId, seq: 2, title: "m2", amountMinor: 5000, status: "funded", paypalOrderId: "SIM-ORD-SHOW610A7Q", paypalCaptureId: "SIM-CAP-SHOW610K2F", advanceEligible: true });
    await db.insert(advances).values({ id: advanceId, milestoneId, partnerId, principalMinor: 3000, feeBpsPerDay: 10, status: "offered", offer: { expectedFeeMinor: 21 } });
    partnerCalls.length = 0;
    await advance(job({ milestoneId, advanceId }), { partner: () => partner });
    expect(partnerCalls).toEqual([]);
    expect(await ops(advanceId)).toEqual([]);
    const a = await db.query.advances.findFirst({ where: (t, { eq }) => eq(t.id, advanceId) });
    expect(a).toBeUndefined(); // withdrawn: nothing was claimed, so the offer is removed
    const rows = await audits(milestoneId);
    expect(rows.map((r) => r.event)).toEqual(["advance.withdrawn"]);
    expect(String(rows[0]!.detail.reason)).toMatch(/recorded for the showcase/);
  });
});
