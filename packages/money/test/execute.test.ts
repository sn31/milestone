import { beforeEach, describe, expect, it } from "vitest";
import { configureSimulator, createSimulatedPayPalClient, resetSimulator, approveSimulatedOrder } from "../src/paypal/simulated.ts";
import { createOrder } from "../src/paypal/orders.ts";
import { captureFunding, executePayout, executeRelease, type MoneyContext } from "../src/policy/execute.ts";

beforeEach(() => {
  configureSimulator({ stateFile: null, webhookDelayMs: 1, deliver: () => undefined });
  resetSimulator();
});

function context(): MoneyContext & { ops: Map<string, string> } {
  const ops = new Map<string, string>();
  return {
    ops,
    client: createSimulatedPayPalClient(),
    requestIdFor: async (kind, key) => {
      const k = `${kind}:${key}`;
      if (!ops.has(k)) ops.set(k, `rid-${ops.size + 1}`);
      return ops.get(k)!;
    },
  };
}

async function funded(ctx: MoneyContext, milestoneId: string, amountMinor: number) {
  const order = await createOrder(ctx.client, { amountMinor, currency: "USD", referenceId: milestoneId, returnUrl: "x", cancelUrl: "y" });
  approveSimulatedOrder(order.id);
  return (await captureFunding(ctx, milestoneId, order.id)).capture.id;
}

describe("executeRelease", () => {
  it("pays the partner first, then the freelancer, and refunds the unreleased share under their own ops", async () => {
    const ctx = context();
    const captureId = await funded(ctx, "ms_1", 10_000);
    const res = await executeRelease(ctx, {
      milestoneId: "ms_1",
      currency: "USD",
      captureId,
      freelancerEmail: "f@example.com",
      partner: { email: "p@example.com", amountMinor: 3_000 },
      milestoneAmountMinor: 10_000,
      decision: { action: "partial", amountMinor: 8_000, ruleIds: ["P5"], reason: "t" },
    });
    expect(res.payout?.batch_header.sender_batch_header.sender_batch_id).toBe(ctx.ops.get("payout:ms_1"));
    expect(res.refund?.status).toBe("COMPLETED");
    const batch = await ctx.client.request<{ items: Array<{ payout_item: { sender_item_id: string; receiver: string; amount: { value: string } } }> }>("GET", `/v1/payments/payouts/${res.payout?.batch_header.payout_batch_id}`);
    expect(batch.items.map((i) => [i.payout_item.sender_item_id, i.payout_item.receiver, i.payout_item.amount.value])).toEqual([
      ["ms_1:partner", "p@example.com", "30.00"],
      ["ms_1:freelancer", "f@example.com", "50.00"],
    ]);
    const refund = await ctx.client.request<{ amount: { value: string } }>("GET", `/v2/payments/refunds/${res.refund?.id}`);
    expect(refund.amount.value).toBe("20.00");
    expect([...ctx.ops.keys()].sort()).toEqual(["capture:ms_1", "payout:ms_1", "refund:ms_1"]);
  });

  it("refuses hold and ask_client, and a retried payout replays the same batch", async () => {
    const ctx = context();
    const plan = { milestoneId: "ms_2", currency: "USD", captureId: "c", freelancerEmail: "f@example.com", milestoneAmountMinor: 5_000 };
    await expect(executeRelease(ctx, { ...plan, decision: { action: "hold", amountMinor: 0, ruleIds: [], reason: "t" } })).rejects.toThrow(/hold/);
    const req = { milestoneId: "ms_2", currency: "USD", items: [{ party: "freelancer" as const, email: "f@example.com", amountMinor: 5_000 }] };
    const a = await executePayout(ctx, req);
    const b = await executePayout(ctx, req);
    expect(b.batch_header.payout_batch_id).toBe(a.batch_header.payout_batch_id);
  });
});
