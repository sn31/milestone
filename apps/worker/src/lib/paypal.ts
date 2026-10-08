import { createPayPalClient, type PayPalClient } from "@milestone/money";

/**
 * The process's PayPal client. In simulated mode (PAYPAL_MODE=simulated, or no PAYPAL_CLIENT_ID outside production)
 * this is the local simulator, which shares its state with the other app through var/simulated-paypal.json.
 */
let client: PayPalClient | null = null;
export function paypal(): PayPalClient {
  client ??= createPayPalClient();
  return client;
}
