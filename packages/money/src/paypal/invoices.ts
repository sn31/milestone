import { toPayPalValue } from "@milestone/core";
import type { PayPalClient } from "./client.ts";

export interface ReceiptInput {
  requestId: string;
  invoiceNumber: string;
  /** Shown in the item name only; never the invoicer (PayPal rejects an invoicer that is not the calling account). */
  freelancerName: string;
  /** The platform's own PayPal email; omitted means PayPal uses the calling account. */
  platformEmail?: string;
  /** Payout batch that paid the freelancer, quoted in the note. */
  payoutBatchId?: string;
  milestoneLabel: string;
  clientEmail: string;
  currency: string;
  amountMinor: number;
  description: string;
}

/** Every release produces a paid invoice for the freelancer's records: create, send, record payment. */
export async function issuePaidReceipt(client: PayPalClient, r: ReceiptInput): Promise<{ invoiceId: string; invoiceUrl?: string }> {
  const note = `Paid on verified delivery via Milestone${r.payoutBatchId ? `. Payout batch ${r.payoutBatchId}` : ""}.`;
  const created = await client.request<{ href?: string; id?: string }>(
    "POST",
    "/v2/invoicing/invoices",
    {
      detail: { invoice_number: r.invoiceNumber, currency_code: r.currency, note },
      ...(r.platformEmail ? { invoicer: { email_address: r.platformEmail } } : {}),
      primary_recipients: [{ billing_info: { email_address: r.clientEmail } }],
      items: [{ name: `${r.milestoneLabel} · delivered by ${r.freelancerName}`, description: r.description, quantity: "1", unit_amount: { currency_code: r.currency, value: toPayPalValue(r.amountMinor, r.currency) } }],
    },
    { requestId: r.requestId },
  );
  const id = created.id ?? created.href?.split("/").pop();
  if (!id) throw new Error("invoice created without an id");
  const sent = await client.request<{ href?: string } | undefined>("POST", `/v2/invoicing/invoices/${id}/send`, { send_to_recipient: true }, { requestId: `${r.requestId}:send` });
  await client.request(
    "POST",
    `/v2/invoicing/invoices/${id}/payments`,
    { method: "OTHER", note: "Settled by PayPal payout", amount: { currency_code: r.currency, value: toPayPalValue(r.amountMinor, r.currency) } },
    { requestId: `${r.requestId}:pay` },
  );
  const invoiceUrl = sent?.href;
  return invoiceUrl ? { invoiceId: id, invoiceUrl } : { invoiceId: id };
}
