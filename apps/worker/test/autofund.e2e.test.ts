/**
 * The auto-fund rule end to end against Postgres (opt in: MILESTONE_E2E=1, on a scratch database), with the PayPal
 * simulator in memory behind a recording fetch. Milestone 1 is released through the real release and settle jobs (the
 * simulator's payout webhooks are stored and settled as the webhook route would), settle enqueues autofund for
 * milestone 2, and the real autofund job funds it from the client's saved PayPal, saved through the real vault flow.
 * No model is involved anywhere. enqueue is recorded instead of sent to pg-boss. Every row carries a random tag and is
 * removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  const calls: Array<{ method: string; path: string; requestId: string | null; body: unknown; status: number }> = [];
  /** When set, the next vault charge reaches the simulator (so it happens) but its answer is replaced by this status. */
  const fault: { vaultChargeStatus: number | null } = { vaultChargeStatus: null };
  const events: Array<{ id: string; event_type: string; resource: Record<string, unknown> }> = [];
  const enqueued: Array<{ name: string; milestoneId: string; data: Record<string, unknown>; opts: unknown }> = [];
  return { calls, fault, events, enqueued, client: null as unknown };
});

vi.mock("../src/lib/paypal.js", async () => {
  const { PayPalClient, simulatedFetch } = await import("@milestone/money");
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const requestId = new Headers(init?.headers).get("PayPal-Request-Id");
    let body: unknown = null;
    try { body = typeof init?.body === "string" ? JSON.parse(init.body) : null; } catch { body = init?.body ?? null; }
    const res = await simulatedFetch(input, init);
    const isVaultCharge = method === "POST" && url.pathname === "/v2/checkout/orders" && JSON.stringify(body ?? {}).includes("vault_id");
    if (url.pathname !== "/v1/oauth2/token") fake.calls.push({ method, path: url.pathname, requestId, body, status: res.status });
    if (isVaultCharge && fake.fault.vaultChargeStatus !== null) {
      const status = fake.fault.vaultChargeStatus;
      fake.fault.vaultChargeStatus = null;
      return new Response(JSON.stringify({ name: "INTERNAL_SERVER_ERROR", message: "simulated lost answer" }), { status, headers: { "content-type": "application/json" } });
    }
    return res;
  };
  const client = new PayPalClient({ clientId: "SIM-platform", clientSecret: "SIM-secret", env: "sandbox", fetchImpl: fetchImpl as typeof fetch });
  fake.client = client;
  return { paypal: () => client };
});
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (name: string, milestoneId: string, data: Record<string, unknown>, opts: unknown) => {
    fake.enqueued.push({ name, milestoneId, data, opts });
    return "job";
  },
}));

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }
process.env.PAYPAL_MODE = "simulated";

type AnyJob = Job<{ milestoneId: string } & Record<string, unknown>>;
const job = (data: Record<string, unknown> & { milestoneId: string }, meta: { id?: string; retryCount?: number } = {}) =>
  ({ id: meta.id ?? randomUUID(), name: "x", data, ...(meta.retryCount !== undefined ? { retryCount: meta.retryCount } : {}) }) as unknown as AnyJob;

