/**
 * Release + settle against the local Postgres. Opt in: MILESTONE_E2E=1.
 * PayPal is a fake client that records calls; enqueue is mocked. Every row is tagged and removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; path: string; body: unknown; requestId: string | undefined }> = [];
let failNextRefund = false;
vi.mock("../src/lib/paypal.js", () => ({
  paypal: () => ({
    request: async (method: string, path: string, body: unknown, opts?: { requestId?: string }) => {
      calls.push({ method, path, body, requestId: opts?.requestId });
      if (path === "/v1/payments/payouts") return { batch_header: { payout_batch_id: `BATCH-${opts?.requestId}`, batch_status: "PENDING", sender_batch_header: { sender_batch_id: opts?.requestId } } };
      if (path.endsWith("/refund")) {
        if (failNextRefund) { failNextRefund = false; throw new Error("refund refused"); }
        return { id: `REF-${opts?.requestId}`, status: "PENDING" };
      }
      throw new Error(`unexpected PayPal call ${method} ${path}`);
    },
  }),
}));
const enqueued: Array<{ name: string; milestoneId: string; data: unknown }> = [];
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (name: string, milestoneId: string, data: unknown) => { enqueued.push({ name, milestoneId, data }); return "job"; },
}));

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

type AnyJob = Job<{ milestoneId: string } & Record<string, unknown>>;
const job = (data: Record<string, unknown> & { milestoneId: string }) => ({ id: randomUUID(), name: "x", data }) as unknown as AnyJob;

describe.skipIf(!run)("release and settle end to end", async () => {
  const { contracts, milestones, users, criteria, deliveries, webhookEvents } = await import("@milestone/core");
  const { getDb } = await import("../src/lib/db.js");
  const { release } = await import("../src/jobs/release.js");
  const { settle } = await import("../src/jobs/settle.js");
  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_rs_${tag}`;
  const clientId = `usr_e2e_c_${tag}`;
  const freelancerId = `usr_e2e_f_${tag}`;
  const eventIds: string[] = [];
  const past = () => new Date(Date.now() - 60_000);

  beforeAll(async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    await db.insert(users).values([
      { id: clientId, role: "client", name: "c", email: `c-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "f", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "e2e", scopeText: "e2e", currency: "USD", totalMinor: 50_000, status: "active" });
  });

  afterAll(async () => {
    const q = (s: string, p: unknown[]) => db.$client.query(s, p);
    const ms = `(select id from milestones where contract_id = $1)`;
    await q(`delete from audit_log where contract_id = $1 or milestone_id in ${ms}`, [contractId]);
    await q(`delete from ledger_entries where ref in (select 'release:' || id from milestones where contract_id = $1) or ref in (select 'refund:' || id from milestones where contract_id = $1)`, [contractId]);
    await q(`delete from paypal_ops where key in ${ms} or exists (select 1 from milestones m where m.contract_id = $1 and starts_with(paypal_ops.key, m.id || ':'))`, [contractId]);
    await q(`delete from webhook_events where event_id = any($1)`, [eventIds]);
    await q(`delete from deliveries where milestone_id in ${ms}`, [contractId]);
    await q(`delete from criteria where milestone_id in ${ms}`, [contractId]);
    await q(`delete from milestones where contract_id = $1`, [contractId]);
    await q(`delete from contracts where id = $1`, [contractId]);
    await q(`delete from users where id = any($1)`, [[clientId, freelancerId]]);
  });

  async function setup(seq: number, m: { status: "review" | "needs_client"; decision: Record<string, unknown>; clientResponse?: string; required?: "pass" | "unclear" }) {
    const milestoneId = `mst_e2e_rs_${tag}_${seq}`;
    const deliveryId = `dlv_e2e_rs_${tag}_${seq}`;
    await db.insert(milestones).values({
      id: milestoneId, contractId, seq, title: `m${seq}`, amountMinor: 10_000, status: m.status, paypalCaptureId: `CAP-${tag}-${seq}`,
      decision: { ...m.decision, deliveryId } as never, decidedAt: new Date(), reviewEndsAt: m.status === "review" ? past() : null, clientResponse: m.clientResponse ?? null,
    });
    const critId = `crt_e2e_rs_${tag}_${seq}`;
    await db.insert(criteria).values({ id: critId, milestoneId, kind: "test", description: "tests", spec: {}, required: true });
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "manual", ref: `e2e-${seq}`, verdict: { delivery_id: deliveryId, suspected_injection: false, criteria: [{ criterion_id: critId, status: m.required ?? "pass", confidence: 0.9, evidence_ids: ["e"], rationale: "" }] }, result: "pass", verifiedAt: new Date() });
    const state = async () => ({
      m: (await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) }))!,
      ops: (await db.$client.query(`select kind, key, status, paypal_id, response from paypal_ops where key = $1 or starts_with(key, $1 || ':') order by key`, [milestoneId])).rows as Array<{ kind: string; key: string; status: string; paypal_id: string | null; response: { items?: Record<string, { status: string }> } | null }>,
      ledger: (await db.$client.query(`select ref, account, amount_minor::int as amount, direction from ledger_entries where ref like $1 order by ref, account`, [`%:${milestoneId}%`])).rows as Array<{ ref: string; account: string; amount: number; direction: string }>,
      audits: (await db.$client.query(`select event from audit_log where milestone_id = $1 order by created_at`, [milestoneId])).rows.map((r: { event: string }) => r.event),
    });
    return { milestoneId, deliveryId, state };
  }

  async function webhook(type: string, resource: Record<string, unknown>) {
    const eventId = `WH-e2e-${tag}-${randomUUID().slice(0, 8)}`;
    eventIds.push(eventId);
    await db.insert(webhookEvents).values({ id: randomUUID(), source: "paypal", eventId, type, payload: { id: eventId, event_type: type, resource } });
    return eventId;
  }
  const item = (milestoneId: string, party: string, batch: string, value = "100.00") => ({ payout_batch_id: batch, payout_item_id: `I-${randomUUID().slice(0, 6)}`, transaction_status: "SUCCESS", payout_item: { sender_item_id: `${milestoneId}:${party}`, amount: { value, currency: "USD" } } });

  it("pays once, skips stale jobs, and concurrent settles post the ledger once", async () => {
    const t = await setup(1, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: "dlv_old" }));
    expect(calls).toHaveLength(0);
    expect((await t.state()).audits).toContain("release.skipped");

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(calls.filter((c) => c.path === "/v1/payments/payouts")).toHaveLength(1);
    const s1 = await t.state();
    expect(s1.ops).toMatchObject([{ kind: "payout", key: t.milestoneId, status: "sent" }]);
    const batch = s1.ops[0]!.paypal_id!;

    // Two different events for the same item (PayPal re-sent it) settling at the same time.
    const a = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch, "99.50"));
    const b = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch, "99.50"));
    await Promise.all([settle(job({ milestoneId: t.milestoneId, eventId: a })), settle(job({ milestoneId: t.milestoneId, eventId: b })), settle(job({ milestoneId: t.milestoneId, eventId: a }))]);
    const s2 = await t.state();
    expect(s2.m.status).toBe("released");
    expect(s2.ledger).toEqual([
      { ref: `release:${t.milestoneId}`, account: `freelancer:${freelancerId}`, amount: 9_950, direction: "credit" },
      { ref: `release:${t.milestoneId}`, account: `held:${t.milestoneId}`, amount: 9_950, direction: "debit" },
    ]);
    expect(s2.ops[0]).toMatchObject({ status: "succeeded", response: { items: { freelancer: { status: "succeeded" } } } });
  });

  it("a hold before the job runs stops the release", async () => {
    const t = await setup(2, { status: "needs_client", decision: { action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "2 of 3" }, clientResponse: "hold" });
    calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(calls).toHaveLength(0);
    expect((await t.state()).ops).toEqual([]);
  });

  it("approve on an ask_client whose required criterion is unclear is refused by the job", async () => {
    const t = await setup(3, { status: "needs_client", decision: { action: "ask_client", amountMinor: 0, ruleIds: ["P3"], reason: "unclear" }, clientResponse: "approve", required: "unclear" });
    calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(calls).toHaveLength(0);
    expect((await t.state()).audits).toContain("release.skipped");
  });

  it("a refund-only partial retries a failing refund and settles on PAYMENT.CAPTURE.REFUNDED", async () => {
    const t = await setup(4, { status: "needs_client", decision: { action: "ask_client", amountMinor: 0, ruleIds: ["P4"], reason: "cap" }, clientResponse: "confirm_partial" });
    calls.length = 0;
    failNextRefund = true;
    await expect(release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }))).rejects.toThrow("refund refused");
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const refunds = calls.filter((c) => c.path.endsWith("/refund"));
    expect(refunds).toHaveLength(2);
    expect(refunds[0]!.requestId).toBe(refunds[1]!.requestId);
    expect(calls.filter((c) => c.path === "/v1/payments/payouts")).toHaveLength(0);
    const s1 = await t.state();
    expect(s1.ops).toMatchObject([{ kind: "refund", status: "sent" }]);

    const e = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: s1.ops[0]!.paypal_id, status: "COMPLETED", amount: { value: "100.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("partial_released");
    expect(s2.ops).toMatchObject([{ kind: "refund", status: "succeeded" }]);
    expect(s2.ledger.map((l) => [l.ref, l.amount, l.direction])).toEqual([[`refund:${t.milestoneId}`, 10_000, "credit"], [`refund:${t.milestoneId}`, 10_000, "debit"]]);
  });

  it("a failed freelancer item holds the milestone and fails the op, so a later release cannot think it was paid", async () => {
    const t = await setup(5, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const e = await webhook("PAYMENT.PAYOUTS-ITEM.FAILED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "FAILED", errors: { name: "RECEIVER_UNREGISTERED" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops).toMatchObject([{ status: "failed", response: { items: { freelancer: { status: "failed" } } } }]);
    expect(s.ledger).toEqual([]);
  });
});
