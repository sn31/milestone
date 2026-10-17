/** Sandbox-shaped JSON views of the simulator's records, its id formats and the webhook event envelope. Pure reads. */
import { randomBytes } from "node:crypto";
import { asRecord, fromPayPalValue, toPayPalValue } from "@milestone/core";
import type { WebhookEvent } from "../webhooks.ts";
import { appUrl, get, type Amount, type BatchRec, type CaptureRec, type DisputeRec, type InvoiceRec, type OrderRec, type PaymentTokenRec, type PayoutItemRec, type RefundRec, type SetupTokenRec } from "./store.ts";

// ---------- Ids ----------

const ALNUM = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export function code(n: number): string {
  const bytes = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALNUM[(bytes[i] ?? 0) % ALNUM.length];
  return s;
}
export const ids = {
  order: () => `SIM-${code(17)}`,
  capture: () => `SIM-${code(17)}`,
  refund: () => `SIM-${code(17)}`,
  batch: () => `SIM-${code(13)}`,
  item: () => `SIM-${code(13)}`,
  txn: () => `SIM-${code(17)}`,
  invoice: () => `SIM-INV2-${code(4)}-${code(4)}-${code(4)}-${code(4)}`,
  payment: () => `SIM-EXTR-${code(17)}`,
  event: () => `SIM-WH-${code(17)}-${code(17)}`,
  dispute: () => `PP-D-SIM${code(8)}`,
  debug: () => `sim${randomBytes(6).toString("hex")}`,
  token: (kind: string) => `SIM-${kind}-${randomBytes(24).toString("base64url")}`,
  setupToken: () => `SIM-SETUP-${code(12)}`,
  paymentToken: () => `SIM-PMT-${code(12)}`,
  customer: () => `SIM-CUST-${code(10)}`,
  payer: () => `SIMPAYER${code(5)}`,
};

// ---------- Views ----------

export const API = "https://api-m.sandbox.paypal.com";
export const MERCHANT = { email_address: "sb-sim-merchant@business.example.com", merchant_id: "SIMMERCHANT01" };
export const PAYER = {
  name: { given_name: "Sim", surname: "Client" },
  email_address: "sb-sim-client@personal.example.com",
  payer_id: "SIMPAYER0001",
  address: { country_code: "US" },
};

export const iso = (now: number) => new Date(now).toISOString();

export function minor(a: Amount): number {
  return fromPayPalValue(a.value, a.currency_code);
}
export function amount(minorUnits: number, currency: string): Amount {
  return { currency_code: currency, value: toPayPalValue(minorUnits, currency) };
}
function feeMinor(grossMinor: number): number {
  return Math.round(grossMinor * 0.0349);
}

export function captureView(c: CaptureRec, withOrder = false, now = Date.now()): Record<string, unknown> {
  const gross = minor(c.amount);
  const fee = feeMinor(gross);
  const pending = c.pendingUntil !== undefined && now < c.pendingUntil;
  const status = pending ? "PENDING" : c.refundedMinor === 0 ? "COMPLETED" : c.refundedMinor >= gross ? "REFUNDED" : "PARTIALLY_REFUNDED";
  return {
    id: c.id,
    status,
    ...(pending ? { status_details: { reason: "PENDING_REVIEW" } } : {}),
    amount: c.amount,
    final_capture: true,
    seller_protection: { status: "ELIGIBLE", dispute_categories: ["ITEM_NOT_RECEIVED", "UNAUTHORIZED_TRANSACTION"] },
    seller_receivable_breakdown: {
      gross_amount: c.amount,
      paypal_fee: amount(fee, c.amount.currency_code),
      net_amount: amount(gross - fee, c.amount.currency_code),
    },
    ...(withOrder ? { supplementary_data: { related_ids: { order_id: c.orderId } } } : {}),
    links: [
      { href: `${API}/v2/payments/captures/${c.id}`, rel: "self", method: "GET" },
      { href: `${API}/v2/payments/captures/${c.id}/refund`, rel: "refund", method: "POST" },
      { href: `${API}/v2/checkout/orders/${c.orderId}`, rel: "up", method: "GET" },
    ],
    create_time: c.createTime,
    update_time: c.updateTime,
  };
}

