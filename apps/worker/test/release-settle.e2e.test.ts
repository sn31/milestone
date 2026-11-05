/**
 * Release + settle against the local Postgres. Opt in: MILESTONE_E2E=1.
 * PayPal is a fake client that records calls; enqueue is mocked. Every row is tagged and removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import type { Job } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const calls: Array<{ method: string; path: string; body: unknown; requestId: string | undefined }> = [];
let failNextRefund = false;
/** When set, the next payout / refund POST fails with a PayPalError of this HTTP status (or a plain network error for 0). */
const reject: { payout: number | null; refund: number | null } = { payout: null, refund: null };
const throwFor = async (kind: "payout" | "refund") => {
  const status = reject[kind];
  if (status === null) return;
  reject[kind] = null;
  if (status === 0) throw new Error(`${kind} socket hang up`);
  const { PayPalError } = await import("@milestone/money");
  throw new PayPalError(status, { name: "UNPROCESSABLE_ENTITY", message: `${kind} rejected` });
};
vi.mock("../src/lib/paypal.js", () => ({
  paypal: () => ({
    request: async (method: string, path: string, body: unknown, opts?: { requestId?: string }) => {
      calls.push({ method, path, body, requestId: opts?.requestId });
      if (path === "/v1/payments/payouts") {
        await throwFor("payout");
        return { batch_header: { payout_batch_id: `BATCH-${opts?.requestId}`, batch_status: "PENDING", sender_batch_header: { sender_batch_id: opts?.requestId } } };
      }
      if (path.endsWith("/refund")) {
        if (failNextRefund) { failNextRefund = false; throw new Error("refund refused"); }
        await throwFor("refund");
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
const job = (data: Record<string, unknown> & { milestoneId: string }, meta: { id?: string; retryCount?: number; retryLimit?: number } = {}) =>
  ({ id: meta.id ?? randomUUID(), name: "x", data, ...(meta.retryCount !== undefined ? { retryCount: meta.retryCount } : {}), ...(meta.retryLimit !== undefined ? { retryLimit: meta.retryLimit } : {}) }) as unknown as AnyJob;
/** Fixed clocks for the lease tests (no wall-clock dependence). */
const T0 = new Date("2026-10-08T12:00:00.000Z");
const at = (ms: number) => () => new Date(T0.getTime() + ms);

describe.skipIf(!run)("release and settle end to end", async () => {
  const { advances, contracts, milestones, users, criteria, deliveries, webhookEvents, postTransaction } = await import("@milestone/core");
  const { getDb } = await import("../src/lib/db.ts");
  const { release } = await import("../src/jobs/release.ts");
  const { settle } = await import("../src/jobs/settle.ts");
  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_rs_${tag}`;
  const clientId = `usr_e2e_c_${tag}`;
  const freelancerId = `usr_e2e_f_${tag}`;
  const partnerId = `usr_e2e_p_${tag}`;
  const eventIds: string[] = [];
  const past = () => new Date(Date.now() - 60_000);

  beforeAll(async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    await db.insert(users).values([
      { id: clientId, role: "client", name: "c", email: `c-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "f", email: `f-${tag}@e2e.test`, paypalEmail: `f-${tag}@e2e.test` },
      { id: partnerId, role: "partner", name: "p", email: `p-${tag}@e2e.test`, paypalEmail: `p-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "e2e", scopeText: "e2e", currency: "USD", totalMinor: 50_000, status: "active" });
  });

  afterAll(async () => {
    const q = (s: string, p: unknown[]) => db.$client.query(s, p);
    const ms = `(select id from milestones where contract_id = $1)`;
    await q(`delete from audit_log where contract_id = $1 or milestone_id in ${ms}`, [contractId]);
    // Every posting of these milestones touches their held account (release, partner release, refund, reversal).
    await q(`delete from ledger_entries where txn_id in (select txn_id from ledger_entries where account in (select 'held:' || id from milestones where contract_id = $1))`, [contractId]);
    await q(`delete from ledger_entries where ref in (select 'advance:' || id from advances where milestone_id in ${ms})`, [contractId]);
    await q(`delete from advances where milestone_id in ${ms}`, [contractId]);
    await q(`delete from paypal_ops where key in ${ms} or exists (select 1 from milestones m where m.contract_id = $1 and starts_with(paypal_ops.key, m.id || ':'))`, [contractId]);
    await q(`delete from webhook_events where event_id = any($1)`, [eventIds]);
    await q(`delete from deliveries where milestone_id in ${ms}`, [contractId]);
    await q(`delete from criteria where milestone_id in ${ms}`, [contractId]);
    await q(`delete from milestones where contract_id = $1`, [contractId]);
    await q(`delete from contracts where id = $1`, [contractId]);
    await q(`delete from users where id = any($1)`, [[clientId, freelancerId, partnerId]]);
  });

  async function setup(seq: number, m: { status: "review" | "needs_client"; decision: Record<string, unknown>; clientResponse?: string; required?: "pass" | "unclear"; advanceMinor?: number }) {
    const milestoneId = `mst_e2e_rs_${tag}_${seq}`;
    const deliveryId = `dlv_e2e_rs_${tag}_${seq}`;
    await db.insert(milestones).values({
      id: milestoneId, contractId, seq, title: `m${seq}`, amountMinor: 10_000, status: m.status, paypalCaptureId: `CAP-${tag}-${seq}`,
      decision: { ...m.decision, deliveryId } as never, decidedAt: new Date(), reviewEndsAt: m.status === "review" ? past() : null, clientResponse: m.clientResponse ?? null,
    });
    const critId = `crt_e2e_rs_${tag}_${seq}`;
    await db.insert(criteria).values({ id: critId, milestoneId, kind: "test", description: "tests", spec: {}, required: true });
    const verdict = (id: string) => ({ delivery_id: id, suspected_injection: false, criteria: [{ criterion_id: critId, status: m.required ?? "pass", confidence: 0.9, evidence_ids: ["e"], rationale: "" }] });
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "manual", ref: `e2e-${seq}`, verdict: verdict(deliveryId), result: "pass", verifiedAt: new Date() });
    if (m.advanceMinor) {
      const advanceId = `adv_e2e_rs_${tag}_${seq}`;
      await db.insert(advances).values({ id: advanceId, milestoneId, partnerId, principalMinor: m.advanceMinor, feeBpsPerDay: 10, status: "funded", offer: { expectedFeeMinor: 0 }, fundedAt: new Date() });
      // As the advance job posts it: the release reads the balance from the ledger.
      await postTransaction(db, { ref: `advance:${advanceId}`, currency: "USD", entries: [{ account: `partner:${partnerId}:receivable`, amountMinor: m.advanceMinor, direction: "debit" }, { account: `partner:${partnerId}:cash`, amountMinor: m.advanceMinor, direction: "credit" }] });
    }
    const state = async () => ({
      m: (await db.query.milestones.findFirst({ where: (t, { eq }) => eq(t.id, milestoneId) }))!,
      ops: (await db.$client.query(`select kind, key, status, paypal_id, response from paypal_ops where key = $1 or starts_with(key, $1 || ':') order by key, created_at, kind`, [milestoneId])).rows as Array<{ kind: string; key: string; status: string; paypal_id: string | null; response: { items?: Record<string, { status: string }> } | null }>,
      ledger: (await db.$client.query(`select ref, account, amount_minor::int as amount, direction from ledger_entries where ref like $1 order by ref, account`, [`%:${milestoneId}%`])).rows as Array<{ ref: string; account: string; amount: number; direction: string }>,
      audits: (await db.$client.query(`select event from audit_log where milestone_id = $1 order by created_at`, [milestoneId])).rows.map((r: { event: string }) => r.event),
      operator: (await db.$client.query(`select detail from audit_log where milestone_id = $1 and event = 'milestone.needs_operator' order by created_at`, [milestoneId])).rows.map((r: { detail: Record<string, unknown> }) => r.detail),
    });
    /** Simulates a re-verification: a new delivery with a new decision puts the milestone back in review. */
    const newDecision = async (n: number) => {
      const id = `${deliveryId}_new${n}`;
      await db.insert(deliveries).values({ id, milestoneId, source: "manual", ref: `e2e-${seq}-new${n}`, verdict: verdict(id), result: "pass", verifiedAt: new Date() });
      await db.$client.query(`update milestones set status = 'review', decision = jsonb_set(decision, '{deliveryId}', to_jsonb($2::text)), review_ends_at = now() - interval '1 minute', client_response = null where id = $1`, [milestoneId, id]);
      return id;
    };
    return { milestoneId, deliveryId, state, newDecision };
  }

  async function webhook(type: string, resource: Record<string, unknown>) {
    const eventId = `WH-e2e-${tag}-${randomUUID().slice(0, 8)}`;
    eventIds.push(eventId);
    await db.insert(webhookEvents).values({ id: randomUUID(), source: "paypal", eventId, type, payload: { id: eventId, event_type: type, resource } });
    return eventId;
  }
  const payouts = () => calls.filter((c) => c.path === "/v1/payments/payouts");
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
    const claiming = job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId });
    await expect(release(claiming)).rejects.toThrow("refund refused");
    // R7: another job for the same delivery does not touch the claim while the claiming job's lease is live.
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(calls.filter((c) => c.path.endsWith("/refund"))).toHaveLength(1);
    expect((await t.state()).audits).toContain("release.skipped_in_flight");
    // The pg-boss retry keeps the job id, so it resumes.
    await release(claiming);
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

  it("R4: a failed freelancer item holds the milestone for an operator and no job ever pays it again", async () => {
    const t = await setup(5, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const e = await webhook("PAYMENT.PAYOUTS-ITEM.FAILED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "FAILED", errors: { name: "RECEIVER_UNREGISTERED" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops).toMatchObject([{ status: "failed", response: { items: { freelancer: { status: "failed" } } } }]);
    expect(s.ledger).toEqual([]);
    expect(s.operator).toHaveLength(1);
    expect(s.operator[0]).toMatchObject({ paid: {}, failed: { freelancer: "RECEIVER_UNREGISTERED" }, payoutBatchId: batch });

    // The same job again, and a job for a brand-new decision: both refused, nothing sent.
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const d2 = await t.newDecision(1);
    await release(job({ milestoneId: t.milestoneId, deliveryId: d2 }));
    expect(payouts()).toHaveLength(1);
    const after = await t.state();
    expect(after.audits.filter((a) => a === "release.refused_needs_operator")).toHaveLength(2);
    expect(after.ops).toHaveLength(1);
  });

  it("R5/R7: a failed partner item holds the milestone, the op stays sent until the other item lands, and it never ends released", async () => {
    const t = await setup(6, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" }, advanceMinor: 4_000 });
    calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payouts()).toHaveLength(1);
    expect((payouts()[0]!.body as { items: unknown[] }).items).toHaveLength(2);
    const batch = (await t.state()).ops[0]!.paypal_id!;

    const pf = await webhook("PAYMENT.PAYOUTS-ITEM.FAILED", { ...item(t.milestoneId, "partner", batch, "40.00"), transaction_status: "FAILED", errors: { name: "RECEIVER_UNREGISTERED" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: pf }));
    const s1 = await t.state();
    expect(s1.m.status).toBe("held");
    expect(s1.ops[0]!.status).toBe("sent"); // R5: the freelancer item has no outcome yet
    expect(s1.operator[0]).toMatchObject({ failed: { partner: "RECEIVER_UNREGISTERED" }, pending: ["freelancer"] });

    const fs = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch, "60.00"));
    await settle(job({ milestoneId: t.milestoneId, eventId: fs }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("held"); // R7: never released
    expect(s2.ops[0]!.status).toBe("failed");
    expect(s2.ledger).toEqual([
      { ref: `release:${t.milestoneId}`, account: `freelancer:${freelancerId}`, amount: 6_000, direction: "credit" },
      { ref: `release:${t.milestoneId}`, account: `held:${t.milestoneId}`, amount: 6_000, direction: "debit" },
    ]);
    expect(s2.audits).not.toContain("milestone.released");
    expect(s2.operator.at(-1)).toMatchObject({ paid: { freelancer: 6_000 }, failed: { partner: "RECEIVER_UNREGISTERED" }, pending: [] });

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payouts()).toHaveLength(1);
  });

  it("R8: an item event for another batch id is audited and changes nothing", async () => {
    const t = await setup(7, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const before = await t.state();
    const e = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", "BATCH-SOMEONE-ELSE"));
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s = await t.state();
    expect(s.audits).toContain("paypal.unmatched_batch");
    expect(s.m.status).toBe("review");
    expect(s.ops).toEqual(before.ops);
    expect(s.ledger).toEqual([]);
    const [w] = (await db.$client.query(`select processed_at from webhook_events where event_id = $1`, [e])).rows as Array<{ processed_at: Date | null }>;
    expect(w!.processed_at).toBeInstanceOf(Date);
  });

  it("R9: UNCLAIMED is audit only; RETURNED before any success holds without a ledger reversal", async () => {
    const t = await setup(8, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const u = await webhook("PAYMENT.PAYOUTS-ITEM.UNCLAIMED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "UNCLAIMED" });
    await settle(job({ milestoneId: t.milestoneId, eventId: u }));
    const s1 = await t.state();
    expect(s1.audits).toContain("paypal.payout_unclaimed");
    expect(s1.m.status).toBe("review");
    expect(s1.ops[0]!.status).toBe("sent");

    const r = await webhook("PAYMENT.PAYOUTS-ITEM.RETURNED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "RETURNED" });
    await settle(job({ milestoneId: t.milestoneId, eventId: r }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("held");
    expect(s2.ops[0]!.status).toBe("failed");
    expect(s2.ledger).toEqual([]);
    expect(s2.audits).toContain("milestone.needs_operator");
    expect(s2.audits).not.toContain("milestone.reversed");
  });

  it("R9: REVERSED after the milestone was released books one reversal and moves released -> held", async () => {
    const t = await setup(9, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    calls.length = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const ok = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch));
    await settle(job({ milestoneId: t.milestoneId, eventId: ok }));
    expect((await t.state()).m.status).toBe("released");

    const r1 = await webhook("PAYMENT.PAYOUTS-ITEM.REVERSED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "REVERSED" });
    const r2 = await webhook("PAYMENT.PAYOUTS-ITEM.REFUNDED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "REFUNDED" });
    await settle(job({ milestoneId: t.milestoneId, eventId: r1 }));
    await settle(job({ milestoneId: t.milestoneId, eventId: r2 }));
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.audits).toContain("milestone.reversed");
    expect(s.audits.filter((a) => a === "milestone.needs_operator")).toHaveLength(1);
    expect(s.ops[0]!.status).toBe("failed");
    expect(s.ledger.filter((l) => l.ref.startsWith("reversal:"))).toEqual([
      { ref: `reversal:${t.milestoneId}:freelancer`, account: `freelancer:${freelancerId}`, amount: 10_000, direction: "debit" },
      { ref: `reversal:${t.milestoneId}:freelancer`, account: `held:${t.milestoneId}`, amount: 10_000, direction: "credit" },
    ]);
    expect(s.operator[0]).toMatchObject({ paid: { freelancer: 10_000 }, reversed: { freelancer: { eventType: "PAYMENT.PAYOUTS-ITEM.REVERSED" } } });

    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payouts()).toHaveLength(1);
    expect((await t.state()).audits).toContain("release.refused_needs_operator");
  });

  it("R10: a refund that is not ours is never booked; without an id yet only the exact claimed amount matches", async () => {
    const t = await setup(10, { status: "needs_client", decision: { action: "ask_client", amountMinor: 0, ruleIds: ["P4"], reason: "cap" }, clientResponse: "confirm_partial" });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const other = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: "REF-NOT-OURS", status: "COMPLETED", amount: { value: "100.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: other }));
    const s1 = await t.state();
    expect(s1.audits).toContain("paypal.refund_unmatched");
    expect(s1.ledger).toEqual([]);
    expect(s1.ops).toMatchObject([{ kind: "refund", status: "sent" }]);

    // Our op without a PayPal id (the refund answer was never recorded): only the claimed amount (100.00) matches.
    await db.$client.query(`update paypal_ops set paypal_id = null where kind = 'refund' and key = $1`, [t.milestoneId]);
    const wrongAmount = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: "REF-X", status: "COMPLETED", amount: { value: "40.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: wrongAmount }));
    expect((await t.state()).ledger).toEqual([]);
    const exact = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: "REF-X", status: "COMPLETED", amount: { value: "100.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: exact }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("partial_released");
    expect(s2.ops).toMatchObject([{ kind: "refund", status: "succeeded", paypal_id: "REF-X" }]);
    expect(s2.ledger.map((l) => [l.ref, l.amount, l.direction])).toEqual([[`refund:${t.milestoneId}`, 10_000, "credit"], [`refund:${t.milestoneId}`, 10_000, "debit"]]);
  });

  // ---------- R3: a payout or refund PayPal rejects outright reaches an operator ----------

  it("R3: a payout PayPal rejects with a 4xx is recorded failed, holds the milestone for an operator and is never retried", async () => {
    const t = await setup(11, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    calls.length = 0;
    reject.payout = 422;
    const j = job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId });
    await release(j); // final: not thrown, so pg-boss does not retry
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops).toMatchObject([{ kind: "payout", status: "failed", paypal_id: null }]);
    expect(s.audits).toContain("paypal.payout_error");
    expect(s.operator).toHaveLength(1);
    expect(s.operator[0]).toMatchObject({ status: "review", final: "rejected", httpStatus: 422, payoutOpStatus: "failed", pending: ["freelancer"] });

    await release(j);
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(payouts()).toHaveLength(1);
    expect((await t.state()).audits.filter((a) => a === "release.refused_needs_operator")).toHaveLength(2);
  });

  it("R3: 409 / 429 and network errors are retried; on the last retry the failure is final", async () => {
    const t = await setup(12, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    calls.length = 0;
    const id = randomUUID();
    reject.payout = 429;
    await expect(release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }, { id, retryCount: 0, retryLimit: 2 }))).rejects.toThrow("PayPal 429");
    reject.payout = 0;
    await expect(release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }, { id, retryCount: 1, retryLimit: 2 }))).rejects.toThrow("socket hang up");
    expect((await t.state()).ops).toMatchObject([{ status: "sent", paypal_id: null }]);
    reject.payout = 0;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }, { id, retryCount: 2, retryLimit: 2 }));
    const s = await t.state();
    expect(payouts()).toHaveLength(3);
    expect(new Set(payouts().map((c) => c.requestId)).size).toBe(1); // one PayPal-Request-Id throughout
    expect(s.m.status).toBe("held");
    expect(s.ops).toMatchObject([{ status: "failed" }]);
    expect(s.operator[0]).toMatchObject({ final: "last_attempt" });
  });

  it("R3/R5: a refund PayPal rejects after the payout went out holds the milestone; the paid item is booked but it never ends partial_released", async () => {
    const t = await setup(13, { status: "needs_client", decision: { action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "2 of 3" }, clientResponse: "confirm_partial" });
    calls.length = 0;
    reject.refund = 422;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const s1 = await t.state();
    expect(s1.m.status).toBe("held");
    const op = (s: { ops: Array<{ kind: string; status: string; paypal_id: string | null }> }, kind: string) => s.ops.find((o) => o.kind === kind)!;
    expect(op(s1, "payout")).toMatchObject({ status: "sent" });
    expect(op(s1, "refund")).toMatchObject({ status: "failed", paypal_id: null });
    expect(s1.operator).toHaveLength(1);
    expect(s1.operator[0]).toMatchObject({ final: "rejected", refunded: { opStatus: "failed" } });

    const batch = op(s1, "payout").paypal_id!;
    const e = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch, "60.00"));
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("held");
    expect(op(s2, "payout").status).toBe("succeeded");
    expect(s2.ledger.map((l) => [l.ref, l.amount, l.direction])).toEqual([[`release:${t.milestoneId}`, 6_000, "credit"], [`release:${t.milestoneId}`, 6_000, "debit"]]);
    expect(s2.audits).not.toContain("milestone.partial_released");
  });

  // ---------- R4: failure events PayPal can send ----------

  it("R4: an item DENIED holds for an operator; HELD is audit only", async () => {
    const t = await setup(14, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const h = await webhook("PAYMENT.PAYOUTS-ITEM.HELD", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "ONHOLD" });
    await settle(job({ milestoneId: t.milestoneId, eventId: h }));
    const s1 = await t.state();
    expect(s1.audits).toContain("paypal.payout_held");
    expect(s1.m.status).toBe("review");
    expect(s1.ops[0]!.status).toBe("sent");

    const d = await webhook("PAYMENT.PAYOUTS-ITEM.DENIED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "DENIED", errors: { name: "RISK_DENIED" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: d }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("held");
    expect(s2.ops).toMatchObject([{ status: "failed", response: { items: { freelancer: { status: "failed" } } } }]);
    expect(s2.ledger).toEqual([]);
    expect(s2.operator[0]).toMatchObject({ failed: { freelancer: "RISK_DENIED" } });
  });

  it("R4: an item CANCELED holds for an operator", async () => {
    const t = await setup(15, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const c = await webhook("PAYMENT.PAYOUTS-ITEM.CANCELED", { ...item(t.milestoneId, "freelancer", batch), transaction_status: "CANCELED" });
    await settle(job({ milestoneId: t.milestoneId, eventId: c }));
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops[0]!.status).toBe("failed");
    expect(s.audits).toContain("milestone.needs_operator");
  });

  it("R4: PAYMENT.PAYOUTSBATCH.DENIED marks the op failed and flags an operator, matched by sender_batch_id before the batch id is recorded", async () => {
    const t = await setup(16, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    const requestId = batch.replace(/^BATCH-/, "");
    // Someone else's denied batch: audited, nothing changes.
    const other = await webhook("PAYMENT.PAYOUTSBATCH.DENIED", { batch_header: { payout_batch_id: "BATCH-OTHER", batch_status: "DENIED", sender_batch_header: { sender_batch_id: "not-ours" } } });
    await settle(job({ milestoneId: t.milestoneId, eventId: other }));
    expect((await t.state()).ops[0]!.status).toBe("sent");

    // PayPal's batch id not recorded yet: our sender_batch_id still identifies the op, and the id is written (R8).
    await db.$client.query(`update paypal_ops set paypal_id = null where kind = 'payout' and key = $1`, [t.milestoneId]);
    const e = await webhook("PAYMENT.PAYOUTSBATCH.DENIED", { batch_header: { payout_batch_id: batch, batch_status: "DENIED", sender_batch_header: { sender_batch_id: requestId } } });
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops).toMatchObject([{ status: "failed", paypal_id: batch }]);
    expect(s.audits).toContain("paypal.payout_batch_denied");
    expect(s.operator).toHaveLength(1);
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect((await t.state()).audits).toContain("release.refused_needs_operator");
  });

  // ---------- R5: a partial is final only when both halves succeeded ----------

  it("R5: payout first, refund second -> partial_released only on the refund", async () => {
    const t = await setup(17, { status: "needs_client", decision: { action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "2 of 3" }, clientResponse: "confirm_partial" });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const s0 = await t.state();
    const batch = s0.ops.find((o) => o.kind === "payout")!.paypal_id!;
    const refundId = s0.ops.find((o) => o.kind === "refund")!.paypal_id!;
    const p = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch, "60.00"));
    await settle(job({ milestoneId: t.milestoneId, eventId: p }));
    const s1 = await t.state();
    expect(s1.m.status).toBe("needs_client");
    expect(s1.audits).toContain("settle.waiting");

    const r = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: refundId, status: "COMPLETED", amount: { value: "40.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: r }));
    const s2 = await t.state();
    expect(s2.m.status).toBe("partial_released");
    expect(s2.audits.filter((a) => a === "milestone.partial_released")).toHaveLength(1);
    expect(s2.ledger.map((l) => [l.ref, l.amount])).toEqual([
      [`refund:${t.milestoneId}`, 4_000], [`refund:${t.milestoneId}`, 4_000],
      [`release:${t.milestoneId}`, 6_000], [`release:${t.milestoneId}`, 6_000],
    ]);
  });

  it("R5: refund first, payout second -> partial_released only on the payout", async () => {
    const t = await setup(18, { status: "needs_client", decision: { action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "2 of 3" }, clientResponse: "confirm_partial" });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const s0 = await t.state();
    const r = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: s0.ops.find((o) => o.kind === "refund")!.paypal_id!, status: "COMPLETED", amount: { value: "40.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: r }));
    expect((await t.state()).m.status).toBe("needs_client");
    const p = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", s0.ops.find((o) => o.kind === "payout")!.paypal_id!, "60.00"));
    await settle(job({ milestoneId: t.milestoneId, eventId: p }));
    expect((await t.state()).m.status).toBe("partial_released");
  });

  it("R5: a refund that FAILS after the payout succeeded holds the milestone for an operator", async () => {
    const t = await setup(19, { status: "needs_client", decision: { action: "partial", amountMinor: 6_000, ruleIds: ["P5"], reason: "2 of 3" }, clientResponse: "confirm_partial" });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const s0 = await t.state();
    const p = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", s0.ops.find((o) => o.kind === "payout")!.paypal_id!, "60.00"));
    await settle(job({ milestoneId: t.milestoneId, eventId: p }));
    const r = await webhook("PAYMENT.CAPTURE.REFUNDED", { id: s0.ops.find((o) => o.kind === "refund")!.paypal_id!, status: "FAILED", amount: { value: "40.00", currency_code: "USD" } });
    await settle(job({ milestoneId: t.milestoneId, eventId: r }));
    const s = await t.state();
    expect(s.m.status).toBe("held");
    expect(s.ops.find((o) => o.kind === "refund")!.status).toBe("failed");
    expect(s.ledger.filter((l) => l.ref.startsWith("refund:"))).toEqual([]);
    expect(s.audits).toContain("paypal.refund_failed");
    expect(s.audits).not.toContain("milestone.partial_released");
    expect(s.operator).toHaveLength(1);
  });

  // ---------- R6: a flagged milestone never reaches a final state ----------

  it("R6: settle does not finalise a milestone flagged for an operator", async () => {
    const { audit } = await import("@milestone/core");
    const t = await setup(20, { status: "review", decision: { action: "release", amountMinor: 10_000, ruleIds: ["P6"], reason: "ok" } });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const batch = (await t.state()).ops[0]!.paypal_id!;
    await audit(db, { actor: "operator", event: "milestone.needs_operator", milestoneId: t.milestoneId, contractId, detail: { reason: "e2e" } });
    const e = await webhook("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", item(t.milestoneId, "freelancer", batch));
    await settle(job({ milestoneId: t.milestoneId, eventId: e }));
    const s = await t.state();
    expect(s.m.status).toBe("review");
    expect(s.audits).toContain("milestone.settle_conflict");
    expect(s.audits).not.toContain("milestone.released");
  });

  // ---------- R7: only the claiming job resumes ----------

  it("R7: another job skips an in-flight claim until the lease expires, then takes it over with the same PayPal-Request-Id", async () => {
    const t = await setup(21, { status: "needs_client", decision: { action: "ask_client", amountMinor: 0, ruleIds: ["P4"], reason: "cap" }, clientResponse: "confirm_partial" });
    calls.length = 0;
    const a = job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId });
    failNextRefund = true;
    await expect(release(a, at(0))).rejects.toThrow("refund refused");
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }), at(119_999));
    expect(calls).toHaveLength(1);
    expect((await t.state()).audits.filter((x) => x === "release.skipped_in_flight")).toHaveLength(1);

    const b = job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId });
    await release(b, at(120_000));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.requestId).toBe(calls[0]!.requestId);
    const s = await t.state();
    expect(s.audits).toContain("release.lease_taken_over");
    expect(s.ops).toMatchObject([{ kind: "refund", status: "sent", paypal_id: `REF-${calls[0]!.requestId}` }]);
    const [row] = (await db.$client.query(`select request from paypal_ops where kind = 'refund' and key = $1`, [t.milestoneId])).rows as Array<{ request: { claim: { jobId: string; claimedAt: string } } }>;
    expect(row!.request.claim).toMatchObject({ jobId: b.id, claimedAt: new Date(T0.getTime() + 120_000).toISOString() });

    // The original job's retry finds the op answered and stops.
    await release(a, at(130_000));
    expect(calls).toHaveLength(2);
  });
});

describe.skipIf(!run)("advance repayment: shortfall and carry-over end to end", async () => {
  const { advances, contracts, milestones, users, criteria, deliveries, webhookEvents, postTransaction } = await import("@milestone/core");
  const { loadAdvanceBalances, loadRecords } = await import("@milestone/money");
  const { getDb } = await import("../src/lib/db.ts");
  const { release } = await import("../src/jobs/release.ts");
  const { settle } = await import("../src/jobs/settle.ts");
  const db = getDb();
  const tag = randomUUID().slice(0, 8);
  const contractId = `ctr_e2e_co_${tag}`;
  const clientId = `usr_e2e_co_c_${tag}`;
  const freelancerId = `usr_e2e_co_f_${tag}`;
  const partnerId = `usr_e2e_co_p_${tag}`;
  const otherPartnerId = `usr_e2e_co_q_${tag}`;
  const eventIds: string[] = [];
  const past = () => new Date(Date.now() - 60_000);
  let fundedAt = Date.now() - 86_400_000;

  beforeAll(async () => {
    delete process.env.PAYPAL_CLIENT_ID;
    await db.insert(users).values([
      { id: clientId, role: "client", name: "c", email: `coc-${tag}@e2e.test` },
      { id: freelancerId, role: "freelancer", name: "f", email: `cof-${tag}@e2e.test`, paypalEmail: `cof-${tag}@e2e.test` },
      { id: partnerId, role: "partner", name: "p", email: `cop-${tag}@e2e.test`, paypalEmail: `cop-${tag}@e2e.test` },
      { id: otherPartnerId, role: "partner", name: "q", email: `coq-${tag}@e2e.test`, paypalEmail: `coq-${tag}@e2e.test` },
    ]);
    await db.insert(contracts).values({ id: contractId, clientId, freelancerId, title: "e2e carry", scopeText: "e2e", currency: "USD", totalMinor: 80_000, status: "active" });
  });

  afterAll(async () => {
    const q = (s: string, p: unknown[]) => db.$client.query(s, p);
    const ms = `(select id from milestones where contract_id = $1)`;
    await q(`delete from audit_log where contract_id = $1 or milestone_id in ${ms}`, [contractId]);
    await q(`delete from ledger_entries where txn_id in (select txn_id from ledger_entries where account in (select 'held:' || id from milestones where contract_id = $1))`, [contractId]);
    await q(`delete from ledger_entries where ref in (select 'advance:' || id from advances where milestone_id in ${ms})`, [contractId]);
    await q(`delete from advances where milestone_id in ${ms}`, [contractId]);
    await q(`delete from paypal_ops where key in ${ms}`, [contractId]);
    await q(`delete from webhook_events where event_id = any($1)`, [eventIds]);
    await q(`delete from deliveries where milestone_id in ${ms}`, [contractId]);
    await q(`delete from criteria where milestone_id in ${ms}`, [contractId]);
    await q(`delete from milestones where contract_id = $1`, [contractId]);
    await q(`delete from contracts where id = $1`, [contractId]);
    await q(`delete from users where id = any($1)`, [[clientId, freelancerId, partnerId, otherPartnerId]]);
  });

  /** A milestone of 100.00 ready to release (needs_client + confirm_partial for a partial), optionally with a funded advance. */
  async function setup(seq: number, decision: { action: "release" | "partial"; amountMinor: number }, adv?: { principalMinor: number; feeMinor: number; partner?: string }) {
    const milestoneId = `mst_e2e_co_${tag}_${seq}`;
    const deliveryId = `dlv_e2e_co_${tag}_${seq}`;
    const partial = decision.action === "partial";
    await db.insert(milestones).values({
      id: milestoneId, contractId, seq, title: `m${seq}`, amountMinor: 10_000, status: partial ? "needs_client" : "review", paypalCaptureId: `CAP-co-${tag}-${seq}`,
      decision: { ...decision, ruleIds: ["P"], reason: "e2e", deliveryId } as never, decidedAt: new Date(), reviewEndsAt: partial ? null : past(), clientResponse: partial ? "confirm_partial" : null,
    });
    const critId = `crt_e2e_co_${tag}_${seq}`;
    await db.insert(criteria).values({ id: critId, milestoneId, kind: "test", description: "tests", spec: {}, required: true });
    await db.insert(deliveries).values({ id: deliveryId, milestoneId, source: "manual", ref: `co-${seq}`, verdict: { delivery_id: deliveryId, suspected_injection: false, criteria: [{ criterion_id: critId, status: "pass", confidence: 0.9, evidence_ids: ["e"], rationale: "" }] }, result: "pass", verifiedAt: new Date() });
    const advanceId = `adv_e2e_co_${tag}_${seq}`;
    if (adv) {
      const p = adv.partner ?? partnerId;
      fundedAt += 1_000;
      await db.insert(advances).values({ id: advanceId, milestoneId, partnerId: p, principalMinor: adv.principalMinor, feeBpsPerDay: 10, status: "funded", offer: { expectedFeeMinor: adv.feeMinor }, fundedAt: new Date(fundedAt) });
      await postTransaction(db, { ref: `advance:${advanceId}`, currency: "USD", entries: [{ account: `partner:${p}:receivable`, amountMinor: adv.principalMinor, direction: "debit" }, { account: `partner:${p}:cash`, amountMinor: adv.principalMinor, direction: "credit" }] });
    }
    return { milestoneId, deliveryId, advanceId };
  }
  const claimOf = async (milestoneId: string) =>
    ((await db.$client.query(`select request->'claim' as claim, paypal_id from paypal_ops where kind = 'payout' and key = $1`, [milestoneId])).rows[0] ?? null) as { claim: { shares: { partnerShareMinor: number; freelancerShareMinor: number }; advances: Array<{ advanceId: string; principalMinor: number; feeMinor: number }> }; paypal_id: string } | null;
  const advanceRow = (id: string) => db.query.advances.findFirst({ where: (t, { eq }) => eq(t.id, id) });
  const balance = async (id: string, milestoneId: string, p = partnerId) => (await loadAdvanceBalances(db, [{ id, milestoneId, partnerId: p }])).get(id)!;
  async function payPartner(milestoneId: string, batch: string, value: string) {
    const eventId = `WH-co-${tag}-${randomUUID().slice(0, 8)}`;
    eventIds.push(eventId);
    await db.insert(webhookEvents).values({ id: randomUUID(), source: "paypal", eventId, type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payload: { id: eventId, resource: { payout_batch_id: batch, payout_item_id: `I-${randomUUID().slice(0, 6)}`, transaction_status: "SUCCESS", payout_item: { sender_item_id: `${milestoneId}:partner`, amount: { value, currency: "USD" } } } } });
    await settle(job({ milestoneId, eventId }));
  }
  const partnerItems = (milestoneId: string) =>
    calls.filter((c) => c.path === "/v1/payments/payouts").flatMap((c) => (c.body as { items: Array<{ receiver: string; amount: { value: string }; sender_item_id: string }> }).items).filter((i) => i.sender_item_id.startsWith(milestoneId));

  let shortAdvance = "";
  let shortMilestone = "";

  it("a short repayment leaves the advance in shortfall with the remaining balance, still counted as outstanding", async () => {
    const t = await setup(1, { action: "partial", amountMinor: 3_000 }, { principalMinor: 5_000, feeMinor: 100 });
    shortAdvance = t.advanceId;
    shortMilestone = t.milestoneId;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const c = (await claimOf(t.milestoneId))!;
    expect(c.claim.shares).toEqual({ partnerShareMinor: 3_000, freelancerShareMinor: 0 });
    expect(c.claim.advances).toEqual([{ advanceId: t.advanceId, milestoneId: t.milestoneId, principalMinor: 5_000, feeMinor: 100 }]);
    expect(partnerItems(t.milestoneId).map((i) => i.sender_item_id)).toEqual([`${t.milestoneId}:partner`]);

    await payPartner(t.milestoneId, c.paypal_id, "30.00");
    expect((await advanceRow(t.advanceId))?.status).toBe("shortfall");
    const audit = (await db.$client.query(`select detail from audit_log where milestone_id = $1 and event = 'advance.shortfall'`, [t.milestoneId])).rows[0]?.detail;
    expect(audit).toMatchObject({ advanceId: t.advanceId, owedMinor: 5_100, paidMinor: 3_000, remainingMinor: 2_100 });
    expect(await balance(t.advanceId, t.milestoneId)).toMatchObject({ fundedMinor: 5_000, principalRepaidMinor: 3_000, outstandingMinor: 2_000, feeRepaidMinor: 0 });
    const rec = await loadRecords(db, freelancerId, clientId);
    expect(rec.freelancer.outstandingMinor).toBe(5_000);
  });

  it("the next release repays the carried balance before the freelancer; a concurrent claim does not collect it twice", async () => {
    const t = await setup(2, { action: "release", amountMinor: 10_000 });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const c = (await claimOf(t.milestoneId))!;
    expect(c.claim.shares).toEqual({ partnerShareMinor: 2_100, freelancerShareMinor: 7_900 });
    expect(c.claim.advances).toEqual([{ advanceId: shortAdvance, milestoneId: shortMilestone, principalMinor: 2_000, feeMinor: 100 }]);
    expect(partnerItems(t.milestoneId)).toEqual(expect.arrayContaining([expect.objectContaining({ receiver: `cop-${tag}@e2e.test`, amount: expect.objectContaining({ value: "21.00" }) })]));

    // Another release while that repayment is still in flight: the balance is already claimed, nothing is double-collected.
    const u = await setup(3, { action: "release", amountMinor: 10_000 });
    await release(job({ milestoneId: u.milestoneId, deliveryId: u.deliveryId }));
    expect((await claimOf(u.milestoneId))!.claim).toMatchObject({ shares: { partnerShareMinor: 0, freelancerShareMinor: 10_000 }, advances: [] });

    await payPartner(t.milestoneId, c.paypal_id, "21.00");
    expect((await advanceRow(shortAdvance))?.status).toBe("repaid");
    expect(await balance(shortAdvance, shortMilestone)).toMatchObject({ outstandingMinor: 0, principalRepaidMinor: 5_000, feeRepaidMinor: 100 });
    const ledger = (await db.$client.query(`select account, amount_minor::int as amount, direction from ledger_entries where ref = $1 order by account`, [`release:${t.milestoneId}:partner:${shortAdvance}`])).rows;
    expect(ledger).toEqual([
      { account: `held:${t.milestoneId}`, amount: 2_100, direction: "debit" },
      { account: `partner:${partnerId}:fees`, amount: 100, direction: "credit" },
      { account: `partner:${partnerId}:receivable`, amount: 2_000, direction: "credit" },
    ]);
  });

  it("a funded advance on a fully refunded milestone is collected from the next release; the freelancer gets nothing while it is owed", async () => {
    const r = await setup(4, { action: "partial", amountMinor: 0 }, { principalMinor: 4_000, feeMinor: 0 });
    // End state of a full refund that was then held: refund:<m> booked in full, the advance never repaid.
    await db.$client.query(`update milestones set status = 'held' where id = $1`, [r.milestoneId]);
    await postTransaction(db, { ref: `refund:${r.milestoneId}`, currency: "USD", entries: [{ account: `held:${r.milestoneId}`, amountMinor: 10_000, direction: "debit" }, { account: `client:${clientId}`, amountMinor: 10_000, direction: "credit" }] });

    const t = await setup(5, { action: "partial", amountMinor: 3_000 });
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    const c = (await claimOf(t.milestoneId))!;
    expect(c.claim.shares).toEqual({ partnerShareMinor: 3_000, freelancerShareMinor: 0 });
    expect(partnerItems(t.milestoneId).map((i) => i.sender_item_id)).toEqual([`${t.milestoneId}:partner`]);
    await payPartner(t.milestoneId, c.paypal_id, "30.00");
    expect((await advanceRow(r.advanceId))?.status).toBe("shortfall");
    expect(await balance(r.advanceId, r.milestoneId)).toMatchObject({ outstandingMinor: 1_000 });
  });

  it("a balance owed to another partner stops a release that would pay the freelancer and flags an operator", async () => {
    const o = await setup(6, { action: "partial", amountMinor: 0 }, { principalMinor: 2_000, feeMinor: 0, partner: otherPartnerId });
    await db.$client.query(`update milestones set status = 'partial_released' where id = $1`, [o.milestoneId]);
    const t = await setup(7, { action: "release", amountMinor: 10_000 });
    const before = calls.length;
    await release(job({ milestoneId: t.milestoneId, deliveryId: t.deliveryId }));
    expect(calls.length).toBe(before);
    expect(await claimOf(t.milestoneId)).toBeNull();
    const m = await db.query.milestones.findFirst({ where: (x, { eq }) => eq(x.id, t.milestoneId) });
    expect(m?.status).toBe("held");
    const flagged = (await db.$client.query(`select detail from audit_log where milestone_id = $1 and event = 'milestone.needs_operator'`, [t.milestoneId])).rows[0]?.detail;
    expect(flagged?.blocked).toEqual([expect.objectContaining({ advanceId: o.advanceId, partnerId: otherPartnerId, remainingMinor: 2_000 })]);
  });
});
