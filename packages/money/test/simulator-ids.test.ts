/** A real PayPal client never sends a simulator id (recorded showcase rows on the real sandbox). */
import { describe, expect, it } from "vitest";
import { PayPalClient, PayPalError, SimulatorIdError, simulatorIdsIn } from "../src/paypal/client.ts";
import { createPayPalClient } from "../src/paypal/mode.ts";
import { refundCapture, chargeVault } from "../src/paypal/money.ts";

function recording() {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/oauth2/token")) return new Response('{"access_token":"tok","expires_in":3600}');
    return new Response('{"id":"R1","status":"COMPLETED"}');
  };
  return { calls, fetchImpl };
}

describe("simulator ids on a real client", () => {
  it("finds them in path segments and in JSON string values only", () => {
    expect(simulatorIdsIn("/v2/payments/captures/SIM-CAP-SHOW510K2F/refund", null)).toEqual(["SIM-CAP-SHOW510K2F"]);
    expect(simulatorIdsIn("/v2/checkout/orders", { payment_source: { paypal: { vault_id: "SIM-PMT-SHOWCASEY01" } }, purchase_units: [{ description: "SIM card shop" }] })).toEqual(["SIM-PMT-SHOWCASEY01"]);
    expect(simulatorIdsIn("/v1/payments/payouts", { items: [{ receiver: "f@example.com", sender_item_id: "mst_1:freelancer" }] })).toEqual([]);
  });

  it("refuses a refund of a simulator capture before anything is sent, as a definite 4xx", async () => {
    const { calls, fetchImpl } = recording();
    const client = new PayPalClient({ clientId: "a", clientSecret: "b", env: "sandbox", fetchImpl, refuseSimulatorIds: true });
    const err = await refundCapture(client, "SIM-CAP-SHOW510K2F", { amountMinor: 3000, currency: "USD", requestId: "rid-1" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SimulatorIdError);
    expect(err).toBeInstanceOf(PayPalError);
    expect((err as PayPalError).status).toBe(422);
    expect(calls).toEqual([]); // not even the token call
  });

  it("refuses a vault charge with a simulator token", async () => {
    const { calls, fetchImpl } = recording();
    const client = new PayPalClient({ clientId: "a", clientSecret: "b", env: "sandbox", fetchImpl, refuseSimulatorIds: true });
    await expect(chargeVault(client, { requestId: "rid-2", vaultId: "SIM-PMT-SHOWCASEY01", milestoneId: "mst_2", amountMinor: 10000, currency: "USD" })).rejects.toBeInstanceOf(SimulatorIdError);
    expect(calls).toEqual([]);
  });

  it("sends real ids as before", async () => {
    const { calls, fetchImpl } = recording();
    const client = new PayPalClient({ clientId: "a", clientSecret: "b", env: "sandbox", fetchImpl, refuseSimulatorIds: true });
    await refundCapture(client, "3C679366HH908993F", { amountMinor: 3000, currency: "USD", requestId: "rid-3" });
    expect(calls.some((u) => u.endsWith("/v2/payments/captures/3C679366HH908993F/refund"))).toBe(true);
  });

  it("is on for clients made from the environment and off for the simulator", async () => {
    const real = createPayPalClient({ PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "id", PAYPAL_CLIENT_SECRET: "s" } as NodeJS.ProcessEnv);
    await expect(real.request("GET", "/v2/checkout/orders/SIM-ORD-SHOW410A7Q")).rejects.toBeInstanceOf(SimulatorIdError);
    const sim = createPayPalClient({ PAYPAL_MODE: "simulated" } as NodeJS.ProcessEnv);
    // The simulator answers its own ids (a 404 for one it does not hold, never a SimulatorIdError).
    const e = await sim.request("GET", "/v2/checkout/orders/SIM-ORD-NOTTHERE01").catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(SimulatorIdError);
  });
});