export function orderView(o: OrderRec): Record<string, unknown> {
  const capture = o.captureId ? get("capture", o.captureId) : undefined;
  const self = `${API}/v2/checkout/orders/${o.id}`;
  const links =
    o.status === "CREATED"
      ? [
          { href: self, rel: "self", method: "GET" },
          { href: `${appUrl()}/api/dev/paypal/approve?order=${encodeURIComponent(o.id)}`, rel: "approve", method: "GET" },
          { href: self, rel: "update", method: "PATCH" },
          { href: `${self}/capture`, rel: "capture", method: "POST" },
        ]
      : o.status === "APPROVED"
        ? [
            { href: self, rel: "self", method: "GET" },
            { href: self, rel: "update", method: "PATCH" },
            { href: `${self}/capture`, rel: "capture", method: "POST" },
          ]
        : [{ href: self, rel: "self", method: "GET" }];
  return {
    id: o.id,
    intent: o.intent,
    status: o.status,
    ...(o.status !== "CREATED" ? { payment_source: { paypal: paypalSource(o) } } : {}),
    purchase_units: o.units.map((u, i) => ({
      reference_id: u.reference_id,
      ...(u.description ? { description: u.description } : {}),
      ...(u.custom_id ? { custom_id: u.custom_id } : {}),
      amount: u.amount,
      payee: MERCHANT,
      ...(i === 0 && capture ? { payments: { captures: [captureView(capture)] } } : {}),
    })),
    ...(o.status !== "CREATED" ? { payer: PAYER } : {}),
    create_time: o.createTime,
    ...(o.status !== "CREATED" ? { update_time: o.updateTime } : {}),
    links,
  };
}

/** payment_source.paypal of an approved / completed order; a vault order names its token and customer. */
function paypalSource(o: OrderRec): Record<string, unknown> {
  const token = o.vaultId ? get("payment_token", o.vaultId) : undefined;
  return {
    email_address: token?.payerEmail ?? PAYER.email_address,
    account_id: token?.payerId ?? PAYER.payer_id,
    account_status: "VERIFIED",
    name: PAYER.name,
    address: PAYER.address,
    ...(o.vaultId ? { attributes: { vault: { id: o.vaultId, status: "VAULTED", ...(token ? { customer: { id: token.customerId } } : {}) } } } : {}),
  };
}

export function refundView(r: RefundRec): Record<string, unknown> {
  const gross = minor(r.amount);
  const fee = feeMinor(gross);
  return {
    id: r.id,
    amount: r.amount,
    ...(r.note ? { note_to_payer: r.note } : {}),
    seller_payable_breakdown: {
      gross_amount: r.amount,
      paypal_fee: amount(fee, r.amount.currency_code),
      net_amount: amount(gross - fee, r.amount.currency_code),
      total_refunded_amount: r.amount,
    },
    status: "COMPLETED",
    create_time: r.createTime,
    update_time: r.createTime,
    links: [
      { href: `${API}/v2/payments/refunds/${r.id}`, rel: "self", method: "GET" },
      { href: `${API}/v2/payments/captures/${r.captureId}`, rel: "up", method: "GET" },
    ],
  };
}

