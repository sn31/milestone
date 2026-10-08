import { PayPalClient, paypalMode } from "@milestone/money";
import { paypal } from "./paypal.ts";

let client: PayPalClient | null = null;

/** True when advances are paid from the partner's own PayPal app rather than the platform's client. */
export function hasPartnerCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.PAYPAL_PARTNER_CLIENT_ID && paypalMode(env) !== "simulated";
}

/**
 * The capital partner's own PayPal app (PAYPAL_PARTNER_CLIENT_ID / PAYPAL_PARTNER_CLIENT_SECRET): advances are paid
 * out of the partner's account. Without partner credentials, or in simulated mode, it is the same client
 * ./paypal.ts exports, so a single sandbox app or the local simulator still runs the whole flow.
 */
export function partnerPaypal(env: NodeJS.ProcessEnv = process.env): PayPalClient {
  if (!hasPartnerCredentials(env)) return paypal();
  client ??= PayPalClient.fromEnv(env, "PAYPAL_PARTNER_");
  return client;
}
