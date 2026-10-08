/**
 * Money-moving calls. Importable ONLY from packages/policy (enforced by scripts/check-boundaries.mjs).
 * Every function requires a requestId that was persisted first.
 */
import { toPayPalValue } from "@milestone/core";
import type { PayPalClient } from "./client.js";
import type { Order } from "./orders.js";

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
export function createPayout(client: PayPalClient, input: { requestId: string; senderBatchId: string; items: PayoutItemInput[]; emailSubject?: string }): Promise<PayoutBatch> {
  return client.request<PayoutBatch>(
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
