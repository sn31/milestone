import { toPayPalValue } from "@milestone/core";
import type { PayPalClient } from "./client.js";

export interface ReceiptInput {
  requestId: string;
  invoiceNumber: string;
  freelancerEmail: string;
  clientEmail: string;
  currency: string;
  amountMinor: number;
  description: string;
}

/** Every release produces a paid invoice for the freelancer's records: create, send, record payment. */
export async function issuePaidReceipt(client: PayPalClient, r: ReceiptInput) {
  const created = await client.request<{ href?: string; id?: string }>(
    "POST",
    "/v2/invoicing/invoices",
    {
      detail: { invoice_number: r.invoiceNumber, currency_code: r.currency, note: "Paid on verified delivery via Milestone" },
      invoicer: { email_address: r.freelancerEmail },
      primary_recipients: [{ billing_info: { email_address: r.clientEmail } }],
      items: [{ name: r.description, quantity: "1", unit_amount: { currency_code: r.currency, value: toPayPalValue(r.amountMinor, r.currency) } }],
    },
    { requestId: r.requestId },
  );
  const id = created.id ?? created.href?.split("/").pop();
  if (!id) throw new Error("invoice created without an id");
  await client.request("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true }, { requestId: `${r.requestId}:send` });
  await client.request(
    "POST",
    `/v2/invoicing/invoices/${id}/payments`,
    { method: "OTHER", note: "Settled by PayPal payout", amount: { currency_code: r.currency, value: toPayPalValue(r.amountMinor, r.currency) } },
    { requestId: `${r.requestId}:pay` },
  );
  return { invoiceId: id };
}
