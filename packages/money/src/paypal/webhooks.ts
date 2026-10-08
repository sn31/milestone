import type { PayPalClient } from "./client.js";

export interface WebhookEvent {
  id: string;
  event_type: string;
  create_time: string;
  resource_type?: string;
  resource?: Record<string, unknown>;
}

/** Checks the signature with PayPal before anything reads the event. */
export async function verifyWebhookSignature(client: PayPalClient, headers: Headers | Record<string, string | undefined>, rawBody: string, webhookId: string): Promise<boolean> {
  const h = (name: string) => (headers instanceof Headers ? headers.get(name) : headers[name] ?? headers[name.toLowerCase()]) ?? "";
  const res = await client.request<{ verification_status: "SUCCESS" | "FAILURE" }>("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: h("paypal-auth-algo"),
    cert_url: h("paypal-cert-url"),
    transmission_id: h("paypal-transmission-id"),
    transmission_sig: h("paypal-transmission-sig"),
    transmission_time: h("paypal-transmission-time"),
    webhook_id: webhookId,
    webhook_event: JSON.parse(rawBody),
  });
  return res.verification_status === "SUCCESS";
}
