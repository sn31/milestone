/**
 * Reconciliation end to end against Postgres, with PayPal's MCP server replaced by a fake on an in-memory MCP
 * transport. Opt in: MILESTONE_E2E=1. Ops, ledger lines and a payout item webhook are written in a window of their own
 * (January 2026, where nothing else lives), the job reads list_transactions through the allowlisted client, and the
 * ops.reconciled row carries the deterministic counts and lists. A failing call is recorded as ops.reconcile_failed with
 * PayPal's error body. Every row is tagged and removed in afterAll.
 */
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const run = process.env.MILESTONE_E2E === "1";
try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

async function fakeSession(answer: (args: Record<string, unknown>) => unknown) {
  const { openPayPalMcp } = await import("@milestone/money");
  const server = new Server({ name: "fake-paypal", version: "0.0.0" }, { capabilities: { tools: {} } });
  const calls: Array<Record<string, unknown>> = [];
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ["list_transactions", "list_disputes", "get_dispute"].map((name) => ({ name, inputSchema: { type: "object" as const } })) }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    calls.push((req.params.arguments ?? {}) as Record<string, unknown>);
    return { content: [{ type: "text" as const, text: JSON.stringify(answer((req.params.arguments ?? {}) as Record<string, unknown>)) }] };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  return { session: await openPayPalMcp({ transport: a, Client: Client as never, timeoutMs: 5_000 }), calls };
}

describe.skipIf(!run)("reconciliation end to end", async () => {
  const { auditLog, ledgerEntries, paypalOps, webhookEvents } = await import("@milestone/core");
  const { getDb } = await import("../src/lib/db.ts");
  const { runReconcile, RECONCILE_EVENTS } = await import("../src/jobs/reconcile.ts");
  const { inArray, sql } = await import("drizzle-orm");
  const db = run ? getDb() : (undefined as unknown as ReturnType<typeof getDb>); // the suite body is collected even when skipped
  const tag = randomUUID().slice(0, 8).toUpperCase();
  const m = `mst_e2e_rc_${tag}`;
  const capId = `CAPRC${tag}0001`;
  const refId = `REFRC${tag}0001`;
  const itemId = `ITEMRC${tag}`;
  const txnId = `TXNRC${tag}0001`;
  const lostCap = `CAPRC${tag}LOST`;
  const t0 = new Date("2026-01-10T12:00:00Z");
  const window = { start: "2026-01-10T00:00:00Z", end: "2026-01-10T23:59:59Z" };
  const trigger = `e2e-${tag}`;
  const opIds: string[] = [];
  const op = (kind: string, key: string, paypalId: string | null, response: unknown = null) => {
    const id = randomUUID();
    opIds.push(id);
    return { id, kind, key, requestId: randomUUID(), paypalId, status: "succeeded" as const, response, createdAt: t0, updatedAt: t0 };
  };
  const line = (ref: string, account: string, direction: "debit" | "credit", amountMinor: number) => ({ id: randomUUID(), txnId: `txn_${ref}`, ref, account, direction, amountMinor, currency: "USD", createdAt: t0 });
  const row = (id: string, code: string, value: string, ref: string | null, at: string) => ({ transaction_info: { transaction_id: id, ...(ref ? { paypal_reference_id: ref } : {}), transaction_event_code: code, transaction_initiation_date: at, transaction_amount: { currency_code: "USD", value }, transaction_status: "S" } });

  afterAll(async () => {
    await db.delete(paypalOps).where(inArray(paypalOps.id, opIds));
    await db.delete(ledgerEntries).where(sql`${ledgerEntries.ref} like ${`%${tag}%`}`);
    await db.delete(webhookEvents).where(sql`${webhookEvents.eventId} like ${`%${tag}%`}`);
    await db.delete(auditLog).where(sql`${auditLog.detail}->>'trigger' = ${trigger}`);
  });

  it("records ops.reconciled with deterministic counts", async () => {
    await db.insert(paypalOps).values([
      op("capture", `${m}`, capId),
      op("refund", `${m}`, refId),
      op("payout", `${m}`, `BATCHRC${tag}`, { items: { freelancer: { status: "succeeded", amountMinor: 3000, eventId: `WH-${tag}`, payoutItemId: itemId } } }),
      op("capture", `${m}_lost`, lostCap),
    ]);
    await db.insert(ledgerEntries).values([
      line(capId, `client:u_${tag}`, "debit", 4000),
      line(capId, `held:${m}`, "credit", 4000),
      line(`refund:${m}`, `held:${m}`, "debit", 1000),
      line(`refund:${m}`, `client:u_${tag}`, "credit", 1000),
      line(`release:${m}`, `held:${m}`, "debit", 3000),
      line(`release:${m}`, `freelancer:f_${tag}`, "credit", 3000),
      line(lostCap, `client:u_${tag}`, "debit", 500),
      line(lostCap, `held:${m}_lost`, "credit", 500),
    ]);
    await db.insert(webhookEvents).values({ id: randomUUID(), source: "paypal", eventId: `WH-${tag}`, type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED", payload: { resource: { payout_item_id: itemId, transaction_id: txnId } }, receivedAt: t0 });

    const { session, calls } = await fakeSession(() => ({
      transaction_details: [
        row(capId, "T0006", "40.00", null, "2026-01-10T12:00:01Z"),
        row(refId, "T1107", "-10.00", capId, "2026-01-10T12:00:02Z"),
        row(`HOLDRC${tag}`, "T1503", "-30.25", null, "2026-01-10T12:00:03Z"),
        row(txnId, "T0001", "-30.00", `HOLDRC${tag}`, "2026-01-10T12:00:04Z"),
        row(`STRANGER${tag}`, "T0006", "7.00", null, "2026-01-10T12:00:05Z"),
      ],
      total_pages: 1,
    }));
    const out = await runReconcile(db, { session, window, trigger });
    await session.close();
    expect(calls).toEqual([{ start_date: window.start, end_date: window.end, page_size: 500, page: 1 }]);
    expect(out.kind).toBe("reconciled");

    const rows = await db.select().from(auditLog).where(sql`${auditLog.event} = ${RECONCILE_EVENTS.reconciled} and ${auditLog.detail}->>'trigger' = ${trigger}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.milestoneId).toBeNull();
    expect(rows[0]!.detail).toMatchObject({
      via: "paypal_mcp",
      tool: "list_transactions",
      simulated: false,
      window: { start: window.start, end: window.end },
      paypalCount: 5,
      matched: 3,
      ignored: 1,
      counts: { missingInLedger: 1, missingInPayPal: 1, amountMismatches: 0 },
      missingInLedger: [expect.objectContaining({ id: `STRANGER${tag}`, amountMinor: 700 })],
      missingInPayPal: [expect.objectContaining({ kind: "capture", ids: [lostCap], amountMinor: 500 })],
      amountMismatches: [],
      mismatches: 2,
    });
  });

  it("records a failed call as ops.reconcile_failed with PayPal's body", async () => {
    const body = { ok: false, status: 403, code: "PAYPAL_API_HTTP_ERROR", message: "NOT_AUTHORIZED: Authorization failed due to insufficient permissions." };
    const { session } = await fakeSession(() => body);
    const out = await runReconcile(db, { session, window, trigger });
    await session.close();
    expect(out).toMatchObject({ kind: "failed", status: 403, body });
    const rows = await db.select().from(auditLog).where(sql`${auditLog.event} = ${RECONCILE_EVENTS.failed} and ${auditLog.detail}->>'trigger' = ${trigger}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail).toMatchObject({ body, status: 403, code: "PAYPAL_API_HTTP_ERROR" });
  });
});
