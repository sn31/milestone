/**
 * Simulated PayPal: a fetchImpl for PayPalClient that answers the REST calls Milestone makes with sandbox-shaped JSON,
 * so the whole loop (fund -> verify -> release -> settle) runs locally and as a demo-day backup.
 *
 * - PAYPAL_MODE=simulated turns it on; unset, it is the default when PAYPAL_CLIENT_ID is empty and NODE_ENV is not
 *   production. createPayPalClient() picks the simulated or the real client (./mode.ts).
 * - Idempotent on PayPal-Request-Id like PayPal: the same id on the same endpoint replays the first 2xx response
 *   (errors are not remembered, so a capture refused before approval succeeds later with the same id).
 * - State (./sim/store.ts) is persisted to var/simulated-paypal.json (repo root) so web and worker share it.
 * - Disputes: openSimulatedDispute (POST /api/disputes/dev) opens one against a capture and emits
 *   CUSTOMER.DISPUTE.CREATED; provide-evidence (multipart) puts it under review and emits CUSTOMER.DISPUTE.RESOLVED in
 *   the seller's favour ~2 s later; accept-claim resolves it in the buyer's favour.
 * - Captures, payouts and refunds emit the matching webhook events to APP_URL/api/webhooks/paypal after ~1.5 s with
 *   header X-Milestone-Simulated: <SIMULATED_WEBHOOK_SECRET or "dev">. The webhook route accepts that header instead of
 *   PayPal's signature only in simulated mode (see isSimulatedWebhook).
 *
 * - Vault (Payment Method Tokens v3): setup tokens (approve link -> /api/dev/paypal/vault-approve?token=...), payment
 *   tokens, delete, and orders with payment_source.paypal.vault_id, which complete at once with a capture and send
 *   PAYMENT.CAPTURE.COMPLETED. armSimulatedVaultCharge makes the next charge PENDING or DECLINED.
 *
 * No money moves here; nothing in this file is reachable from the browser. This module re-exports the pieces.
 */
export { paypalMode, createPayPalClient, createSimulatedPayPalClient, isSimulatedWebhook, simulatedWebhookSecret, SIMULATED_WEBHOOK_HEADER } from "./mode.ts";
export type { PayPalMode } from "./mode.ts";
export { configureSimulator, resetSimulator } from "./sim/store.ts";
export type { SimulatorOptions } from "./sim/store.ts";
export { simulatedFetch, approveSimulatedOrder, simulatedOrder, failNextSimulatedPayout, armedSimulatedFailures, openSimulatedDispute, approveSimulatedSetupToken, simulatedSetupToken, armSimulatedVaultCharge, SHOWCASE_VAULT_PREFIX } from "./sim/handlers.ts";
export type { SimulatedDispute } from "./sim/handlers.ts";
export type { SimulatedOrderSummary, SimulatedSetupTokenSummary } from "./sim/views.ts";