describe.skipIf(!run)("auto-fund after a release", async () => {
  const core = await import("@milestone/core");
  const money = await import("@milestone/money");
  const { getDb } = await import("../src/lib/db.ts");
  const { release } = await import("../src/jobs/release.ts");
  const { settle } = await import("../src/jobs/settle.ts");
  const { autofund, AUTOFUND_EVENT } = await import("../src/jobs/autofund.ts");
  const { paypal } = await import("../src/lib/paypal.ts");
  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  const clientId = `usr_e2e_afc_${tag}`;
  const freelancerId = `usr_e2e_aff_${tag}`;
  const users = [clientId, freelancerId];
  const contractIds: string[] = [];
  const mandateIds: string[] = [];
  const eventIds: string[] = [];
  let vaultId = "";
  let n = 0;
  const q = (text: string, params: unknown[]) => db.$client.query(text, params);

  /** An approved contract: milestone 1 in review on a P6 release decision whose window closed, the rest draft. */
  async function contract(amounts: number[]) {
    const id = `ctr_e2e_af_${tag}_${++n}`;
    contractIds.push(id);
    await db.insert(core.contracts).values({ id, clientId, freelancerId, title: `autofund ${tag}`, scopeText: "t", currency: "USD", totalMinor: amounts.reduce((a, b) => a + b, 0), status: "active", clientApprovedAt: new Date(), freelancerApprovedAt: new Date() });
    const ms = amounts.map((_, i) => `mst_e2e_af_${tag}_${n}_${i + 1}`);
    const deliveryId = `dlv_e2e_af_${tag}_${n}`;
    const critId = `crt_e2e_af_${tag}_${n}`;
    for (const [i, amountMinor] of amounts.entries()) {
      await db.insert(core.milestones).values({ id: ms[i]!, contractId: id, seq: i + 1, title: `M${i + 1}`, amountMinor, status: i === 0 ? "review" : "draft", ...(i === 0 ? { paypalCaptureId: `CAP-${tag}-${n}`, decision: { action: "release", amountMinor, ruleIds: ["P6"], reason: "ok", deliveryId } as never, decidedAt: new Date(), reviewEndsAt: new Date(Date.now() - 60_000) } : {}) });
    }
    await db.insert(core.criteria).values({ id: critId, milestoneId: ms[0]!, kind: "test", description: "tests", spec: {}, required: true });
    await db.insert(core.deliveries).values({ id: deliveryId, milestoneId: ms[0]!, source: "manual", ref: "e2e", verdict: { delivery_id: deliveryId, suspected_injection: false, criteria: [{ criterion_id: critId, status: "pass", confidence: 0.9, evidence_ids: ["e"], rationale: "" }] }, result: "pass", verifiedAt: new Date() });
    // Milestone 1's funding, as the capture route would have booked it.
    await core.postTransaction(db, { ref: `capture:CAP-${tag}-${n}`, currency: "USD", entries: [{ account: core.accounts.client(clientId), amountMinor: amounts[0]!, direction: "debit" }, { account: core.accounts.held(ms[0]!), amountMinor: amounts[0]!, direction: "credit" }] });
    return { id, ms, deliveryId };
  }

  async function mandate(name: string, over: Partial<import("@milestone/core").CreateMandateInput> = {}) {
    const r = await core.createMandate(db, { userId: clientId, agentName: `af-${tag}-${name}`, actions: ["read", "fund"], fundCapMinor: 20_000, fundTotalCapMinor: 50_000, autoFundNext: true, currency: "USD", expiresAt: new Date(Date.now() + 86_400_000), ...over });
    mandateIds.push(r.mandate.id);
    return r.mandate;
  }

  /** Waits for the simulator's webhooks for `milestoneId`, stores them as the webhook route does, and settles each. */
  async function settleWebhooks(milestoneId: string, type: string) {
    for (let i = 0; i < 100 && !fake.events.some((e) => e.event_type === type && JSON.stringify(e.resource).includes(milestoneId)); i++) await new Promise((r) => setTimeout(r, 20));
    const mine = fake.events.filter((e) => e.event_type === type && JSON.stringify(e.resource).includes(milestoneId));
    expect(mine.length).toBeGreaterThan(0);
    for (const e of mine) {
      eventIds.push(e.id);
      await db.insert(core.webhookEvents).values({ id: randomUUID(), source: "paypal", eventId: e.id, type: e.event_type, payload: e }).onConflictDoNothing();
      await settle(job({ milestoneId, eventId: e.id }));
    }
  }

  const vaultCharges = () => fake.calls.filter((c) => c.method === "POST" && c.path === "/v2/checkout/orders" && JSON.stringify(c.body ?? {}).includes("vault_id"));
  const fundLegs = (mid: string) => q(`select account, direction, amount_minor::int as amount from ledger_entries where txn_id in (select txn_id from ledger_entries where account = $1 and direction = 'credit') order by account`, [core.accounts.held(mid)]).then((r) => r.rows);
  const autofundAudits = (mid: string) => q(`select actor, detail from audit_log where milestone_id = $1 and event = $2 order by created_at`, [mid, AUTOFUND_EVENT]).then((r) => r.rows as Array<{ actor: string; detail: Record<string, unknown> }>);
  const statusOf = async (mid: string) => (await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, mid) }))?.status;

  beforeAll(async () => {
    money.configureSimulator({ stateFile: null, webhookDelayMs: 5, deliver: (e) => void fake.events.push(e as never) });
    await db.insert(core.users).values([
      { id: clientId, role: "client", name: "Auto client", email: `afc-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "Auto freelancer", email: `aff-${tag}@e2e.test`, paypalEmail: `aff-${tag}@e2e.test` },
    ]);
    const started = await money.startVaultSetup(db, paypal(), { userId: clientId, returnUrl: "http://localhost/return", cancelUrl: "http://localhost/cancel" });
    expect(money.approveSimulatedSetupToken(started.setupTokenId)).not.toBeNull();
    const done = await money.completeVaultSetup(db, paypal(), { userId: clientId, setupTokenId: started.setupTokenId });
    if (!done.ok) throw new Error(`vault setup failed: ${done.reason}`);
    vaultId = done.paymentMethod.paypalPaymentTokenId;
  });

  afterAll(async () => {
    money.configureSimulator({ deliver: null });
    const ms = (await q(`select id from milestones where contract_id = any($1)`, [contractIds])).rows.map((r: { id: string }) => r.id);
    await q(`delete from audit_log where contract_id = any($1) or milestone_id = any($2) or actor like $3`, [contractIds, ms, `%${tag}%`]);
    await q(`delete from ledger_entries where txn_id in (select txn_id from ledger_entries where account = any($1))`, [ms.map((m: string) => core.accounts.held(m))]);
    await q(`delete from paypal_ops where key = any($1) or key in (select id from vault_setups where user_id = $2) or key in (select setup_token_id from vault_setups where user_id = $2)`, [ms, clientId]);
    await q(`delete from webhook_events where event_id = any($1)`, [eventIds]);
    await q(`delete from deliveries where milestone_id = any($1)`, [ms]);
    await q(`delete from criteria where milestone_id = any($1)`, [ms]);
    await q(`delete from milestones where id = any($1)`, [ms]);
    await q(`delete from contracts where id = any($1)`, [contractIds]);
    await q(`delete from agent_mandates where id = any($1)`, [mandateIds]);
    await q(`delete from vault_setups where user_id = any($1)`, [users]);
    await q(`delete from payment_methods where user_id = any($1)`, [users]);
    await q(`delete from users where id = any($1)`, [users]);
  });

  it("releases milestone 1 through the simulator, then the agent funds milestone 2 from the saved PayPal", async () => {
    const m = await mandate("main");
    const k = await contract([10_000, 15_000, 5_000]);
    fake.enqueued.length = 0;

    await release(job({ milestoneId: k.ms[0]!, deliveryId: k.deliveryId }));
    await settleWebhooks(k.ms[0]!, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    expect(await statusOf(k.ms[0]!)).toBe("released");

    // settle asked for milestone 2, once, keyed so a repeat is a no-op.
    const asks = fake.enqueued.filter((e) => e.name === "autofund");
    expect(asks).toEqual([{ name: "autofund", milestoneId: k.ms[1]!, data: { contractId: k.id, releasedMilestoneId: k.ms[0]! }, opts: { dedupe: "autofund" } }]);

    const before = vaultCharges().length;
    await autofund(job({ ...asks[0]!.data, milestoneId: asks[0]!.milestoneId }));
    expect(vaultCharges().length - before).toBe(1);
    const charge = vaultCharges().at(-1)!;
    expect(charge.requestId).toMatch(/\S/);
    expect((charge.body as { purchase_units: Array<{ reference_id: string }> }).purchase_units[0]!.reference_id).toBe(k.ms[1]!);

    const m2 = await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, k.ms[1]!) });
    expect(m2?.status).toBe("funded");
    expect(m2?.paypalCaptureId).toMatch(/\S/);
    expect(await statusOf(k.ms[2]!)).toBe("draft"); // only the next one

    // The ledger: client -> held for exactly milestone 2's amount.
    expect(await fundLegs(k.ms[1]!)).toEqual([
      { account: core.accounts.client(clientId), direction: "debit", amount: 15_000 },
      { account: core.accounts.held(k.ms[1]!), direction: "credit", amount: 15_000 },
    ]);
    // Audited as the agent on behalf of the client: the charge, the funding and the auto-fund result.
    const actor = core.agentActor(m);
    expect(actor).toBe(`agent:af-${tag}-main for ${clientId}`);
    const rows = (await q(`select actor, event from audit_log where milestone_id = $1 order by created_at`, [k.ms[1]!])).rows as Array<{ actor: string; event: string }>;
    expect(rows.filter((r) => r.actor === actor).map((r) => r.event)).toEqual(expect.arrayContaining([core.AUDIT_EVENTS.paypalVaultCharge, AUTOFUND_EVENT]));
    const [a] = await autofundAudits(k.ms[1]!);
    expect(a).toMatchObject({ actor, detail: { outcome: "funded", mandateId: m.id, onBehalfOf: clientId, releasedMilestoneId: k.ms[0]!, amountMinor: 15_000, currency: "USD", willRetry: false } });
    expect(JSON.stringify(a!.detail)).not.toContain(vaultId);
    expect(await core.mandateFundedMinor(db, m.id)).toBe(15_000);
    await core.revokeMandate(db, m.id);
  });

  it("a duplicate autofund enqueue charges once", async () => {
    const m = await mandate("dup");
    const k = await contract([1_000, 2_000]);
    await q(`update milestones set status = 'released' where id = $1`, [k.ms[0]]);
    const data = { milestoneId: k.ms[1]!, contractId: k.id, releasedMilestoneId: k.ms[0]! };
    const before = vaultCharges().length;
    await Promise.all([autofund(job(data)), autofund(job(data)), autofund(job(data))]);
    await autofund(job(data));
    // A run that finds another run's charge in flight may replay it, but only under the same PayPal-Request-Id, which
    // PayPal answers from its idempotency store: one charge.
    const sent = vaultCharges().slice(before);
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(new Set(sent.map((c) => c.requestId)).size).toBe(1);
    expect(await statusOf(k.ms[1]!)).toBe("funded");
    expect(await fundLegs(k.ms[1]!)).toHaveLength(2);
    expect((await q(`select count(*)::int as n from paypal_ops where kind = $1 and key = $2`, [core.VAULT_CHARGE_OP_KIND, k.ms[1]])).rows[0].n).toBe(1);
    expect(await core.mandateFundedMinor(db, m.id)).toBe(2_000);
    const outcomes = (await autofundAudits(k.ms[1]!)).map((r) => r.detail.outcome);
    expect(outcomes.filter((o) => o === "funded")).toHaveLength(1);
    expect(outcomes.every((o) => o === "funded" || o === "already" || o === "refused")).toBe(true);
    await core.revokeMandate(db, m.id);
  });

  it("retries a PayPal 5xx with the same request id and never retries a refusal", async () => {
    const m = await mandate("retry", { fundCapMinor: 3_000 });
    const k = await contract([1_000, 2_000, 4_000]);
    await q(`update milestones set status = 'released' where id = $1`, [k.ms[0]]);

    // The charge reaches PayPal but its answer is lost (503): the job throws for pg-boss to retry.
    fake.fault.vaultChargeStatus = 503;
    const first = job({ milestoneId: k.ms[1]!, contractId: k.id, releasedMilestoneId: k.ms[0]! });
    await expect(autofund(first)).rejects.toThrow(/PayPal did not answer definitely/);
    expect(await statusOf(k.ms[1]!)).toBe("draft");
    const [retrying] = await autofundAudits(k.ms[1]!);
    expect(retrying!.detail).toMatchObject({ outcome: "paypal_error", retryable: true, willRetry: true });
    await autofund(job(first.data, { id: first.id, retryCount: 1 }));
    const charges = vaultCharges().filter((c) => JSON.stringify(c.body).includes(k.ms[1]!));
    expect(charges).toHaveLength(2);
    expect(charges[1]!.requestId).toBe(charges[0]!.requestId);
    expect(await statusOf(k.ms[1]!)).toBe("funded");
    expect(await fundLegs(k.ms[1]!)).toHaveLength(2);

    // Milestone 3 is over the per-milestone fund cap: refused, audited, not thrown, no PayPal call.
    await q(`update milestones set status = 'released' where id = $1`, [k.ms[1]]);
    const before = vaultCharges().length;
    await autofund(job({ milestoneId: k.ms[2]!, contractId: k.id, releasedMilestoneId: k.ms[1]! }));
    expect(vaultCharges().length).toBe(before);
    expect(await statusOf(k.ms[2]!)).toBe("draft");
    const refusal = (await autofundAudits(k.ms[2]!)).at(-1)!;
    expect(refusal).toMatchObject({ actor: core.agentActor(m), detail: { outcome: "refused", reason: "fund_cap_exceeded", willRetry: false } });
    await core.revokeMandate(db, m.id);
  });

  it("does nothing without an auto-fund mandate: settle does not enqueue, a stale job is skipped", async () => {
    const k = await contract([1_000, 1_000]);
    fake.enqueued.length = 0;
    await release(job({ milestoneId: k.ms[0]!, deliveryId: k.deliveryId }));
    await settleWebhooks(k.ms[0]!, "PAYMENT.PAYOUTS-ITEM.SUCCEEDED");
    expect(await statusOf(k.ms[0]!)).toBe("released");
    expect(fake.enqueued.filter((e) => e.name === "autofund")).toEqual([]);
    const before = vaultCharges().length;
    await autofund(job({ milestoneId: k.ms[1]!, contractId: k.id }));
    expect(vaultCharges().length).toBe(before);
    expect((await autofundAudits(k.ms[1]!)).at(-1)).toMatchObject({ actor: "policy", detail: { outcome: "skipped", why: "no_auto_fund_mandate" } });
  });
});
