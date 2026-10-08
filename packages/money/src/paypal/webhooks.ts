import { asRecord as obj, asString as str, type PayoutParty } from "@milestone/core";
import type { PayPalClient } from "./client.ts";

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

// ---------- Event bodies (read after the signature check and the event_id de-duplication) ----------

export interface PayoutItemEvent {
  senderItemId?: string;
  /** Set only for release items, whose sender_item_id is "<milestoneId>:<party>" (see executeRelease). */
  milestoneId?: string;
  party?: PayoutParty;
  payoutBatchId?: string;
  payoutItemId?: string;
  transactionStatus?: string;
  reason?: string;
  /** payout_item.amount as PayPal sent it (decimal string) and its currency. */
  amountValue?: string;
  currency?: string;
}

/** Reads a PAYMENT.PAYOUTS-ITEM.* event body. Advance-funding payouts (sender_item_id = advance id) come back without a party. */
export function parsePayoutItemEvent(payload: unknown): PayoutItemEvent {
  const resource = obj(obj(payload).resource);
  const item = obj(resource.payout_item);
  const senderItemId = str(item.sender_item_id) ?? str(resource.sender_item_id);
  const errors = obj(resource.errors);
  const out: PayoutItemEvent = {};
  if (senderItemId) {
    out.senderItemId = senderItemId;
    const [milestoneId, party, ...rest] = senderItemId.split(":");
    if (milestoneId && rest.length === 0 && (party === "partner" || party === "freelancer")) {
      out.milestoneId = milestoneId;
      out.party = party;
    }
  }
  const batch = str(resource.payout_batch_id);
  if (batch) out.payoutBatchId = batch;
  const itemId = str(resource.payout_item_id);
  if (itemId) out.payoutItemId = itemId;
  const status = str(resource.transaction_status);
  if (status) out.transactionStatus = status;
  const reason = str(errors.message) ?? str(errors.name) ?? status;
  if (reason) out.reason = reason;
  const amount = obj(item.amount);
  const value = str(amount.value);
  if (value) out.amountValue = value;
  const currency = str(amount.currency) ?? str(amount.currency_code);
  if (currency) out.currency = currency;
  return out;
}

export interface RefundEvent {
  refundId?: string;
  /** From the refund's "up" link (/v2/payments/captures/{id}). */
  captureId?: string;
  status?: string;
  amountValue?: string;
  currency?: string;
}

/** Reads a PAYMENT.CAPTURE.REFUNDED event body (resource = the refund). */
export function parseRefundEvent(payload: unknown): RefundEvent {
  const resource = obj(obj(payload).resource);
  const out: RefundEvent = {};
  const id = str(resource.id);
  if (id) out.refundId = id;
  const status = str(resource.status);
  if (status) out.status = status;
  const amount = obj(resource.amount);
  const value = str(amount.value);
  if (value) out.amountValue = value;
  const currency = str(amount.currency_code) ?? str(amount.currency);
  if (currency) out.currency = currency;
  const links = Array.isArray(resource.links) ? resource.links : [];
  for (const l of links) {
    const link = obj(l);
    const m = link.rel === "up" ? /\/captures\/([^/?#]+)/.exec(str(link.href) ?? "") : null;
    if (m?.[1]) out.captureId = m[1];
  }
  return out;
}

export interface PayoutBatchEvent {
  payoutBatchId?: string;
  /** Our payout op's PayPal-Request-Id (executeRelease sends it as sender_batch_id). */
  senderBatchId?: string;
  batchStatus?: string;
}

/** Reads a PAYMENT.PAYOUTSBATCH.* event body (resource = the batch). */
export function parsePayoutBatchEvent(payload: unknown): PayoutBatchEvent {
  const header = obj(obj(obj(payload).resource).batch_header);
  const out: PayoutBatchEvent = {};
  const batch = str(header.payout_batch_id);
  if (batch) out.payoutBatchId = batch;
  const sender = str(obj(header.sender_batch_header).sender_batch_id);
  if (sender) out.senderBatchId = sender;
  const status = str(header.batch_status);
  if (status) out.batchStatus = status;
  return out;
}
