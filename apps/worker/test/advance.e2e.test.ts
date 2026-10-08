/**
 * The advance job against the local Postgres. Opt in: MILESTONE_E2E=1.
 * The partner's PayPal client is a real PayPalClient over a fake fetchImpl that records every request.
 * Every row is tagged and removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

type Call = { method: string; path: string; requestId: string | null; body: unknown };
const calls: Call[] = [];
/** HTTP status the next payout POST answers with (0 = network error); null = success. */
let failNext: number | null = null;

const fakeFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const headers = new Headers(init?.headers);
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.pathname === "/v1/oauth2/token") return json(200, { access_token: "fake-token", expires_in: 3600 });
  const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
  calls.push({ method: init?.method ?? "GET", path: url.pathname, requestId: headers.get("PayPal-Request-Id"), body });
  if (url.pathname === "/v1/payments/payouts" && init?.method === "POST") {
    const fail = failNext;
    failNext = null;
    if (fail === 0) throw new Error("socket hang up");
    if (fail !== null) return json(fail, { name: "VALIDATION_ERROR", message: "rejected" });
    const rid = headers.get("PayPal-Request-Id");
    return json(201, { batch_header: { payout_batch_id: `BATCH-${rid}`, batch_status: "PENDING", sender_batch_header: { sender_batch_id: rid } } });
  }
  return json(404, { name: "NOT_FOUND" });
};

type AnyJob = Job<{ milestoneId: string } & Record<string, unknown>>;
const job = (data: Record<string, unknown> & { milestoneId: string }, meta: { retryCount?: number; retryLimit?: number } = {}) =>
  ({ id: randomUUID(), name: "advance", data, ...meta }) as unknown as AnyJob;

