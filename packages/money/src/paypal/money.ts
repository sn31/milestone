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
 * PayPal's sandbox does NOT replay a payout for a repeated PayPal-Request-Id. It answers
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

export interface VaultChargeInput {
  /** From the milestone's vault_charge op, claimed before this call. */
  requestId: string;
  /** The saved PayPal's payment token id. */
  vaultId: string;
  /** Becomes purchase_units[0].reference_id. */
  milestoneId: string;
  amountMinor: number;
  currency: string;
  description?: string;
}

/**
 * Funds a milestone from the client's saved PayPal: POST /v2/checkout/orders with intent CAPTURE and
 * payment_source.paypal.vault_id, no buyer interaction. PayPal answers COMPLETED with the capture in the same response
 * (asked for with Prefer: return=representation). The capture may itself be PENDING (not funded yet: the
 * PAYMENT.CAPTURE.COMPLETED webhook finishes it). capture is null when PayPal created the order without capturing
 * (e.g. PAYER_ACTION_REQUIRED): nothing moved.
 */
export async function chargeVault(client: PayPalClient, input: VaultChargeInput): Promise<{ order: Order; capture: Capture | null }> {
  if (!input.requestId) throw new Error("PayPal-Request-Id is required for a vault charge");
  if (!input.vaultId) throw new Error("vault_id is required");
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new Error(`bad vault charge amount ${input.amountMinor}`);
  const order = await client.request<Order>(
    "POST",
    "/v2/checkout/orders",
    {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: input.milestoneId,
          // Also on the capture resource of PAYMENT.CAPTURE.* webhooks (reference_id is not), so a webhook can find the
          // milestone even when this call's answer was lost.
          custom_id: input.milestoneId,
          description: input.description ?? "Milestone escrow funding",
          amount: { currency_code: input.currency, value: toPayPalValue(input.amountMinor, input.currency) },
        },
      ],
      payment_source: { paypal: { vault_id: input.vaultId } },
    },
    { requestId: input.requestId, headers: { Prefer: "return=representation" } },
  );
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  return { order, capture: capture ? (capture as Capture) : null };
}
