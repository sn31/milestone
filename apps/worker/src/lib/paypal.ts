import { PayPalClient } from "@milestone/money";

let client: PayPalClient | null = null;
export function paypal(): PayPalClient {
  client ??= PayPalClient.fromEnv();
  return client;
}
