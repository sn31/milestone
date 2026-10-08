import { PayPalClient, createPayPalClient, paypalMode } from "@milestone/money";

let client: PayPalClient | null = null;

/** True when both PAYPAL_PARTNER_CLIENT_ID and PAYPAL_PARTNER_CLIENT_SECRET are set. */
export function hasPartnerCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.PAYPAL_PARTNER_CLIENT_ID && !!env.PAYPAL_PARTNER_CLIENT_SECRET;
}

/**
 * The capital partner's own PayPal app (PAYPAL_PARTNER_CLIENT_ID / PAYPAL_PARTNER_CLIENT_SECRET): advances are paid
 * out of the partner's account. In simulated mode (PAYPAL_MODE=simulated, or no PAYPAL_CLIENT_ID outside production)
 * it is the simulator's partner account (createPayPalClient with the PAYPAL_PARTNER_ prefix), so the local simulator
 * runs the whole advance flow without credentials. In sandbox or live mode without partner credentials it throws: an
 * advance is never paid from the platform's account.
 */
export function partnerPaypal(env: NodeJS.ProcessEnv = process.env): PayPalClient {
  if (paypalMode(env) !== "simulated" && !hasPartnerCredentials(env)) {
    throw new Error("PAYPAL_PARTNER_CLIENT_ID and PAYPAL_PARTNER_CLIENT_SECRET are required outside simulated mode; advances are never paid from the platform account");
  }
  client ??= createPayPalClient(env, "PAYPAL_PARTNER_");
  return client;
}
