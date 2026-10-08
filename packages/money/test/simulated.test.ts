import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveSimulatedOrder,
  configureSimulator,
  createPayPalClient,
  createSimulatedPayPalClient,
  failNextSimulatedPayout,
  isSimulatedWebhook,
  paypalMode,
  resetSimulator,
  simulatedFetch,
} from "../src/paypal/simulated.ts";
import { PayPalClient, PayPalError } from "../src/paypal/client.ts";
import { approveLink, createOrder, getOrder } from "../src/paypal/orders.ts";
import { issuePaidReceipt } from "../src/paypal/invoices.ts";
import { verifyWebhookSignature, type WebhookEvent } from "../src/paypal/webhooks.ts";
import type { Order } from "../src/paypal/orders.ts";

// Raw REST calls (the money helpers in paypal/money.ts are reachable only through policy/execute.ts).
type Capture = { id: string; status: string; amount: { value: string; currency_code: string } };
async function captureOrder(c: PayPalClient, orderId: string, requestId: string) {
  const order = await c.request<Order>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { requestId });
  return { order, capture: order.purchase_units?.[0]?.payments?.captures?.[0] as Capture };
}
type PayoutItem = { receiverEmail: string; amountMinor: number; currency: string; note: string; senderItemId: string };
type Batch = { batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header: { sender_batch_id: string } }; items?: Array<{ transaction_status: string }> };
function createPayout(c: PayPalClient, input: { requestId: string; senderBatchId: string; items: PayoutItem[] }) {
  return c.request<Batch>(
    "POST",
    "/v1/payments/payouts",
    {
      sender_batch_header: { sender_batch_id: input.senderBatchId },
      items: input.items.map((i) => ({ recipient_type: "EMAIL", receiver: i.receiverEmail, amount: { value: (i.amountMinor / 100).toFixed(2), currency: i.currency }, note: i.note, sender_item_id: i.senderItemId })),
    },
    { requestId: input.requestId },
  );
}
const getPayoutBatch = (c: PayPalClient, id: string) => c.request<Batch>("GET", `/v1/payments/payouts/${id}`);
function refundCapture(c: PayPalClient, captureId: string, input: { amountMinor: number; currency: string; requestId: string }) {
  return c.request<{ id: string; status: string; amount: { value: string; currency_code: string } }>(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    { amount: { value: (input.amountMinor / 100).toFixed(2), currency_code: input.currency } },
    { requestId: input.requestId },
  );
}

const events: WebhookEvent[] = [];
const dir = mkdtempSync(join(tmpdir(), "sim-paypal-"));
const stateFile = join(dir, "state.json");

