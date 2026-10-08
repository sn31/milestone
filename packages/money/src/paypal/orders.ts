import { toPayPalValue } from "@milestone/core";
import type { PayPalClient } from "./client.ts";

export interface CreateOrderInput {
  amountMinor: number;
  currency: string;
  /** Your milestone id; comes back as purchase_units[0].reference_id */
  referenceId: string;
  description?: string;
  returnUrl: string;
  cancelUrl: string;
  /** Idempotency; orders are not money moves but a duplicate order is still noise. */
  requestId?: string;
}

export interface Order {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  links?: Array<{ href: string; rel: string; method: string }>;
  purchase_units?: Array<{
    reference_id?: string;
    payments?: { captures?: Array<{ id: string; status: string; amount: { value: string; currency_code: string } }> };
  }>;
}

export async function createOrder(client: PayPalClient, input: CreateOrderInput): Promise<Order> {
  const unit: Record<string, unknown> = {
    reference_id: input.referenceId,
    description: input.description ?? "Milestone payment on verified delivery",
    amount: { currency_code: input.currency, value: toPayPalValue(input.amountMinor, input.currency) },
  };
  const body = {
    intent: "CAPTURE",
    purchase_units: [unit],
    payment_source: {
      paypal: {
        experience_context: {
          user_action: "PAY_NOW",
          return_url: input.returnUrl,
          cancel_url: input.cancelUrl,
          shipping_preference: "NO_SHIPPING",
        },
      },
    },
  };
  const opts: { requestId?: string } = {};
  if (input.requestId) opts.requestId = input.requestId;
  return client.request<Order>("POST", "/v2/checkout/orders", body, opts);
}

export function getOrder(client: PayPalClient, orderId: string): Promise<Order> {
  return client.request<Order>("GET", `/v2/checkout/orders/${orderId}`);
}

/** Buyer-facing approval link, for the spike script and for tests. */
export function approveLink(order: Order): string | undefined {
  return order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
}