export function itemView(b: BatchRec, it: PayoutItemRec, now: number): Record<string, unknown> {
  const settled = now >= b.settleAt;
  const status = settled ? it.outcome : "PENDING";
  return {
    payout_item_id: it.payout_item_id,
    ...(settled && it.outcome === "SUCCESS" ? { transaction_id: it.transaction_id } : {}),
    activity_id: it.transaction_id,
    transaction_status: status,
    payout_item_fee: { currency: it.payout_item.amount.currency, value: toPayPalValue(0, it.payout_item.amount.currency) },
    payout_batch_id: b.id,
    sender_batch_id: b.sender_batch_header.sender_batch_id,
    payout_item: { ...it.payout_item, recipient_wallet: "PAYPAL" },
    ...(settled ? { time_processed: new Date(b.settleAt).toISOString() } : {}),
    ...(settled && it.failure ? { errors: { ...it.failure, information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors", details: [] } } : {}),
    links: [{ href: `${API}/v1/payments/payouts-item/${it.payout_item_id}`, rel: "item", method: "GET", encType: "application/json" }],
  };
}

export function batchView(b: BatchRec, now: number): Record<string, unknown> {
  const settled = now >= b.settleAt;
  const currency = b.items[0]?.payout_item.amount.currency ?? "USD";
  const total = b.items.reduce((s, i) => s + fromPayPalValue(i.payout_item.amount.value, currency), 0);
  return {
    batch_header: {
      payout_batch_id: b.id,
      batch_status: settled ? "SUCCESS" : "PENDING",
      time_created: b.createTime,
      ...(settled ? { time_completed: new Date(b.settleAt).toISOString(), time_closed: new Date(b.settleAt).toISOString() } : {}),
      sender_batch_header: b.sender_batch_header,
      funding_source: "BALANCE",
      amount: { currency, value: toPayPalValue(total, currency) },
      fees: { currency, value: toPayPalValue(0, currency) },
    },
    items: b.items.map((i) => itemView(b, i, now)),
    total_items: b.items.length,
    total_page: 1,
    links: [{ href: `${API}/v1/payments/payouts/${b.id}?page_size=1000&page=1`, rel: "self", method: "GET", encType: "application/json" }],
  };
}

export function event(eventType: string, resourceType: string, summary: string, resource: Record<string, unknown>): WebhookEvent & Record<string, unknown> {
  const id = ids.event();
  return {
    id,
    event_version: "1.0",
    create_time: new Date().toISOString(),
    resource_type: resourceType,
    resource_version: resourceType === "payouts_item" ? "1.0" : "2.0",
    event_type: eventType,
    summary,
    resource,
    links: [
      { href: `${API}/v1/notifications/webhooks-events/${id}`, rel: "self", method: "GET" },
      { href: `${API}/v1/notifications/webhooks-events/${id}/resend`, rel: "resend", method: "POST" },
    ],
  };
}

export function invoiceView(inv: InvoiceRec): Record<string, unknown> {
  return {
    id: inv.id,
    status: inv.status,
    ...inv.body,
    detail: { ...asRecord(inv.body.detail), invoice_number: inv.number },
    ...(inv.payments.length ? { payments: { transactions: inv.payments } } : {}),
    links: [{ href: `${API}/v2/invoicing/invoices/${inv.id}`, rel: "self", method: "GET" }],
  };
}

// ---------- Disputes ----------

/** True once a provide-evidence or accept-claim decision has taken effect. */
export function isResolved(d: DisputeRec, now: number): boolean {
  return d.resolveAt !== undefined && now >= d.resolveAt;
}

export function disputeView(d: DisputeRec, now: number): Record<string, unknown> {
  const resolved = isResolved(d, now);
  const status = resolved ? "RESOLVED" : d.reviewing ? "UNDER_REVIEW" : "WAITING_FOR_SELLER_RESPONSE";
  const self = `${API}/v1/customer/disputes/${d.id}`;
  return {
    dispute_id: d.id,
    create_time: d.createTime,
    update_time: resolved && d.resolveAt !== undefined ? iso(d.resolveAt) : d.updateTime,
    disputed_transactions: [
      {
        seller_transaction_id: d.captureId,
        buyer_transaction_id: `SIM-BUY-${d.captureId.replace(/^SIM-/, "").slice(0, 13)}`,
        transaction_status: "COMPLETED",
        gross_amount: d.amount,
        seller: { merchant_id: MERCHANT.merchant_id, name: "Milestone Platform" },
        buyer: { name: `${PAYER.name.given_name} ${PAYER.name.surname}` },
        items: [],
      },
    ],
    reason: d.reason,
    status,
    dispute_state: resolved ? "RESOLVED" : d.reviewing ? "UNDER_PAYPAL_REVIEW" : "REQUIRED_ACTION",
    dispute_amount: d.amount,
    ...(resolved && d.outcome ? { dispute_outcome: { outcome_code: d.outcome, ...(d.outcome === "RESOLVED_BUYER_FAVOUR" ? { amount_refunded: d.amount } : {}) } } : {}),
    dispute_life_cycle_stage: "CHARGEBACK",
    dispute_channel: "INTERNAL",
    messages: [{ posted_by: "BUYER", time_posted: d.createTime, content: d.buyerNote }],
    ...(d.evidences.length ? { evidences: d.evidences } : {}),
    seller_response_due_date: d.dueDate,
    links: [
      { href: self, rel: "self", method: "GET" },
      ...(status === "WAITING_FOR_SELLER_RESPONSE"
        ? [
            { href: `${self}/provide-evidence`, rel: "provide_evidence", method: "POST" },
            { href: `${self}/accept-claim`, rel: "accept_claim", method: "POST" },
          ]
        : []),
    ],
  };
}

// ---------- Dev controls ----------

export interface SimulatedOrderSummary {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  referenceId: string | null;
  amount: Amount | null;
}

export function summary(o: OrderRec): SimulatedOrderSummary {
  const u = o.units[0];
  return { id: o.id, status: o.status, referenceId: u?.reference_id ?? null, amount: u?.amount ?? null };
}

// ---------- Vault (Payment Method Tokens v3) ----------

export function setupTokenView(t: SetupTokenRec): Record<string, unknown> {
  const self = `${API}/v3/vault/setup-tokens/${t.id}`;
  return {
    id: t.id,
    customer: { id: t.customerId },
    status: t.status,
    payment_source: {
      paypal: {
        ...t.source,
        ...(t.status !== "PAYER_ACTION_REQUIRED" ? { email_address: t.payerEmail ?? PAYER.email_address, payer_id: PAYER.payer_id } : {}),
      },
    },
    links: [
      ...(t.status === "PAYER_ACTION_REQUIRED" ? [{ href: `${appUrl()}/api/dev/paypal/vault-approve?token=${encodeURIComponent(t.id)}`, rel: "approve", method: "GET" }] : []),
      { href: self, rel: "self", method: "GET", encType: "application/json" },
      ...(t.status === "APPROVED" ? [{ href: `${API}/v3/vault/payment-tokens`, rel: "confirm", method: "POST", encType: "application/json" }] : []),
    ],
  };
}

export function paymentTokenView(p: PaymentTokenRec): Record<string, unknown> {
  const self = `${API}/v3/vault/payment-tokens/${p.id}`;
  return {
    id: p.id,
    customer: { id: p.customerId },
    payment_source: {
      paypal: {
        ...p.source,
        email_address: p.payerEmail,
        payer_id: p.payerId,
        name: { full_name: `${PAYER.name.given_name} ${PAYER.name.surname}` },
        address: PAYER.address,
      },
    },
    links: [
      { href: self, rel: "self", method: "GET", encType: "application/json" },
      { href: self, rel: "delete", method: "DELETE", encType: "application/json" },
    ],
  };
}

export interface SimulatedSetupTokenSummary {
  id: string;
  status: SetupTokenRec["status"];
  customerId: string;
  /** Where the payer goes after approving: return_url with approval_token_id (and approval_session_id), as PayPal does. */
  returnUrl: string | null;
  cancelUrl: string | null;
  paymentTokenId: string | null;
}

export function setupSummary(t: SetupTokenRec): SimulatedSetupTokenSummary {
  let returnUrl: string | null = null;
  if (t.returnUrl) {
    try {
      const u = new URL(t.returnUrl);
      u.searchParams.set("approval_token_id", t.id);
      u.searchParams.set("approval_session_id", `SIM-SESSION-${t.id.slice(-8)}`);
      returnUrl = u.toString();
    } catch {
      returnUrl = t.returnUrl;
    }
  }
  return { id: t.id, status: t.status, customerId: t.customerId, returnUrl, cancelUrl: t.cancelUrl ?? null, paymentTokenId: t.paymentTokenId ?? null };
}
