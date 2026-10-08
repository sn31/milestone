/**
 * Money spike (Oct 9): create order -> approve in a browser as the client sandbox account ->
 * capture into the platform account -> payout to the freelancer -> partial refund to the client.
 * Run: pnpm paypal:spike   (reads ../../.env)
 * Writes each response to fixtures/paypal-recordings/spike.local.json for CI fixtures.
 */
import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PayPalClient } from "./paypal/client.js";
import { approveLink, createOrder, getOrder } from "./paypal/orders.js";
import { captureOrder, createPayout, getPayoutBatch, refundCapture } from "./paypal/money.js";

try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

const freelancer = process.env.SPIKE_FREELANCER_EMAIL;
if (!freelancer) throw new Error("SPIKE_FREELANCER_EMAIL (a sandbox personal or business account) is required");
const client = PayPalClient.fromEnv();
const currency = "USD";
const recordings: Record<string, unknown> = {};
const rl = createInterface({ input: process.stdin, output: process.stdout });

const order = await createOrder(client, {
  amountMinor: 50_00, currency, referenceId: `spike-${Date.now()}`,
  returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel", requestId: randomUUID(),
});
recordings.createOrder = order;
console.log("1. Order created:", order.id);
console.log("   Approve it as the CLIENT sandbox account:", approveLink(order));
await rl.question("   Press Enter after approving... ");

const approved = await getOrder(client, order.id);
if (approved.status !== "APPROVED") throw new Error(`order status is ${approved.status}, expected APPROVED`);

const { capture } = await captureOrder(client, order.id, randomUUID());
recordings.capture = capture;
console.log("2. Captured into the platform account:", capture.id, capture.status);

const batch = await createPayout(client, {
  requestId: randomUUID(), senderBatchId: `spike-${Date.now()}`,
  items: [{ receiverEmail: freelancer, amountMinor: 40_00, currency, note: "Spike release", senderItemId: "m1" }],
});
recordings.payout = batch;
console.log("3. Payout batch:", batch.batch_header.payout_batch_id, batch.batch_header.batch_status);
await new Promise((r) => setTimeout(r, 3000));
recordings.payoutStatus = await getPayoutBatch(client, batch.batch_header.payout_batch_id);
console.log("   Status after 3s:", (recordings.payoutStatus as { batch_header: { batch_status: string } }).batch_header.batch_status);

const refund = await refundCapture(client, capture.id, { amountMinor: 10_00, currency, requestId: randomUUID(), note: "Spike partial release" });
recordings.refund = refund;
console.log("4. Partial refund to the client:", refund.id, refund.status);

const out = new URL("../../../fixtures/paypal-recordings/spike.local.json", import.meta.url).pathname;
writeFileSync(out, JSON.stringify(recordings, null, 2));
console.log("Recorded to", out);
rl.close();
