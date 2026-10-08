/**
 * Money-moving calls. Importable ONLY from policy/execute.ts (enforced by scripts/check-boundaries.mjs).
 * Every function requires a requestId that was persisted first.
 */
import { toPayPalValue } from "@milestone/core";
import { PayPalError, type PayPalClient } from "./client.ts";
import type { Order } from "./orders.ts";

export interface Capture {
  id: string;
  status: string;
  amount: { value: string; currency_code: string };
}

export async function captureOrder(client: PayPalClient, orderId: string, requestId: string): Promise<{ order: Order; capture: Capture }> {
  const order = await client.request<Order>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, { requestId });
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (!capture) throw new Error(`order ${orderId} captured without a capture id`);
  return { order, capture: capture as Capture };
}

export interface PayoutItemInput {
  receiverEmail: string;
  amountMinor: number;
  currency: string;
  note: string;
  senderItemId: string;
}
export interface PayoutBatch {
  batch_header: { payout_batch_id: string; batch_status: string; sender_batch_header: { sender_batch_id: string } };
}

/** Release and advances: POST /v1/payments/payouts */
/**
 * Release and advances: POST /v1/payments/payouts.
 * Learned from the sandbox on Oct 9: PayPal does NOT replay a payout for a repeated PayPal-Request-Id. It answers
 * 400 USER_BUSINESS_ERROR "Batch with given sender_batch_id already exists" with a link to the existing batch.
 * That still means "never paid twice", so a retry recovers that batch and returns it as the result.
 */
export async function createPayout(client: PayPalClient, input: { requestId: string; senderBatchId: string; items: PayoutItemInput[]; emailSubject?: string }): Promise<PayoutBatch> {
  try {
    return await client.request<PayoutBatch>(
      "POST",
      "/v1/payments/payouts",
      {
        sender_batch_header: { sender_batch_id: input.senderBatchId, email_subject: input.emailSubject ?? "You have been paid by Milestone" },
        items: input.items.map((i) => ({
          recipient_type: "EMAIL",
          receiver: i.receiverEmail,
          amount: { value: toPayPalValue(i.amountMinor, i.currency), currency: i.currency },
          note: i.note,
          sender_item_id: i.senderItemId,
        })),
      },
      { requestId: input.requestId },
    );
  } catch (err) {
    const existing = existingBatchId(err);
    if (!existing) throw err;
    return getPayoutBatch(client, existing);
  }
}

/** The batch id PayPal points at when a sender_batch_id was already used, or null for any other error. */
export function existingBatchId(err: unknown): string | null {
  if (!(err instanceof PayPalError) || err.status !== 400) return null;
  const body = err.body as { name?: string; details?: Array<{ field?: string; issue?: string; link?: Array<{ href?: string }> }> } | null;
  const detail = body?.details?.find((d) => d.field === "SENDER_BATCH_ID" && /already exists/i.test(d.issue ?? ""));
  if (!detail) return null;
  const href = detail.link?.[0]?.href ?? "";
  const m = /\/v1\/payments\/payouts\/([A-Z0-9]+)/i.exec(href);
  return m?.[1] ?? null;
}

export function getPayoutBatch(client: PayPalClient, batchId: string) {
  return client.request<PayoutBatch & { items?: Array<{ payout_item_id: string; transaction_status: string }> }>("GET", `/v1/payments/payouts/${batchId}`);
}

export function refundCapture(client: PayPalClient, captureId: string, input: { amountMinor: number; currency: string; requestId: string; note?: string }) {
  const opts = { requestId: input.requestId };
  return client.request<{ id: string; status: string }>(
    "POST",
    `/v2/payments/captures/${captureId}/refund`,
    { amount: { value: toPayPalValue(input.amountMinor, input.currency), currency_code: input.currency }, note_to_payer: input.note ?? "Partial release" },
    opts,
  );
}

/**
 * Disputes: POST /v1/customer/disputes/{id}/accept-claim. The seller accepts liability and PayPal refunds the buyer from
 * the platform account, so it moves money and lives here (reachable only through policy/execute.ts).
 */
export function acceptClaim(client: PayPalClient, disputeId: string, input: { note: string; requestId: string }) {
  return client.request<{ links?: unknown[] }>(
    "POST",
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`,
    { note: input.note.slice(0, 2000), accept_claim_type: "REFUND" },
    { requestId: input.requestId },
  );
}