describe.skipIf(!run)("advance job end to end", async () => {
  const { advances, contracts, milestones, users } = await import("@milestone/core");
  const { PayPalClient } = await import("@milestone/money");
  const { getDb } = await import("../src/lib/db.ts");
  const { advance, advanceLedgerRef } = await import("../src/jobs/advance.ts");
  const db = getDb();
  const partner = new PayPalClient({ clientId: "partner-id", clientSecret: "partner-secret", env: "sandbox", fetchImpl: fakeFetch });
  const deps = { partner: () => partner };

  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_adv_${tag}`;
  const clientId = `usr_e2e_adv_c_${tag}`;
  const freelancerId = `usr_e2e_adv_f_${tag}`;
  const partnerId = `usr_e2e_adv_p_${tag}`;
  const advanceIds: string[] = [];

  beforeAll(async () => {
    await db.insert(users).values([
      { id: clientId, role: "client", name: "c", email: `c-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "f", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
      { id: partnerId, role: "partner", name: "p", email: `p-${tag}@e2e.test`, paypalEmail: `p-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "e2e advance", scopeText: "e2e", currency: "USD", totalMinor: 50_000, status: "active" });
  });

  afterAll(async () => {
    const q = (s: string, p: unknown[]) => db.$client.query(s, p);
    const ms = `(select id from milestones where contract_id = $1)`;
    await q(`delete from audit_log where contract_id = $1 or milestone_id in ${ms}`, [contractId]);
    await q(`delete from ledger_entries where ref = any($1)`, [advanceIds.map(advanceLedgerRef)]);
    await q(`delete from paypal_ops where kind = 'advance-payout' and key = any($1)`, [advanceIds]);
    await q(`delete from advances where milestone_id in ${ms}`, [contractId]);
    await q(`delete from milestones where contract_id = $1`, [contractId]);
    await q(`delete from contracts where id = $1`, [contractId]);
    await q(`delete from users where id = any($1)`, [[clientId, freelancerId, partnerId]]);
  });

  async function setup(seq: number, status: "funded" | "review" = "funded") {
    const milestoneId = `mst_e2e_adv_${tag}_${seq}`;
    const advanceId = `adv_e2e_${tag}_${seq}`;
    advanceIds.push(advanceId);
    await db.insert(milestones).values({ id: milestoneId, contractId, seq, title: `m${seq}`, amountMinor: 10_000, status, advanceEligible: true, paypalCaptureId: `CAP-${tag}-${seq}` });
    await db.insert(advances).values({ id: advanceId, milestoneId, partnerId, principalMinor: 5_833, feeBpsPerDay: 10, status: "offered", offer: { eligible: true, principalMinor: 5_833, expectedFeeMinor: 81 } });
    const state = async () => ({
      advance: await db.query.advances.findFirst({ where: (t, { eq }) => eq(t.id, advanceId) }),
      ops: (await db.$client.query(`select status, request_id, paypal_id from paypal_ops where kind = 'advance-payout' and key = $1`, [advanceId])).rows as Array<{ status: string; request_id: string; paypal_id: string | null }>,
      ledger: (await db.$client.query(`select txn_id, account, amount_minor::int as amount, direction from ledger_entries where ref = $1 order by account`, [advanceLedgerRef(advanceId)])).rows as Array<{ txn_id: string; account: string; amount: number; direction: string }>,
      audits: (await db.$client.query(`select event from audit_log where milestone_id = $1 order by created_at`, [milestoneId])).rows.map((r: { event: string }) => r.event),
    });
    return { milestoneId, advanceId, state };
  }
  const payouts = () => calls.filter((c) => c.path === "/v1/payments/payouts" && c.method === "POST");

  it("pays once from the partner, posts a balanced receivable, and a retry sends nothing", async () => {
    const t = await setup(1);
    calls.length = 0;
    await advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps);

    const s = await t.state();
    expect(payouts()).toHaveLength(1);
    expect(s.ops).toHaveLength(1);
    expect(s.ops[0]!.status).toBe("succeeded");
    expect(payouts()[0]!.requestId).toBe(s.ops[0]!.request_id);
    expect(s.ops[0]!.paypal_id).toBe(`BATCH-${s.ops[0]!.request_id}`);
    const body = payouts()[0]!.body as { items: Array<{ receiver: string; amount: { value: string; currency: string }; sender_item_id: string }> };
    expect(body.items).toEqual([expect.objectContaining({ receiver: `f-${tag}@e2e.test`, amount: { value: "58.33", currency: "USD" }, sender_item_id: t.advanceId })]);

    expect(s.advance?.status).toBe("funded");
    expect(s.advance?.fundedAt).toBeInstanceOf(Date);
    expect(s.ledger).toEqual([
      { txn_id: s.ledger[0]!.txn_id, account: `partner:${partnerId}:cash`, amount: 5_833, direction: "credit" },
      { txn_id: s.ledger[0]!.txn_id, account: `partner:${partnerId}:receivable`, amount: 5_833, direction: "debit" },
    ]);
    expect(s.ledger.reduce((sum, e) => sum + (e.direction === "debit" ? e.amount : -e.amount), 0)).toBe(0);
    expect(s.audits.filter((e) => e === "advance.funded")).toHaveLength(1);

    // Retries (a redelivered job, two at once) send nothing and post nothing.
    await Promise.all([
      advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps),
      advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps),
    ]);
    const again = await t.state();
    expect(payouts()).toHaveLength(1);
    expect(again.ledger).toHaveLength(2);
    expect(again.audits.filter((e) => e === "advance.funded")).toHaveLength(1);
  });

  it("a transient failure is retried with the same PayPal-Request-Id and pays once", async () => {
    const t = await setup(2);
    calls.length = 0;
    failNext = 0;
    await expect(advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps)).rejects.toThrow(/socket hang up/);
    let s = await t.state();
    expect(s.advance?.status).toBe("offered");
    expect(s.ledger).toHaveLength(0);

    await advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }, { retryCount: 1 }), deps);
    s = await t.state();
    expect(payouts()).toHaveLength(2);
    expect(payouts()[0]!.requestId).toBe(payouts()[1]!.requestId);
    expect(s.advance?.status).toBe("funded");
    expect(s.ledger).toHaveLength(2);
    expect(s.audits).toContain("paypal.advance_payout_error");
  });

  it("a rejected payout is recorded as failed, flagged, and never retried", async () => {
    const t = await setup(3);
    calls.length = 0;
    failNext = 422;
    await advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps);
    let s = await t.state();
    expect(s.ops[0]!.status).toBe("failed");
    expect(s.advance?.status).toBe("offered");
    expect(s.audits).toContain("advance.needs_operator");

    await advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps);
    s = await t.state();
    expect(payouts()).toHaveLength(1);
    expect(s.ledger).toHaveLength(0);
    expect(s.audits).toContain("advance.refused");
  });

  it("withdraws the offer without paying once the milestone has moved on", async () => {
    const t = await setup(4, "review");
    calls.length = 0;
    await advance(job({ milestoneId: t.milestoneId, advanceId: t.advanceId }), deps);
    const s = await t.state();
    expect(payouts()).toHaveLength(0);
    expect(s.advance).toBeUndefined();
    expect(s.ops).toHaveLength(0);
    expect(s.audits).toContain("advance.withdrawn");
  });
});
