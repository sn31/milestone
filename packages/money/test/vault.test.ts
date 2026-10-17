/** Simulated PayPal vault (Payment Method Tokens v3) round trip, and the vault charge against it. No database. */
import { beforeEach, describe, expect, it } from "vitest";
import { approveSimulatedSetupToken, armSimulatedVaultCharge, configureSimulator, createSimulatedPayPalClient, resetSimulator, simulatedSetupToken } from "../src/paypal/simulated.ts";
import { PayPalError } from "../src/paypal/client.ts";
import { createPaymentToken, createSetupToken, deletePaymentToken, getPaymentToken, getSetupToken } from "../src/paypal/vault.ts";
import { chargeVault } from "../src/paypal/money.ts";
import type { WebhookEvent } from "../src/paypal/webhooks.ts";

const events: WebhookEvent[] = [];
beforeEach(() => {
  configureSimulator({ stateFile: null, webhookDelayMs: 5, deliver: (e) => void events.push(e), appUrl: "http://app.test" });
  resetSimulator();
  events.length = 0;
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const client = () => createSimulatedPayPalClient();

async function savedPayPal(c = client(), tag = "a") {
  const setup = await createSetupToken(c, { requestId: `rid-setup-${tag}`, returnUrl: "http://app.test/settings/paypal?done=1", cancelUrl: "http://app.test/settings/paypal?cancel=1", description: "Milestone funding" });
  approveSimulatedSetupToken(setup.setupTokenId, { payerEmail: "casey@example.com" });
  const token = await createPaymentToken(c, { requestId: `rid-token-${tag}`, setupTokenId: setup.setupTokenId });
  return { setup, token };
}

describe("simulated vault", () => {
  it("setup token -> approve -> payment token -> delete", async () => {
    const c = client();
    const setup = await createSetupToken(c, { requestId: "rid-setup", returnUrl: "http://app.test/back", cancelUrl: "http://app.test/cancel", description: "Milestone funding" });
    expect(setup.status).toBe("PAYER_ACTION_REQUIRED");
    expect(setup.setupTokenId).toMatch(/^SIM-SETUP-/);
    expect(setup.customerId).toMatch(/^SIM-CUST-/);
    expect(setup.approveUrl).toBe(`http://app.test/api/dev/paypal/vault-approve?token=${setup.setupTokenId}`);
    const raw = await getSetupToken(c, setup.setupTokenId);
    expect(raw).toMatchObject({ status: "PAYER_ACTION_REQUIRED", payment_source: { paypal: { usage_type: "MERCHANT", customer_type: "CONSUMER", usage_pattern: "UNSCHEDULED_POSTPAID", permit_multiple_payment_tokens: false, brand_name: "Milestone" } } });

    // Same PayPal-Request-Id: the same setup token comes back.
    const again = await createSetupToken(c, { requestId: "rid-setup", returnUrl: "http://app.test/back", cancelUrl: "http://app.test/cancel", description: "Milestone funding" });
    expect(again.setupTokenId).toBe(setup.setupTokenId);

    // Before approval the payment token is refused (and the refusal is not remembered for the request id).
    const early = await createPaymentToken(c, { requestId: "rid-token", setupTokenId: setup.setupTokenId }).catch((e: unknown) => e);
    expect(early).toBeInstanceOf(PayPalError);
    expect(JSON.stringify((early as PayPalError).body)).toContain("SETUP_TOKEN_NOT_APPROVED");

    const approved = approveSimulatedSetupToken(setup.setupTokenId, { payerEmail: "casey@example.com" });
    expect(approved?.status).toBe("APPROVED");
    expect(approved?.returnUrl).toContain(`approval_token_id=${setup.setupTokenId}`);
    expect(approveSimulatedSetupToken("SIM-SETUP-NOPE")).toBeNull();

    const token = await createPaymentToken(c, { requestId: "rid-token", setupTokenId: setup.setupTokenId });
    expect(token).toEqual({ paymentTokenId: expect.stringMatching(/^SIM-PMT-/), customerId: setup.customerId, payerEmail: "casey@example.com" });
    expect(simulatedSetupToken(setup.setupTokenId)).toMatchObject({ status: "VAULTED", paymentTokenId: token.paymentTokenId });
    // Replayed by request id, and a fresh request for the same setup token returns the same payment token.
    expect((await createPaymentToken(c, { requestId: "rid-token", setupTokenId: setup.setupTokenId })).paymentTokenId).toBe(token.paymentTokenId);
    expect((await createPaymentToken(c, { requestId: "rid-token-2", setupTokenId: setup.setupTokenId })).paymentTokenId).toBe(token.paymentTokenId);
    expect((await getPaymentToken(c, token.paymentTokenId)).payment_source?.paypal?.email_address).toBe("casey@example.com");
    const list = await c.request<{ payment_tokens: unknown[] }>("GET", `/v3/vault/payment-tokens?customer_id=${setup.customerId}`);
    expect(list.payment_tokens).toHaveLength(1);

    await deletePaymentToken(c, token.paymentTokenId);
    await deletePaymentToken(c, token.paymentTokenId); // gone already: still fine
    expect(await getPaymentToken(c, token.paymentTokenId).catch((e: unknown) => (e as PayPalError).status)).toBe(404);
    await wait(30);
    expect(events.map((e) => e.event_type).sort()).toEqual(["VAULT.PAYMENT-TOKEN.CREATED", "VAULT.PAYMENT-TOKEN.DELETED"]);
  });

  it("a vault charge completes at once with a capture, sends PAYMENT.CAPTURE.COMPLETED, and replays by request id", async () => {
    const c = client();
    const { token } = await savedPayPal(c);
    events.length = 0;
    const first = await chargeVault(c, { requestId: "rid-charge", vaultId: token.paymentTokenId, milestoneId: "mst_v1", amountMinor: 12_345, currency: "USD" });
    expect(first.order.status).toBe("COMPLETED");
    expect(first.order.purchase_units?.[0]?.reference_id).toBe("mst_v1");
    expect(first.capture).toMatchObject({ status: "COMPLETED", amount: { value: "123.45", currency_code: "USD" } });
    const replay = await chargeVault(c, { requestId: "rid-charge", vaultId: token.paymentTokenId, milestoneId: "mst_v1", amountMinor: 12_345, currency: "USD" });
    expect(replay.order.id).toBe(first.order.id);
    expect(replay.capture?.id).toBe(first.capture?.id);
    await wait(30);
    const captured = events.filter((e) => e.event_type === "PAYMENT.CAPTURE.COMPLETED");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.resource).toMatchObject({ id: first.capture?.id, status: "COMPLETED", custom_id: "mst_v1", supplementary_data: { related_ids: { order_id: first.order.id } } });
    const order = await c.request<{ payment_source: { paypal: { attributes: { vault: { id: string } } } } }>("GET", `/v2/checkout/orders/${first.order.id}`);
    expect(order.payment_source.paypal.attributes.vault.id).toBe(token.paymentTokenId);
  });

  it("an armed PENDING charge captures PENDING and completes later; DECLINED moves nothing and the retry succeeds", async () => {
    const c = client();
    const { token } = await savedPayPal(c);
    events.length = 0;
    armSimulatedVaultCharge(token.paymentTokenId, "PENDING");
    const pending = await chargeVault(c, { requestId: "rid-p", vaultId: token.paymentTokenId, milestoneId: "mst_p", amountMinor: 500, currency: "USD" });
    expect(pending.capture?.status).toBe("PENDING");
    await wait(60);
    const done = await c.request<{ status: string }>("GET", `/v2/payments/captures/${pending.capture?.id}`);
    expect(done.status).toBe("COMPLETED");
    expect(events.filter((e) => e.event_type === "PAYMENT.CAPTURE.COMPLETED")).toHaveLength(1);

    armSimulatedVaultCharge(token.paymentTokenId, "DECLINED");
    const declined = await chargeVault(c, { requestId: "rid-d", vaultId: token.paymentTokenId, milestoneId: "mst_d", amountMinor: 500, currency: "USD" }).catch((e: unknown) => e);
    expect(declined).toBeInstanceOf(PayPalError);
    expect((declined as PayPalError).status).toBe(422);
    expect(JSON.stringify((declined as PayPalError).body)).toContain("INSTRUMENT_DECLINED");
    const retry = await chargeVault(c, { requestId: "rid-d", vaultId: token.paymentTokenId, milestoneId: "mst_d", amountMinor: 500, currency: "USD" });
    expect(retry.capture?.status).toBe("COMPLETED");
  });

  it("refuses a deleted or unknown vault id, and needs a request id", async () => {
    const c = client();
    const { token } = await savedPayPal(c);
    await deletePaymentToken(c, token.paymentTokenId);
    const gone = await chargeVault(c, { requestId: "rid-x", vaultId: token.paymentTokenId, milestoneId: "mst_x", amountMinor: 100, currency: "USD" }).catch((e: unknown) => e);
    expect(JSON.stringify((gone as PayPalError).body)).toContain("INVALID_VAULT_ID");
    await expect(chargeVault(c, { requestId: "", vaultId: token.paymentTokenId, milestoneId: "mst_x", amountMinor: 100, currency: "USD" })).rejects.toThrow(/PayPal-Request-Id/);
    // A seeded showcase token is adopted on first use.
    const show = await chargeVault(c, { requestId: "rid-show", vaultId: "SIM-PMT-SHOWCASEY01", milestoneId: "mst_s", amountMinor: 100, currency: "USD" });
    expect(show.capture?.status).toBe("COMPLETED");
  });
});
