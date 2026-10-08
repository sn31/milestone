import { describe, expect, it } from "vitest";
import { PayPalClient, isMoneyPath } from "../src/paypal/client.ts";
import { toPayPalValue, fromPayPalValue } from "@milestone/core";

describe("PayPalClient", () => {
  it("refuses a money POST without a request id", async () => {
    const client = new PayPalClient({ clientId: "a", clientSecret: "b", env: "sandbox", fetchImpl: async () => new Response('{"access_token":"t","expires_in":100}') });
    await expect(client.request("POST", "/v2/checkout/orders/1/capture", {})).rejects.toThrow(/PayPal-Request-Id/);
  });
  it("sends the idempotency header and caches the token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)) });
      if (String(url).endsWith("/oauth2/token")) return new Response('{"access_token":"tok","expires_in":3600}');
      return new Response('{"id":"PAYOUT1","batch_header":{"payout_batch_id":"B1","batch_status":"PENDING","sender_batch_header":{"sender_batch_id":"s"}}}');
    };
    const client = new PayPalClient({ clientId: "a", clientSecret: "b", env: "sandbox", fetchImpl });
    await client.request("POST", "/v1/payments/payouts", {}, { requestId: "req-1" });
    await client.request("POST", "/v1/payments/payouts", {}, { requestId: "req-1" });
    const tokenCalls = calls.filter((c) => c.url.endsWith("/oauth2/token"));
    expect(tokenCalls).toHaveLength(1);
    const payoutCall = calls.find((c) => c.url.endsWith("/payouts"));
    expect(payoutCall?.headers["PayPal-Request-Id"]).toBe("req-1");
  });
  it("knows which paths move money", () => {
    expect(isMoneyPath("/v2/checkout/orders/abc/capture")).toBe(true);
    expect(isMoneyPath("/v2/checkout/orders")).toBe(false);
  });
});

describe("money formatting", () => {
  it("round-trips minor units", () => {
    expect(toPayPalValue(12345, "USD")).toBe("123.45");
    expect(fromPayPalValue("123.45", "USD")).toBe(12345);
    expect(toPayPalValue(500, "JPY")).toBe("500");
  });
});

describe("createPayout retry", () => {
  it("recovers the existing batch when PayPal rejects a reused sender_batch_id", async () => {
    const { createPayout } = await import("../src/paypal/money.ts");
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      const u = String(url); calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.endsWith("/oauth2/token")) return new Response('{"access_token":"t","expires_in":3600}');
      if (u.endsWith("/v1/payments/payouts")) return new Response(JSON.stringify({ name: "USER_BUSINESS_ERROR", details: [{ field: "SENDER_BATCH_ID", issue: "Batch with given sender_batch_id already exists", link: [{ href: "https://api.sandbox.paypal.com/v1/payments/payouts/5BEXM4CEXRF7Q" }] }] }), { status: 400 });
      if (u.endsWith("/v1/payments/payouts/5BEXM4CEXRF7Q")) return new Response('{"batch_header":{"payout_batch_id":"5BEXM4CEXRF7Q","batch_status":"SUCCESS","sender_batch_header":{"sender_batch_id":"s"}}}');
      return new Response("{}", { status: 404 });
    };
    const client = new PayPalClient({ clientId: "a", clientSecret: "b", env: "sandbox", fetchImpl });
    const batch = await createPayout(client, { requestId: "req", senderBatchId: "s", items: [{ receiverEmail: "f@x.test", amountMinor: 100, currency: "USD", note: "n", senderItemId: "m:freelancer" }] });
    expect(batch.batch_header.payout_batch_id).toBe("5BEXM4CEXRF7Q");
    expect(calls.filter((c) => c.startsWith("POST") && c.endsWith("/payouts"))).toHaveLength(1);
  });
});
