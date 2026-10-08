import { describe, expect, it } from "vitest";
import { hasPartnerCredentials, partnerPaypal } from "../src/lib/partner-paypal.ts";

describe("partner PayPal client", () => {
  it("needs both the partner id and secret", () => {
    expect(hasPartnerCredentials({ PAYPAL_PARTNER_CLIENT_ID: "id" })).toBe(false);
    expect(hasPartnerCredentials({ PAYPAL_PARTNER_CLIENT_SECRET: "s" })).toBe(false);
    expect(hasPartnerCredentials({ PAYPAL_PARTNER_CLIENT_ID: "id", PAYPAL_PARTNER_CLIENT_SECRET: "s" })).toBe(true);
  });

  it("never falls back to the platform account in sandbox or live mode", () => {
    expect(() => partnerPaypal({ PAYPAL_MODE: "sandbox", PAYPAL_CLIENT_ID: "platform", PAYPAL_CLIENT_SECRET: "x" })).toThrow(/PAYPAL_PARTNER_CLIENT_ID/);
    expect(() => partnerPaypal({ PAYPAL_CLIENT_ID: "platform", PAYPAL_CLIENT_SECRET: "x", PAYPAL_PARTNER_CLIENT_ID: "id" })).toThrow(/never paid from the platform/);
    expect(() => partnerPaypal({ NODE_ENV: "production" })).toThrow(/PAYPAL_PARTNER_CLIENT_ID/);
  });

  it("uses the partner's own app when both credentials are set", () => {
    expect(partnerPaypal({ PAYPAL_MODE: "sandbox", PAYPAL_PARTNER_CLIENT_ID: "id", PAYPAL_PARTNER_CLIENT_SECRET: "s" })).toBeDefined();
  });
});