beforeEach(() => {
  configureSimulator({ stateFile, webhookDelayMs: 30, deliver: (e) => void events.push(e), appUrl: "http://app.test" });
  resetSimulator();
  events.length = 0;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const client = () => createSimulatedPayPalClient();
const eventsOf = (type: string) => events.filter((e) => e.event_type === type);

async function fundedOrder(c: PayPalClient, milestoneId = "ms_1", amountMinor = 50_000) {
  const order = await createOrder(c, { amountMinor, currency: "USD", referenceId: milestoneId, returnUrl: "http://app.test/r", cancelUrl: "http://app.test/c", requestId: `order-${milestoneId}` });
  approveSimulatedOrder(order.id);
  const { capture } = await captureOrder(c, order.id, `capture-${milestoneId}`);
  return { order, capture };
}

describe("paypalMode", () => {
  it("defaults to simulated without credentials outside production", () => {
    expect(paypalMode({ NODE_ENV: "development" })).toBe("simulated");
    expect(paypalMode({ NODE_ENV: "development", PAYPAL_CLIENT_ID: "x" })).toBe("sandbox");
    expect(paypalMode({ NODE_ENV: "production" })).toBe("sandbox");
  });
  it("PAYPAL_MODE wins", () => {
    expect(paypalMode({ NODE_ENV: "production", PAYPAL_MODE: "simulated" })).toBe("simulated");
    expect(paypalMode({ NODE_ENV: "development", PAYPAL_MODE: "sandbox" })).toBe("sandbox");
    expect(paypalMode({ NODE_ENV: "development", PAYPAL_MODE: "" })).toBe("simulated");
  });
  it("createPayPalClient picks the simulator or the real client", async () => {
    const sim = createPayPalClient({ NODE_ENV: "development" });
    expect(await sim.accessToken()).toMatch(/^SIM-/);
    expect(() => createPayPalClient({ NODE_ENV: "development", PAYPAL_MODE: "sandbox" })).toThrow(/PAYPAL_CLIENT_ID/);
  });
});

describe("simulated orders", () => {
  it("mints server and client tokens", async () => {
    const c = client();
    expect(await c.accessToken()).toMatch(/^SIM-A21AA/);
    const ct = await c.clientToken();
    expect(ct.accessToken).toMatch(/^SIM-CT/);
    expect(ct.expiresIn).toBe(900);
  });

  it("CREATED -> APPROVED (approve link) -> COMPLETED with the order amount", async () => {
    const c = client();
    const order = await createOrder(c, { amountMinor: 12_345, currency: "USD", referenceId: "ms_a", returnUrl: "http://app.test/r", cancelUrl: "http://app.test/c", requestId: "rid-order" });
    expect(order.id).toMatch(/^SIM-[0-9A-Z]{17}$/);
    expect(order.status).toBe("CREATED");
    expect(approveLink(order)).toBe(`http://app.test/api/dev/paypal/approve?order=${order.id}`);
    expect(order.purchase_units?.[0]?.reference_id).toBe("ms_a");

    // Capture before approval fails, and the failure is not remembered for the request id.
    const early = await captureOrder(c, order.id, "rid-capture").catch((e: unknown) => e);
    expect(early).toBeInstanceOf(PayPalError);
    expect((early as PayPalError).status).toBe(422);
    expect(JSON.stringify((early as PayPalError).body)).toContain("ORDER_NOT_APPROVED");

    expect(approveSimulatedOrder(order.id)).toMatchObject({ status: "APPROVED", referenceId: "ms_a", amount: { value: "123.45", currency_code: "USD" } });
    expect((await getOrder(c, order.id)).status).toBe("APPROVED");

    const { order: done, capture } = await captureOrder(c, order.id, "rid-capture");
    expect(done.status).toBe("COMPLETED");
    expect(capture).toMatchObject({ status: "COMPLETED", amount: { value: "123.45", currency_code: "USD" } });
    expect(capture.id).toMatch(/^SIM-/);
    expect((await getOrder(c, order.id)).purchase_units?.[0]?.payments?.captures?.[0]?.id).toBe(capture.id);

    // A different request id is a second capture attempt: refused.
    const again = await captureOrder(c, order.id, "rid-other").catch((e: unknown) => e);
    expect(JSON.stringify((again as PayPalError).body)).toContain("ORDER_ALREADY_CAPTURED");

    await vi.waitFor(() => expect(eventsOf("PAYMENT.CAPTURE.COMPLETED")).toHaveLength(1));
    const resource = eventsOf("PAYMENT.CAPTURE.COMPLETED")[0]?.resource as Record<string, unknown>;
    expect(resource).toMatchObject({ id: capture.id, status: "COMPLETED", amount: { value: "123.45", currency_code: "USD" }, supplementary_data: { related_ids: { order_id: order.id } } });
  });

  it("is idempotent on PayPal-Request-Id: same id, same response, no second event", async () => {
    const c = client();
    const input = { amountMinor: 500, currency: "USD", referenceId: "ms_b", returnUrl: "http://app.test/r", cancelUrl: "http://app.test/c", requestId: "rid-same" };
    const a = await createOrder(c, input);
    const b = await createOrder(c, input);
    expect(b).toEqual(a);
    const other = await createOrder(c, { ...input, requestId: "rid-new" });
    expect(other.id).not.toBe(a.id);

    approveSimulatedOrder(a.id);
    const first = await captureOrder(c, a.id, "rid-cap");
    const second = await captureOrder(c, a.id, "rid-cap");
    expect(second).toEqual(first);
    await new Promise((r) => setTimeout(r, 120));
    expect(eventsOf("PAYMENT.CAPTURE.COMPLETED")).toHaveLength(1);
  });

  it("approving is idempotent and unknown orders are reported", async () => {
    const c = client();
    const order = await createOrder(c, { amountMinor: 100, currency: "USD", referenceId: "ms_c", returnUrl: "x", cancelUrl: "y" });
    expect(approveSimulatedOrder(order.id)?.status).toBe("APPROVED");
    expect(approveSimulatedOrder(order.id)?.status).toBe("APPROVED");
    expect(approveSimulatedOrder("SIM-NOPE")).toBeNull();
    await expect(getOrder(c, "SIM-NOPE")).rejects.toMatchObject({ status: 404 });
  });
});

describe("simulated payouts", () => {
  const items = (m: string) => [
    { receiverEmail: "partner@example.com", amountMinor: 10_000, currency: "USD", note: "repay", senderItemId: `${m}:partner` },
    { receiverEmail: "free@example.com", amountMinor: 30_000, currency: "USD", note: "release", senderItemId: `${m}:freelancer` },
  ];

  it("PENDING batch, then SUCCESS items and one SUCCEEDED event per item", async () => {
    const c = client();
    const batch = await createPayout(c, { requestId: "rid-p1", senderBatchId: "rid-p1", items: items("ms_p") });
    expect(batch.batch_header).toMatchObject({ batch_status: "PENDING", sender_batch_header: { sender_batch_id: "rid-p1" } });
    const id = batch.batch_header.payout_batch_id;
    expect(id).toMatch(/^SIM-/);
    expect((await getPayoutBatch(c, id)).items?.map((i) => i.transaction_status)).toEqual(["PENDING", "PENDING"]);

    await vi.waitFor(() => expect(eventsOf("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toHaveLength(2));
    const got = await getPayoutBatch(c, id);
    expect(got.batch_header.batch_status).toBe("SUCCESS");
    expect(got.items?.map((i) => i.transaction_status)).toEqual(["SUCCESS", "SUCCESS"]);
    const resources = eventsOf("PAYMENT.PAYOUTS-ITEM.SUCCEEDED").map((e) => e.resource as { payout_batch_id: string; transaction_status: string; payout_item: { sender_item_id: string; amount: { value: string; currency: string } } });
    expect(resources.map((r) => [r.payout_item.sender_item_id, r.payout_item.amount])).toEqual([
      ["ms_p:partner", { value: "100.00", currency: "USD" }],
      ["ms_p:freelancer", { value: "300.00", currency: "USD" }],
    ]);
    expect(resources.every((r) => r.payout_batch_id === id && r.transaction_status === "SUCCESS")).toBe(true);
  });

  it("replays the batch for the same request id and refuses a duplicate sender_batch_id", async () => {
    const c = client();
    const a = await createPayout(c, { requestId: "rid-p2", senderBatchId: "rid-p2", items: items("ms_q") });
    const b = await createPayout(c, { requestId: "rid-p2", senderBatchId: "rid-p2", items: items("ms_q") });
    expect(b).toEqual(a);
    await expect(createPayout(c, { requestId: "rid-p2-other", senderBatchId: "rid-p2", items: items("ms_q") })).rejects.toMatchObject({ status: 400 });
    await new Promise((r) => setTimeout(r, 120));
    expect(eventsOf("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toHaveLength(2);
  });

  it("fails the NEXT item for an armed sender_item_id, once", async () => {
    const c = client();
    failNextSimulatedPayout("ms_r:freelancer", "RECEIVER_UNREGISTERED");
    const first = await createPayout(c, { requestId: "rid-r1", senderBatchId: "rid-r1", items: items("ms_r") });
    // A replay of the same request does not consume a second failure.
    await createPayout(c, { requestId: "rid-r1", senderBatchId: "rid-r1", items: items("ms_r") });
    await vi.waitFor(() => expect(eventsOf("PAYMENT.PAYOUTS-ITEM.FAILED")).toHaveLength(1));
    const failed = eventsOf("PAYMENT.PAYOUTS-ITEM.FAILED")[0]?.resource as { transaction_status: string; payout_item: { sender_item_id: string }; errors: { name: string } };
    expect(failed).toMatchObject({ transaction_status: "FAILED", payout_item: { sender_item_id: "ms_r:freelancer" }, errors: { name: "RECEIVER_UNREGISTERED" } });
    expect(eventsOf("PAYMENT.PAYOUTS-ITEM.SUCCEEDED").map((e) => (e.resource as { payout_item: { sender_item_id: string } }).payout_item.sender_item_id)).toEqual(["ms_r:partner"]);
    const batch = await getPayoutBatch(c, first.batch_header.payout_batch_id);
    expect(batch.items?.map((i) => i.transaction_status)).toEqual(["SUCCESS", "FAILED"]);

    events.length = 0;
    await createPayout(c, { requestId: "rid-r2", senderBatchId: "rid-r2", items: items("ms_r") });
    await vi.waitFor(() => expect(eventsOf("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toHaveLength(2));
    expect(eventsOf("PAYMENT.PAYOUTS-ITEM.FAILED")).toHaveLength(0);
  });
});

describe("simulated refunds", () => {
  it("refunds a share COMPLETED, emits REFUNDED with an up link, and caps at the captured amount", async () => {
    const c = client();
    const { capture } = await fundedOrder(c, "ms_f", 50_000);
    const refund = await refundCapture(c, capture.id, { amountMinor: 20_000, currency: "USD", requestId: "rid-ref" });
    expect(refund).toMatchObject({ status: "COMPLETED", amount: { value: "200.00", currency_code: "USD" } });
    expect(await refundCapture(c, capture.id, { amountMinor: 20_000, currency: "USD", requestId: "rid-ref" })).toEqual(refund);
    await expect(refundCapture(c, capture.id, { amountMinor: 40_000, currency: "USD", requestId: "rid-ref-2" })).rejects.toMatchObject({ status: 422 });

    await vi.waitFor(() => expect(eventsOf("PAYMENT.CAPTURE.REFUNDED")).toHaveLength(1));
    const resource = eventsOf("PAYMENT.CAPTURE.REFUNDED")[0]?.resource as { id: string; links: Array<{ rel: string; href: string }> };
    expect(resource.id).toBe(refund.id);
    expect(resource.links.find((l) => l.rel === "up")?.href).toMatch(new RegExp(`/v2/payments/captures/${capture.id}$`));
    const cap = await c.request<{ status: string }>("GET", `/v2/payments/captures/${capture.id}`);
    expect(cap.status).toBe("PARTIALLY_REFUNDED");
  });

  it("404s an unknown capture", async () => {
    await expect(refundCapture(client(), "SIM-NOPE", { amountMinor: 1, currency: "USD", requestId: "x" })).rejects.toMatchObject({ status: 404 });
  });
});

describe("simulated invoicing and webhooks", () => {
  it("creates, sends and pays a receipt invoice; a retry with the same request id is a no-op", async () => {
    const c = client();
    const input = { requestId: "rid-inv", invoiceNumber: "MS-123", freelancerEmail: "f@example.com", clientEmail: "c@example.com", currency: "USD", amountMinor: 30_000, description: "work" };
    const { invoiceId } = await issuePaidReceipt(c, input);
    expect(invoiceId).toMatch(/^SIM-INV2-/);
    expect(await issuePaidReceipt(c, input)).toEqual({ invoiceId });
    const inv = await c.request<{ status: string }>("GET", `/v2/invoicing/invoices/${invoiceId}`);
    expect(inv.status).toBe("PAID");
    await expect(issuePaidReceipt(c, { ...input, requestId: "rid-inv-2" })).rejects.toMatchObject({ status: 422 });
  });

  it("verify-webhook-signature says SUCCESS; the route trusts only the simulated header", async () => {
    expect(await verifyWebhookSignature(client(), {}, JSON.stringify({ id: "x" }), "WH")).toBe(true);
    const dev = { NODE_ENV: "development" };
    expect(isSimulatedWebhook(new Headers({ "X-Milestone-Simulated": "dev" }), dev)).toBe(true);
    expect(isSimulatedWebhook(new Headers({ "X-Milestone-Simulated": "nope" }), dev)).toBe(false);
    expect(isSimulatedWebhook(new Headers(), dev)).toBe(false);
    expect(isSimulatedWebhook(new Headers({ "X-Milestone-Simulated": "s3cret" }), { ...dev, SIMULATED_WEBHOOK_SECRET: "s3cret" })).toBe(true);
    // Never outside simulated mode, and no "dev" default in production.
    expect(isSimulatedWebhook(new Headers({ "X-Milestone-Simulated": "dev" }), { NODE_ENV: "development", PAYPAL_MODE: "sandbox" })).toBe(false);
    expect(isSimulatedWebhook(new Headers({ "X-Milestone-Simulated": "dev" }), { NODE_ENV: "production", PAYPAL_MODE: "simulated" })).toBe(false);
  });

  it("rejects calls without a bearer token and unknown paths", async () => {
    const res = await simulatedFetch("https://api-m.sandbox.paypal.com/v2/checkout/orders/x", { method: "GET" });
    expect(res.status).toBe(401);
    await expect(client().request("GET", "/v9/nothing")).rejects.toMatchObject({ status: 404 });
  });
});

describe("persistence", () => {
  it("writes state atomically to the file and another process (fresh memory) sees it", async () => {
    const c = client();
    const order = await createOrder(c, { amountMinor: 700, currency: "USD", referenceId: "ms_p1", returnUrl: "x", cancelUrl: "y", requestId: "rid-persist" });
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { records: Record<string, unknown> };
    expect(saved.records[`order:${order.id}`]).toMatchObject({ status: "CREATED" });
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".lock"))).toEqual([]);

    // Reconfiguring drops the in-memory Map, like a second process starting: state comes back from the file.
    configureSimulator({ stateFile });
    expect(approveSimulatedOrder(order.id)?.status).toBe("APPROVED");
    expect((await getOrder(client(), order.id)).status).toBe("APPROVED");
    // The idempotency record survived too.
    expect((await createOrder(client(), { amountMinor: 700, currency: "USD", referenceId: "ms_p1", returnUrl: "x", cancelUrl: "y", requestId: "rid-persist" })).id).toBe(order.id);
  });

  it("an armed failure set by one process is consumed by another", async () => {
    failNextSimulatedPayout("ms_x:freelancer");
    configureSimulator({ stateFile });
    await createPayout(client(), { requestId: "rid-x", senderBatchId: "rid-x", items: [{ receiverEmail: "f@example.com", amountMinor: 100, currency: "USD", note: "n", senderItemId: "ms_x:freelancer" }] });
    await vi.waitFor(() => expect(eventsOf("PAYMENT.PAYOUTS-ITEM.FAILED")).toHaveLength(1));
  });

  it("concurrent calls do not lose writes", async () => {
    const c = client();
    const orders = await Promise.all(Array.from({ length: 20 }, (_, i) => createOrder(c, { amountMinor: 100 + i, currency: "USD", referenceId: `ms_c${i}`, returnUrl: "x", cancelUrl: "y", requestId: `rid-c${i}` })));
    const saved = JSON.parse(readFileSync(stateFile, "utf8")) as { records: Record<string, unknown> };
    for (const o of orders) expect(saved.records[`order:${o.id}`]).toBeDefined();
  });
});
