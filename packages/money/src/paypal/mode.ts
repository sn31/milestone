/**
 * Which PayPal this process talks to. PAYPAL_MODE=simulated (the default without credentials outside production)
 * answers from the local simulator in ./sim; otherwise the real REST client. Also the check the webhook route uses to
 * accept a simulated event instead of PayPal's signature.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { paypalMode } from "@milestone/core";
import { PayPalClient } from "./client.ts";
import { simulatedFetch } from "./sim/handlers.ts";
import { SIMULATED_WEBHOOK_HEADER, simulatedWebhookSecret } from "./sim/store.ts";

export { paypalMode, SIMULATED_WEBHOOK_HEADER, simulatedWebhookSecret };
export type { PayPalMode } from "@milestone/core";

/** The PayPal client for this process: the simulator in simulated mode, otherwise PayPalClient.fromEnv. */
export function createPayPalClient(env: NodeJS.ProcessEnv = process.env, prefix = "PAYPAL_"): PayPalClient {
  if (paypalMode(env) === "simulated") return createSimulatedPayPalClient(prefix === "PAYPAL_" ? "platform" : prefix.toLowerCase());
  return PayPalClient.fromEnv(env, prefix);
}

export function createSimulatedPayPalClient(account = "platform"): PayPalClient {
  return new PayPalClient({ clientId: `SIM-${account}`, clientSecret: "SIM-secret", env: "sandbox", fetchImpl: simulatedFetch });
}

/** True only in simulated mode and only when X-Milestone-Simulated carries the secret (constant-time compare). */
export function isSimulatedWebhook(headers: Headers | Record<string, string | undefined>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (paypalMode(env) !== "simulated") return false;
  const secret = simulatedWebhookSecret(env);
  if (!secret) return false;
  const got = headers instanceof Headers ? headers.get(SIMULATED_WEBHOOK_HEADER) : (headers[SIMULATED_WEBHOOK_HEADER] ?? headers[SIMULATED_WEBHOOK_HEADER.toLowerCase()]);
  if (!got) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
