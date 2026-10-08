/**
 * Money spike (Oct 9): create order -> approve in a browser as the client sandbox account ->
 * capture into the platform account -> full release payout -> a second order and a partial release
 * (payout plus refund). Goes through the same policy functions the worker uses.
 * Run: pnpm paypal:spike   (reads ../../.env; needs SPIKE_FREELANCER_EMAIL)
 * Writes each response to fixtures/paypal-recordings/spike.local.json for CI fixtures.
 */
import { createInterface } from "node:readline/promises";
import { writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PayPalClient } from "./paypal/client.ts";
import { approveLink, createOrder, getOrder } from "./paypal/orders.ts";
import { captureFunding, executeRelease, type MoneyContext } from "./policy/execute.ts";

try { process.loadEnvFile(new URL("../../../.env", import.meta.url).pathname); } catch { /* env already set */ }

const freelancer = process.env.SPIKE_FREELANCER_EMAIL;
if (!freelancer) throw new Error("SPIKE_FREELANCER_EMAIL (a sandbox personal or business account) is required");
const client = PayPalClient.fromEnv();
const currency = "USD";
const recordings: Record<string, unknown> = {};
const rl = createInterface({ input: process.stdin, output: process.stdout });
const out = new URL("../../../fixtures/paypal-recordings/spike.local.json", import.meta.url).pathname;
const save = () => writeFileSync(out, JSON.stringify(recordings, null, 2));
process.on("exit", () => { save(); console.log("Recorded to", out); });

// In-memory stand-in for the paypal_ops table: same (kind, key) -> same request id.
const ids = new Map<string, string>();
const ctx: MoneyContext = { client, requestIdFor: async (kind, key) => { const k = `${kind}:${key}`; if (!ids.has(k)) ids.set(k, randomUUID()); return ids.get(k)!; } };

async function fund(label: string, amountMinor: number) {
  const milestoneId = `spike-${label}-${Date.now()}`;
  const order = await createOrder(client, { amountMinor, currency, referenceId: milestoneId, returnUrl: "https://example.com/return", cancelUrl: "https://example.com/cancel", requestId: randomUUID() });
  recordings[`${label}.createOrder`] = order;
  console.log(`${label}: order ${order.id}. Approve it as the CLIENT sandbox account:`, approveLink(order));
  await rl.question("   Press Enter after approving... ");
  const approved = await getOrder(client, order.id);
  if (approved.status !== "APPROVED") throw new Error(`order status is ${approved.status}, expected APPROVED`);
  const { capture } = await captureFunding(ctx, milestoneId, order.id);
  recordings[`${label}.capture`] = capture;
  console.log(`${label}: captured ${capture.id} ${capture.status}`);
  return { milestoneId, capture };
}

const m1 = await fund("m1", 50_00);
recordings["m1.release"] = await executeRelease(ctx, { milestoneId: m1.milestoneId, currency, captureId: m1.capture.id, freelancerEmail: freelancer, milestoneAmountMinor: 50_00, decision: { action: "release", amountMinor: 50_00, ruleIds: ["P6"], reason: "spike" } });
console.log("m1: full release sent", JSON.stringify(recordings["m1.release"]).slice(0, 200));
// A retry must reuse the same request id and never pay twice.
recordings["m1.releaseRetry"] = await executeRelease(ctx, { milestoneId: m1.milestoneId, currency, captureId: m1.capture.id, freelancerEmail: freelancer, milestoneAmountMinor: 50_00, decision: { action: "release", amountMinor: 50_00, ruleIds: ["P6"], reason: "spike retry" } });
console.log("m1: retry returned the same batch:", JSON.stringify(recordings["m1.releaseRetry"]) === JSON.stringify(recordings["m1.release"]));

const m2 = await fund("m2", 40_00);
recordings["m2.partial"] = await executeRelease(ctx, { milestoneId: m2.milestoneId, currency, captureId: m2.capture.id, freelancerEmail: freelancer, milestoneAmountMinor: 40_00, decision: { action: "partial", amountMinor: 30_00, ruleIds: ["P5"], reason: "spike" } });
console.log("m2: partial release sent (payout 30.00, refund 10.00)");
rl.close();
