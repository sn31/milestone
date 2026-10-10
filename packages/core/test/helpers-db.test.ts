/** The DB-backed core helpers against the local Postgres. Opt in: MILESTONE_E2E=1. Every row it writes is removed. */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { createDb } from "../src/db.ts";
import { AUDIT_EVENTS, audit, hasAudit, loadDeliveryContext, loadMilestone, openOperatorFlags, transition } from "../src/milestones.ts";
import { claimOp, markWebhookProcessed, requestIdFor, storeWebhookOnce } from "../src/ops.ts";
import { auditLog, contracts, criteria, deliveries, milestones, paypalOps, users, webhookEvents } from "../src/schema.ts";

if (!process.env.DATABASE_URL) {
  try { process.loadEnvFile(resolve(__dirname, "../../../.env")); } catch { /* opt-in test */ }
}

describe.skipIf(process.env.MILESTONE_E2E !== "1")("core DB helpers", () => {
  const db = process.env.MILESTONE_E2E === "1" ? createDb() : (undefined as unknown as ReturnType<typeof createDb>); // the suite body is collected even when skipped
  const tag = randomUUID().slice(0, 8);
  const userId = `usr_t_${tag}`;
  const contractId = `ctr_t_${tag}`;
  const m1 = `mst_t_${tag}_1`;
  const m2 = `mst_t_${tag}_2`;
  const deliveryId = `dlv_t_${tag}`;
  const opKey = `key_t_${tag}`;
  const eventId = `evt_t_${tag}`;

  beforeAll(async () => {
    await db.insert(users).values({ id: userId, role: "client", name: "t", email: `${tag}@t.test` });
    await db.insert(contracts).values({ id: contractId, clientId: userId, freelancerId: userId, title: "t", scopeText: "t", currency: "USD", totalMinor: 200 });
    await db.insert(milestones).values([
      { id: m1, contractId, seq: 1, title: "one", amountMinor: 100, status: "released" },
      { id: m2, contractId, seq: 2, title: "two", amountMinor: 100, status: "funded" },
    ]);
    await db.insert(criteria).values([
      { id: `crt_t_${tag}_b`, milestoneId: m2, kind: "file", description: "b", spec: { path: "b" }, required: false },
      { id: `crt_t_${tag}_a`, milestoneId: m2, kind: "test", description: "a", spec: { command: "x" } },
    ]);
    await db.insert(deliveries).values({ id: deliveryId, milestoneId: m2, source: "manual", ref: "r", payload: { sha: "s", clone_url: "u" } });
  });

  afterAll(async () => {
    await db.delete(auditLog).where(inArray(auditLog.milestoneId, [m1, m2]));
    await db.delete(paypalOps).where(eq(paypalOps.key, opKey));
    await db.delete(webhookEvents).where(eq(webhookEvents.eventId, eventId));
    await db.delete(deliveries).where(eq(deliveries.milestoneId, m2));
    await db.delete(criteria).where(eq(criteria.milestoneId, m2));
    await db.delete(milestones).where(eq(milestones.contractId, contractId));
    await db.delete(contracts).where(eq(contracts.id, contractId));
    await db.delete(users).where(eq(users.id, userId));
    await db.$client.end();
  });

  it("transition refuses released -> held without the reversal cause and takes it with one, inside a transaction", async () => {
    await expect(transition(db, m1, "held", { actor: "paypal", event: AUDIT_EVENTS.milestoneReversed })).rejects.toThrow(/illegal transition released -> held/);
    const moved = await db.transaction((tx) => transition(tx, m1, "held", { actor: "paypal", event: AUDIT_EVENTS.milestoneReversed, detail: { reversedMinor: 100 } }, { cause: "reversal" }));
    expect(moved).toBe(true);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.milestoneId, m1));
    expect(row).toMatchObject({ event: "milestone.reversed", contractId, detail: { from: "released", to: "held", reversedMinor: 100 } });
  });

  it("hasAudit and openOperatorFlags", async () => {
    expect(await hasAudit(db, { event: AUDIT_EVENTS.needsOperator, milestoneId: m2 })).toBe(false);
    await audit(db, { actor: "paypal", event: AUDIT_EVENTS.needsOperator, milestoneId: m2, contractId, detail: { reason: "first", advanceId: "adv_x" } });
    expect(await hasAudit(db, { event: AUDIT_EVENTS.needsOperator, milestoneId: m2 })).toBe(true);
    expect(await hasAudit(db, { event: AUDIT_EVENTS.needsOperator, detail: ["advanceId", "adv_x"] })).toBe(true);
    expect(await hasAudit(db, { event: AUDIT_EVENTS.needsOperator, milestoneId: m2, detail: ["advanceId", "adv_y"] })).toBe(false);

    let open = await openOperatorFlags(db, [m1, m2]);
    expect([...open.keys()]).toEqual([m2]);
    expect(open.get(m2)?.detail).toMatchObject({ reason: "first" });
    expect((await openOperatorFlags(db)).has(m2)).toBe(true);
    expect((await openOperatorFlags(db, [])).size).toBe(0);

    await new Promise((r) => setTimeout(r, 5));
    await audit(db, { actor: "usr", event: AUDIT_EVENTS.opsResolved, milestoneId: m2, contractId, detail: { note: "ok" } });
    expect((await openOperatorFlags(db, [m2])).size).toBe(0);
    // Resolved for the queue, but "ever flagged" stays true for the jobs.
    expect(await hasAudit(db, { event: AUDIT_EVENTS.needsOperator, milestoneId: m2 })).toBe(true);

    await new Promise((r) => setTimeout(r, 5));
    await audit(db, { actor: "paypal", event: AUDIT_EVENTS.needsOperator, milestoneId: m2, contractId, detail: { reason: "second" } });
    open = await openOperatorFlags(db, [m2]);
    expect(open.get(m2)?.detail).toMatchObject({ reason: "second" });
  });

  it("loadMilestone and loadDeliveryContext", async () => {
    const found = await loadMilestone(db, m2);
    expect(found?.milestone.id).toBe(m2);
    expect(found?.contract.id).toBe(contractId);
    expect(found?.milestone).not.toHaveProperty("contract");
    expect(await loadMilestone(db, "mst_missing")).toBeNull();

    const ctx = await db.transaction((tx) => loadDeliveryContext(tx, deliveryId));
    expect(ctx?.delivery.id).toBe(deliveryId);
    expect(ctx?.milestone.id).toBe(m2);
    expect(ctx?.contract.id).toBe(contractId);
    expect(ctx?.criteria.map((c) => c.description)).toEqual(["a", "b"]);
    expect(ctx?.criteria[0]).toEqual({ id: `crt_t_${tag}_a`, kind: "test", description: "a", spec: { command: "x" }, required: true });
    expect(await loadDeliveryContext(db, "dlv_missing")).toBeNull();
  });

  it("claimOp upgrades a pending op to sent, keeps its request id, and leaves a sent op alone", async () => {
    const rid = await requestIdFor(db, "payout", opKey);
    const row = await claimOp(db, "payout", opKey, { claim: { n: 1 } });
    expect(row).toMatchObject({ status: "sent", requestId: rid, request: { claim: { n: 1 } } });
    const again = await claimOp(db, "payout", opKey, { claim: { n: 2 } });
    expect(again).toMatchObject({ status: "sent", requestId: rid, request: { claim: { n: 1 } } });
    const fresh = await claimOp(db, "refund", opKey, { claim: { n: 3 } });
    expect(fresh.status).toBe("sent");
  });

  it("markWebhookProcessed stamps once, by id or by (source, event id)", async () => {
    expect(await storeWebhookOnce(db, { source: "paypal", eventId, type: "T", payload: {} })).toBe(true);
    const first = new Date("2026-01-01T00:00:00Z");
    await markWebhookProcessed(db, { source: "paypal", eventId }, first);
    const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, eventId));
    expect(row?.processedAt?.toISOString()).toBe(first.toISOString());
    await markWebhookProcessed(db, { id: row!.id });
    const [after] = await db.select().from(webhookEvents).where(eq(webhookEvents.eventId, eventId));
    expect(after?.processedAt?.toISOString()).toBe(first.toISOString());
  });
});
