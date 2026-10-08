/**
 * POST /api/webhooks/paypal in simulated mode (X-Milestone-Simulated carries the shared secret). The fixture-shape and
 * header tests always run; routing needs the local Postgres (MILESTONE_E2E=1). enqueue is mocked, so a payout item
 * event stays unprocessed (the settle job would mark it); stored rows are removed afterwards.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { e2e, fixture, loadRootEnv } from "./helpers";

loadRootEnv();
const state = vi.hoisted(() => ({ enqueued: [] as unknown[][], db: null as unknown }));
vi.mock("@/lib/db", () => ({ getDb: () => state.db }));
vi.mock("@/lib/paypal", () => ({ paypal: () => { throw new Error("no PayPal client in this test"); } }));
vi.mock("@milestone/core", async (orig) => ({
  ...(await orig<typeof import("@milestone/core")>()),
  enqueue: async (...args: unknown[]) => { state.enqueued.push(args); return "job"; },
}));

import * as core from "@milestone/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import { POST } from "../src/app/api/webhooks/paypal/route";

const SECRET = "test-simulated-secret";
const saved = { mode: process.env.PAYPAL_MODE, secret: process.env.SIMULATED_WEBHOOK_SECRET };
beforeAll(() => { process.env.PAYPAL_MODE = "simulated"; process.env.SIMULATED_WEBHOOK_SECRET = SECRET; });
afterAll(() => {
  if (saved.mode === undefined) delete process.env.PAYPAL_MODE; else process.env.PAYPAL_MODE = saved.mode;
  if (saved.secret === undefined) delete process.env.SIMULATED_WEBHOOK_SECRET; else process.env.SIMULATED_WEBHOOK_SECRET = saved.secret;
});

const post = (body: unknown, header: string | null = SECRET) =>
  POST(new Request("http://localhost/api/webhooks/paypal", { method: "POST", headers: { "content-type": "application/json", ...(header === null ? {} : { "x-milestone-simulated": header }) }, body: JSON.stringify(body) }));

const FIXTURES = {
  "paypal-checkout-order-approved.json": "CHECKOUT.ORDER.APPROVED",
  "paypal-payment-capture-completed.json": "PAYMENT.CAPTURE.COMPLETED",
  "paypal-payout-item-succeeded.json": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
  "paypal-payout-item-failed.json": "PAYMENT.PAYOUTS-ITEM.FAILED",
  "paypal-dispute-created.json": "CUSTOMER.DISPUTE.CREATED",
} as const;

describe("paypal webhook fixtures and simulated signature", () => {
  it.each(Object.entries(FIXTURES))("%s has the envelope PayPal sends", (file, type) => {
    const ev = fixture(file);
    expect(ev).toMatchObject({ event_type: type, event_version: "1.0" });
    expect(ev.id).toMatch(/^WH-/);
    expect(typeof ev.summary).toBe("string");
    expect(ev.resource).toBeTypeOf("object");
    expect(Number.isNaN(Date.parse(ev.create_time))).toBe(false);
    expect(Object.values(core.PAYPAL_EVENTS)).toContain(type);
  });
  it("payout item events carry sender_item_id as <milestoneId>:<party>", () => {
    for (const f of ["paypal-payout-item-succeeded.json", "paypal-payout-item-failed.json"]) {
      expect(fixture(f).resource.payout_item.sender_item_id).toMatch(/^[^:]+:(freelancer|partner)$/);
    }
  });
  it("a missing or wrong X-Milestone-Simulated header is 400 (no DB touched)", async () => {
    const ev = fixture("paypal-dispute-created.json");
    expect((await post(ev, null)).status).toBe(400);
    expect((await post(ev, "wrong")).status).toBe(400);
    expect(state.enqueued).toHaveLength(0);
  });
});

describe.skipIf(!e2e)("paypal webhook against Postgres", () => {
  const db = e2e ? core.createDb() : (null as never);
  const tag = randomUUID().slice(0, 8);
  const ids: string[] = [];
  /** A fixture with a fresh event id, so reruns never collide with stored events. */
  const fresh = (file: string, eventType?: string) => {
    const ev = fixture(file);
    ev.id = `WH-T-${tag}-${ids.length}`;
    if (eventType) ev.event_type = eventType;
    ids.push(ev.id);
    return ev;
  };
  const stored = async (id: string) => (await db.select().from(core.webhookEvents).where(and(eq(core.webhookEvents.source, "paypal"), eq(core.webhookEvents.eventId, id))))[0];

  beforeAll(() => { state.db = db; });
  beforeEach(() => { state.enqueued.length = 0; });
  afterAll(async () => {
    if (!e2e) return;
    await db.delete(core.webhookEvents).where(inArray(core.webhookEvents.eventId, ids));
    await db.execute(sql`delete from audit_log where event = 'paypal.capture_unmatched' and detail->>'eventId' like ${`WH-T-${tag}-%`}`);
  });

  it("duplicate of a processed event -> { duplicate: true }", async () => {
    const ev = fresh("paypal-dispute-created.json");
    const first = await post(ev);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, duplicate: false, outcome: "stored" });
    expect((await stored(ev.id))?.processedAt).not.toBeNull();
    const again = await post(ev);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ duplicate: true });
  });

  it("duplicate with processed_at null -> routed again", async () => {
    const ev = fresh("paypal-payout-item-succeeded.json");
    const milestoneId = ev.resource.payout_item.sender_item_id.split(":")[0];
    expect(await (await post(ev)).json()).toMatchObject({ ok: true, duplicate: false, outcome: "enqueued" });
    expect((await stored(ev.id))?.processedAt).toBeNull();
    const again = await post(ev);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true, outcome: "enqueued" });
    expect(state.enqueued).toHaveLength(2);
    expect(state.enqueued[1]).toEqual(["settle", milestoneId, { eventId: ev.id, eventType: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" }, { dedupe: ev.id }]);
  });

  it("a failed payout item is routed to settle too", async () => {
    const ev = fresh("paypal-payout-item-failed.json");
    expect(await (await post(ev)).json()).toMatchObject({ outcome: "enqueued" });
    expect(state.enqueued[0]?.[3]).toEqual({ dedupe: ev.id });
  });

  it("unknown event type -> stored and 200", async () => {
    const ev = fresh("paypal-dispute-created.json", "BILLING.SUBSCRIPTION.CREATED");
    const res = await post(ev);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, outcome: "stored" });
    const row = await stored(ev.id);
    expect(row).toMatchObject({ type: "BILLING.SUBSCRIPTION.CREATED" });
    expect(row?.processedAt).not.toBeNull();
    expect(state.enqueued).toHaveLength(0);
  });

  it("a capture for no known milestone is stored, audited and processed", async () => {
    const ev = fresh("paypal-payment-capture-completed.json");
    ev.resource.id = `CAP-T-${tag}`;
    ev.resource.invoice_id = `mst_none_${tag}`;
    expect(await (await post(ev)).json()).toMatchObject({ ok: true, outcome: "ignored" });
    expect((await stored(ev.id))?.processedAt).not.toBeNull();
  });
});
