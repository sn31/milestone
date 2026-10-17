/**
 * The simulator's REST surface: a route table over the handlers, the fetch that PayPalClient calls, webhook delivery,
 * and the dev controls behind /api/dev/paypal/* and /api/disputes/dev. Handlers run inside a store transaction and
 * read and write the state synchronously; every in-place change is followed by put(rec) so it is saved.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { asRecord, asString, fromPayPalValue } from "@milestone/core";
import type { WebhookEvent } from "../webhooks.ts";
import { SIMULATED_WEBHOOK_HEADER, appUrl, config, del, get, put, read, records, simulatedWebhookSecret, transact, transactSync, type Amount, type BatchRec, type CaptureRec, type DisputeEvidenceRec, type DisputeRec, type InvoiceRec, type OrderRec, type PaymentTokenRec, type PayoutItemRec, type Rec, type RefundRec, type SetupTokenRec, type VaultSource } from "./store.ts";
import { API, PAYER, amount, batchView, captureView, code, disputeView, event, ids, invoiceView, isResolved, iso, itemView, minor, orderView, paymentTokenView, refundView, setupSummary, setupTokenView, summary, type SimulatedOrderSummary, type SimulatedSetupTokenSummary } from "./views.ts";

// ---------- Requests and results ----------

/** The parsed multipart body of provide-evidence: the "input" JSON part and the file parts. */
interface EvidenceUpload {
  input: Record<string, unknown> | null;
  files: Array<{ field: string; name: string; size: number; type: string; sha256: string }>;
}

interface SimRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Headers;
  now: number;
  upload: EvidenceUpload | null;
  /** The URL's search string (with "?"), for the few GETs that take query parameters. */
  query: string;
}
interface SimResult {
  status: number;
  body: unknown;
  /** Webhook events to send once the state is saved, each after `delayMs` (default the configured delay). */
  events?: Array<{ event: WebhookEvent; delayMs?: number }>;
}

function err(status: number, name: string, message: string, issue?: string): SimResult {
  return {
    status,
    body: {
      name,
      message,
      debug_id: ids.debug(),
      ...(issue ? { details: [{ issue, description: message }], links: [{ href: `https://developer.paypal.com/docs/api/orders/v2/#error-${issue}`, rel: "information_link", method: "GET" }] } : {}),
    },
  };
}

const notFound = (id: string) => err(404, "RESOURCE_NOT_FOUND", `The specified resource ${id} does not exist.`, "INVALID_RESOURCE_ID");

/** Payouts' own 404 shape. */
const payoutNotFound = (): SimResult => ({ status: 404, body: { name: "INVALID_RESOURCE_ID", message: "Requested resource ID was not found.", debug_id: ids.debug() } });

/** Payouts' 400 for a missing field. */
const validationError = (field: string): SimResult => ({
  status: 400,
  body: { name: "VALIDATION_ERROR", message: "Invalid request - see details", debug_id: ids.debug(), details: [{ field, location: "body", issue: "required" }] },
});

/** A GET of one record: its view, or the REST 404. */
function getOr404<K extends Rec["kind"]>(kind: K, id: string, view: (r: Extract<Rec, { kind: K }>) => unknown): SimResult {
  const r = get(kind, id);
  return r ? { status: 200, body: view(r) } : err(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
}

// ---------- Orders, captures, refunds ----------

function createOrder(req: SimRequest): SimResult {
  const body = asRecord(req.body);
  const units = Array.isArray(body.purchase_units) ? body.purchase_units.map(asRecord) : [];
  if (body.intent !== "CAPTURE" && body.intent !== "AUTHORIZE") return err(400, "INVALID_REQUEST", "intent is required", "MISSING_REQUIRED_PARAMETER");
  if (units.length === 0) return err(400, "INVALID_REQUEST", "purchase_units is required", "MISSING_REQUIRED_PARAMETER");
  const parsed: OrderRec["units"] = [];
  for (const [i, u] of units.entries()) {
    const a = asRecord(u.amount);
    const currency = asString(a.currency_code);
    const value = asString(a.value);
    if (!currency || !value || !/^\d+(\.\d{1,2})?$/.test(value)) return err(422, "UNPROCESSABLE_ENTITY", "amount is invalid", "INVALID_PARAMETER_VALUE");
    const unit: OrderRec["units"][number] = { reference_id: asString(u.reference_id) ?? (i === 0 ? "default" : String(i)), amount: { currency_code: currency, value } };
    const description = asString(u.description);
    if (description) unit.description = description;
    const customId = asString(u.custom_id);
    if (customId) unit.custom_id = customId;
    parsed.push(unit);
  }
  const paypal = asRecord(asRecord(body.payment_source).paypal);
  const vaultId = asString(paypal.vault_id);
  if (vaultId) return chargeVault(req, String(body.intent), parsed, vaultId);
  const ctx = asRecord(paypal.experience_context);
  const o: OrderRec = { kind: "order", id: ids.order(), status: "CREATED", intent: String(body.intent), units: parsed, createTime: iso(req.now), updateTime: iso(req.now) };
  const ret = asString(ctx.return_url);
  if (ret) o.returnUrl = ret;
  const cancel = asString(ctx.cancel_url);
  if (cancel) o.cancelUrl = cancel;
  put(o);
  return { status: 201, body: orderView(o) };
}

/**
 * The vault id a seeded showcase payment method uses (pnpm db:seed -- --showcase writes no simulator state). An unknown
 * vault id with this prefix is treated as a saved PayPal the simulator already had, so the showcase can fund from it.
 */
export const SHOWCASE_VAULT_PREFIX = "SIM-PMT-SHOW";

/** The payment token for a vault id: a saved one, or a showcase token adopted on first use. */
function vaultToken(vaultId: string, now: number): PaymentTokenRec | undefined {
  const known = get("payment_token", vaultId);
  if (known || !vaultId.startsWith(SHOWCASE_VAULT_PREFIX)) return known;
  const t: PaymentTokenRec = {
    kind: "payment_token",
    id: vaultId,
    customerId: `SIM-CUST-${vaultId.slice(SHOWCASE_VAULT_PREFIX.length) || "SHOW"}`,
    setupTokenId: "",
    payerEmail: PAYER.email_address,
    payerId: PAYER.payer_id,
    source: { usage_type: "MERCHANT", customer_type: "CONSUMER", usage_pattern: "UNSCHEDULED_POSTPAID", permit_multiple_payment_tokens: false },
    createTime: iso(now),
  };
  put(t);
  return t;
}

/**
 * An order paid from a saved PayPal: no buyer step, so it is created COMPLETED with its capture in the same answer and
 * PAYMENT.CAPTURE.COMPLETED follows. An armed PENDING outcome holds the capture PENDING for twice the webhook delay
 * (the COMPLETED event fires when it clears); an armed DECLINED outcome refuses with INSTRUMENT_DECLINED and moves nothing.
 */
function chargeVault(req: SimRequest, intent: string, units: OrderRec["units"], vaultId: string): SimResult {
  if (intent !== "CAPTURE") return err(422, "UNPROCESSABLE_ENTITY", "A vaulted PayPal order must have intent CAPTURE.", "INVALID_PARAMETER_VALUE");
  const token = vaultToken(vaultId, req.now);
  if (!token) return err(422, "UNPROCESSABLE_ENTITY", "The specified vault_id does not exist or was deleted.", "INVALID_VAULT_ID");
  const unit = units[0]!;
  const armed = get("vault_arm", vaultId);
  if (armed) del("vault_arm", vaultId);
  if (armed?.outcome === "DECLINED") return err(422, "UNPROCESSABLE_ENTITY", "The instrument presented was either declined by the processor or bank, or it can't be used for this payment.", "INSTRUMENT_DECLINED");
  const o: OrderRec = { kind: "order", id: ids.order(), status: "COMPLETED", intent, units, createTime: iso(req.now), updateTime: iso(req.now), vaultId };
  const c: CaptureRec = { kind: "capture", id: ids.capture(), orderId: o.id, amount: unit.amount, refundedMinor: 0, createTime: iso(req.now), updateTime: iso(req.now) };
  const pendingMs = armed?.outcome === "PENDING" ? Math.max(1, config.webhookDelayMs * 2) : 0;
  if (pendingMs) c.pendingUntil = req.now + pendingMs;
  o.captureId = c.id;
  put(c);
  put(o);
  const completed = { ...captureView(c, true, c.pendingUntil ?? req.now), ...(unit.custom_id ? { custom_id: unit.custom_id } : {}) };
  return {
    status: 201,
    body: orderView(o),
    events: [{ event: event("PAYMENT.CAPTURE.COMPLETED", "capture", `Payment completed for ${unit.amount.value} ${unit.amount.currency_code}`, completed), ...(pendingMs ? { delayMs: pendingMs + config.webhookDelayMs } : {}) }],
  };
}

function captureOrder(req: SimRequest, orderId: string): SimResult {
  const o = get("order", orderId);
  if (!o) return notFound(orderId);
  if (o.status === "COMPLETED") return err(422, "UNPROCESSABLE_ENTITY", "Order already captured.", "ORDER_ALREADY_CAPTURED");
  if (o.status !== "APPROVED") return err(422, "UNPROCESSABLE_ENTITY", "Payer has not yet approved the Order for payment.", "ORDER_NOT_APPROVED");
  const unit = o.units[0];
  if (!unit) return err(422, "UNPROCESSABLE_ENTITY", "Order has no purchase unit.", "INVALID_PARAMETER_VALUE");
  const c: CaptureRec = { kind: "capture", id: ids.capture(), orderId: o.id, amount: unit.amount, refundedMinor: 0, createTime: iso(req.now), updateTime: iso(req.now) };
  put(c);
  o.status = "COMPLETED";
  o.captureId = c.id;
  o.updateTime = iso(req.now);
  put(o);
  const resource = { ...captureView(c, true), ...(unit.custom_id ? { custom_id: unit.custom_id } : {}) };
  return {
    status: 201,
    body: orderView(o),
    events: [{ event: event("PAYMENT.CAPTURE.COMPLETED", "capture", `Payment completed for ${unit.amount.value} ${unit.amount.currency_code}`, resource) }],
  };
}

function refundCapture(req: SimRequest, captureId: string): SimResult {
  const c = get("capture", captureId);
  if (!c) return notFound(captureId);
  const body = asRecord(req.body);
  const gross = minor(c.amount);
  const remaining = gross - c.refundedMinor;
  const a = asRecord(body.amount);
  let refundMinor = remaining;
  if (body.amount !== undefined) {
    const currency = asString(a.currency_code);
    const value = asString(a.value);
    if (!currency || !value) return err(400, "INVALID_REQUEST", "amount is invalid", "MISSING_REQUIRED_PARAMETER");
    if (currency !== c.amount.currency_code) return err(422, "UNPROCESSABLE_ENTITY", "Refund currency must match the capture currency.", "REFUND_CURRENCY_MISMATCH");
    refundMinor = fromPayPalValue(value, currency);
  }
  if (remaining <= 0) return err(422, "UNPROCESSABLE_ENTITY", "Capture has already been fully refunded.", "CAPTURE_FULLY_REFUNDED");
  if (refundMinor <= 0 || refundMinor > remaining) return err(422, "UNPROCESSABLE_ENTITY", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.", "REFUND_AMOUNT_EXCEEDED");
  const r: RefundRec = { kind: "refund", id: ids.refund(), captureId: c.id, amount: amount(refundMinor, c.amount.currency_code), createTime: iso(req.now) };
  const note = asString(body.note_to_payer);
  if (note) r.note = note;
  put(r);
  c.refundedMinor += refundMinor;
  c.updateTime = iso(req.now);
  put(c);
  const view = refundView(r);
  return {
    status: 201,
    body: view,
    events: [{ event: event("PAYMENT.CAPTURE.REFUNDED", "refund", `A ${r.amount.value} ${r.amount.currency_code} capture payment was refunded`, view) }],
  };
}

// ---------- Payouts ----------

const FAILURES: Record<string, string> = {
  RECEIVER_ACCOUNT_LOCKED: "Receiver's account is locked or inactive",
  RECEIVER_UNREGISTERED: "Receiver is unregistered",
  RECEIVER_UNCONFIRMED: "Receiver's email or phone number is unconfirmed",
  RISK_DECLINE: "Transaction declined due to risk",
  INSUFFICIENT_FUNDS: "Sender does not have sufficient funds",
};

function createPayouts(req: SimRequest): SimResult {
  const body = asRecord(req.body);
  const header = asRecord(body.sender_batch_header);
  const senderBatchId = asString(header.sender_batch_id);
  const items = Array.isArray(body.items) ? body.items.map(asRecord) : [];
  if (!senderBatchId) return validationError("sender_batch_header.sender_batch_id");
  if (items.length === 0) return validationError("items");
  if (get("index", `batch-sender:${senderBatchId}`)) {
    return { status: 400, body: { name: "USER_BUSINESS_ERROR", message: "Batch with given sender_batch_id already exists", debug_id: ids.debug(), information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors" } };
  }
  const recs: PayoutItemRec[] = [];
  for (const it of items) {
    const a = asRecord(it.amount);
    const currency = asString(a.currency);
    const value = asString(a.value);
    const receiver = asString(it.receiver);
    const senderItemId = asString(it.sender_item_id) ?? "";
    if (!currency || !value || !receiver) return validationError("items.amount");
    const rec: PayoutItemRec = {
      payout_item_id: ids.item(),
      transaction_id: ids.txn(),
      outcome: "SUCCESS",
      payout_item: { recipient_type: asString(it.recipient_type) ?? "EMAIL", amount: { currency, value }, receiver, sender_item_id: senderItemId },
    };
    const note = asString(it.note);
    if (note) rec.payout_item.note = note;
    // An armed failure (POST /api/dev/paypal/fail) applies to the next item with this sender_item_id, once.
    const fail = senderItemId ? get("fail", senderItemId) : undefined;
    if (fail) {
      rec.outcome = "FAILED";
      rec.failure = { name: fail.reason, message: FAILURES[fail.reason] ?? "Payout item failed (simulated)" };
      del("fail", senderItemId);
    }
    recs.push(rec);
  }
  const emailSubject = asString(header.email_subject);
  const b: BatchRec = {
    kind: "batch",
    id: ids.batch(),
    sender_batch_header: { sender_batch_id: senderBatchId, ...(emailSubject ? { email_subject: emailSubject } : {}) },
    createTime: iso(req.now),
    settleAt: req.now + config.webhookDelayMs,
    items: recs,
  };
  put(b);
  put({ kind: "index", name: `batch-sender:${senderBatchId}`, target: b.id });
  const settledView = (it: PayoutItemRec) => itemView(b, it, b.settleAt);
  return {
    status: 201,
    body: {
      batch_header: { payout_batch_id: b.id, batch_status: "PENDING", sender_batch_header: b.sender_batch_header },
      links: [{ href: `${API}/v1/payments/payouts/${b.id}`, rel: "self", method: "GET", encType: "application/json" }],
    },
    events: recs.map((it) => ({
      event:
        it.outcome === "SUCCESS"
          ? event("PAYMENT.PAYOUTS-ITEM.SUCCEEDED", "payouts_item", "A payout item has succeeded", settledView(it))
          : event("PAYMENT.PAYOUTS-ITEM.FAILED", "payouts_item", "A payout item has failed", settledView(it)),
    })),
  };
}

function getPayoutItem(req: SimRequest, itemId: string): SimResult {
  for (const b of records("batch")) {
    const it = b.items.find((i) => i.payout_item_id === itemId);
    if (it) return { status: 200, body: itemView(b, it, req.now) };
  }
  return payoutNotFound();
}

// ---------- Invoices ----------

function createInvoice(req: SimRequest): SimResult {
  const body = asRecord(req.body);
  const detail = asRecord(body.detail);
  const invoicer = asString(asRecord(body.invoicer).email_address);
  const platform = process.env.PAYPAL_PLATFORM_EMAIL || "platform@milestone.sim";
  if (invoicer && invoicer.toLowerCase() !== platform.toLowerCase()) {
    return err(422, "UNPROCESSABLE_ENTITY", "User is not associated with paypal based on invoicer email", "USER_NOT_FOUND");
  }
  const number = asString(detail.invoice_number) ?? `SIM-${code(8)}`;
  if (get("index", `invoice-number:${number}`)) return err(422, "UNPROCESSABLE_ENTITY", "Invoice number is already used.", "DUPLICATE_INVOICE_NUMBER");
  const inv: InvoiceRec = { kind: "invoice", id: ids.invoice(), number, status: "DRAFT", body, payments: [] };
  put(inv);
  put({ kind: "index", name: `invoice-number:${number}`, target: inv.id });
  return { status: 201, body: { rel: "self", href: `${API}/v2/invoicing/invoices/${inv.id}`, method: "GET" } };
}

function sendInvoice(_req: SimRequest, id: string): SimResult {
  const inv = get("invoice", id);
  if (!inv) return notFound(id);
  if (inv.status === "DRAFT") {
    inv.status = "SENT";
    put(inv);
  }
  return { status: 200, body: { rel: "self", href: `https://www.sandbox.paypal.com/invoice/p/#${id}`, method: "GET" } };
}

function recordInvoicePayment(req: SimRequest, id: string): SimResult {
  const inv = get("invoice", id);
  if (!inv) return notFound(id);
  const body = asRecord(req.body);
  const payment: InvoiceRec["payments"][number] = { payment_id: ids.payment() };
  if (body.amount !== undefined) payment.amount = body.amount;
  const method = asString(body.method);
  if (method) payment.method = method;
  const note = asString(body.note);
  if (note) payment.note = note;
  inv.payments.push(payment);
  inv.status = "PAID";
  put(inv);
  return { status: 200, body: { payment_id: payment.payment_id } };
}

// ---------- Disputes ----------

/** Waiting for the seller: not resolved and no evidence under review. */
const awaitingSeller = (d: DisputeRec, now: number) => !isResolved(d, now) && !d.reviewing;

function resolvedEvent(d: DisputeRec): WebhookEvent {
  return event("CUSTOMER.DISPUTE.RESOLVED", "dispute", `Dispute ${d.id} was resolved.`, disputeView(d, d.resolveAt ?? Date.now()));
}

function provideEvidence(req: SimRequest, id: string): SimResult {
  const d = get("dispute", id);
  if (!d) return notFound(id);
  const upload = req.upload;
  if (!upload?.input) return err(400, "INVALID_REQUEST", "The input part is required and must be JSON.", "MISSING_REQUIRED_PARAMETER");
  if (!awaitingSeller(d, req.now)) return err(422, "UNPROCESSABLE_ENTITY", "The dispute is not waiting for the seller's evidence.", "INVALID_DISPUTE_STATUS");
  const evidences = Array.isArray(upload.input.evidences) ? upload.input.evidences.map(asRecord) : [];
  if (evidences.length === 0 || evidences.some((e) => !asString(e.evidence_type))) return err(400, "INVALID_REQUEST", "evidences[].evidence_type is required.", "MISSING_REQUIRED_PARAMETER");
  const byName = new Map(upload.files.map((f) => [f.name, f]));
  const recs: DisputeEvidenceRec[] = [];
  for (const e of evidences) {
    const notes = asString(e.notes);
    if (notes && notes.length > 2000) return err(400, "INVALID_REQUEST", "notes must be at most 2000 characters.", "INVALID_STRING_MAX_LENGTH");
    const docs = Array.isArray(e.documents) ? e.documents.map(asRecord) : [];
    const documents: DisputeEvidenceRec["documents"] = [];
    for (const doc of docs) {
      const f = byName.get(asString(doc.name) ?? "");
      if (!f) return err(400, "INVALID_REQUEST", `No file part named ${String(doc.name)}.`, "MISSING_REQUIRED_PARAMETER");
      documents.push({ name: f.name, size: f.size, type: f.type, sha256: f.sha256 });
    }
    recs.push({ evidence_type: String(e.evidence_type), ...(notes ? { notes } : {}), documents, date: iso(req.now) });
  }
  d.evidences.push(...recs);
  d.reviewing = true;
  d.updateTime = iso(req.now);
  d.resolveAt = req.now + config.disputeResolveDelayMs;
  d.outcome = "RESOLVED_SELLER_FAVOUR";
  put(d);
  return {
    status: 200,
    body: { links: [{ href: `${API}/v1/customer/disputes/${d.id}`, rel: "self", method: "GET" }] },
    events: [{ event: resolvedEvent(d), delayMs: config.disputeResolveDelayMs }],
  };
}

function acceptClaim(req: SimRequest, id: string): SimResult {
  const d = get("dispute", id);
  if (!d) return notFound(id);
  if (!awaitingSeller(d, req.now)) return err(422, "UNPROCESSABLE_ENTITY", "The dispute can no longer be accepted.", "INVALID_DISPUTE_STATUS");
  d.acceptNote = asString(asRecord(req.body).note) ?? "";
  d.updateTime = iso(req.now);
  d.resolveAt = req.now;
  d.outcome = "RESOLVED_BUYER_FAVOUR";
  put(d);
  // The refund comes out of the capture when the simulator knows it (showcase captures are display data only).
  const c = get("capture", d.captureId);
  if (c) {
    c.refundedMinor = Math.min(minor(c.amount), c.refundedMinor + minor(d.amount));
    c.updateTime = iso(req.now);
    put(c);
  }
  return {
    status: 200,
    body: { links: [{ href: `${API}/v1/customer/disputes/${d.id}`, rel: "self", method: "GET" }] },
    events: [{ event: resolvedEvent(d) }],
  };
}

// ---------- Vault (Payment Method Tokens v3) ----------

function vaultSource(paypal: Record<string, unknown>): VaultSource {
  const src: VaultSource = {};
  const description = asString(paypal.description);
  if (description) src.description = description;
  for (const k of ["usage_type", "customer_type", "usage_pattern"] as const) {
    const v = asString(paypal[k]);
    if (v) src[k] = v;
  }
  if (typeof paypal.permit_multiple_payment_tokens === "boolean") src.permit_multiple_payment_tokens = paypal.permit_multiple_payment_tokens;
  const brand = asString(asRecord(paypal.experience_context).brand_name);
  if (brand) src.brand_name = brand;
  return src;
}

function createSetupToken(req: SimRequest): SimResult {
  const body = asRecord(req.body);
  const source = asRecord(body.payment_source);
  if (!source.paypal) return err(400, "INVALID_REQUEST", "payment_source.paypal is required.", "MISSING_REQUIRED_PARAMETER");
  const paypal = asRecord(source.paypal);
  const ctx = asRecord(paypal.experience_context);
  const returnUrl = asString(ctx.return_url);
  const cancelUrl = asString(ctx.cancel_url);
  if (!returnUrl || !cancelUrl) return err(400, "INVALID_REQUEST", "experience_context.return_url and cancel_url are required.", "MISSING_REQUIRED_PARAMETER");
  if (!asString(paypal.usage_type)) return err(400, "INVALID_REQUEST", "payment_source.paypal.usage_type is required.", "MISSING_REQUIRED_PARAMETER");
  const t: SetupTokenRec = {
    kind: "setup_token",
    id: ids.setupToken(),
    customerId: asString(asRecord(body.customer).id) ?? ids.customer(),
    status: "PAYER_ACTION_REQUIRED",
    source: vaultSource(paypal),
    returnUrl,
    cancelUrl,
    createTime: iso(req.now),
    updateTime: iso(req.now),
  };
  put(t);
  return { status: 201, body: setupTokenView(t) };
}

function createPaymentToken(req: SimRequest): SimResult {
  const token = asRecord(asRecord(asRecord(req.body).payment_source).token);
  const setupId = asString(token.id);
  if (!setupId || token.type !== "SETUP_TOKEN") return err(400, "INVALID_REQUEST", "payment_source.token with type SETUP_TOKEN is required.", "MISSING_REQUIRED_PARAMETER");
  const t = get("setup_token", setupId);
  if (!t) return notFound(setupId);
  if (t.status === "PAYER_ACTION_REQUIRED") return err(422, "UNPROCESSABLE_ENTITY", "The payer has not approved the setup token.", "SETUP_TOKEN_NOT_APPROVED");
  // permit_multiple_payment_tokens false: a setup token yields one payment token; asking again returns it.
  const existing = t.paymentTokenId ? get("payment_token", t.paymentTokenId) : undefined;
  if (existing) return { status: 200, body: paymentTokenView(existing) };
  const p: PaymentTokenRec = {
    kind: "payment_token",
    id: ids.paymentToken(),
    customerId: t.customerId,
    setupTokenId: t.id,
    payerEmail: t.payerEmail ?? PAYER.email_address,
    payerId: ids.payer(),
    source: t.source,
    createTime: iso(req.now),
  };
  put(p);
  t.status = "VAULTED";
  t.paymentTokenId = p.id;
  t.updateTime = iso(req.now);
  put(t);
  const view = paymentTokenView(p);
  return { status: 201, body: view, events: [{ event: event("VAULT.PAYMENT-TOKEN.CREATED", "payment_token", `A payment token ${p.id} was created.`, view) }] };
}

function deletePaymentToken(_req: SimRequest, id: string): SimResult {
  const p = get("payment_token", id);
  if (!p) return notFound(id);
  del("payment_token", id);
  return { status: 204, body: null, events: [{ event: event("VAULT.PAYMENT-TOKEN.DELETED", "payment_token", `A payment token ${id} was deleted.`, { id, customer: { id: p.customerId } }) }] };
}

function listPaymentTokens(req: SimRequest): SimResult {
  const customerId = new URLSearchParams(req.query).get("customer_id");
  if (!customerId) return err(400, "INVALID_REQUEST", "customer_id is required.", "MISSING_REQUIRED_PARAMETER");
  const tokens = [...records("payment_token")].filter((p) => p.customerId === customerId);
  return { status: 200, body: { customer: { id: customerId }, payment_tokens: tokens.map(paymentTokenView), total_items: tokens.length, total_pages: 1 } };
}

// ---------- OAuth ----------

function token(headers: Headers, raw: string, now: number): SimResult {
  if (!headers.get("authorization")?.startsWith("Basic ")) return { status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } };
  const params = new URLSearchParams(raw);
  if (params.get("grant_type") !== "client_credentials") return { status: 400, body: { error: "unsupported_grant_type", error_description: "Grant Type is NULL" } };
  if (params.get("response_type") === "client_token") {
    return { status: 200, body: { access_token: ids.token("CT"), token_type: "Bearer", expires_in: 900 } };
  }
  return {
    status: 200,
    body: {
      scope: "https://uri.paypal.com/services/payments/payment https://uri.paypal.com/services/payments/refund https://uri.paypal.com/services/payouts https://uri.paypal.com/services/invoicing",
      access_token: ids.token("A21AA"),
      token_type: "Bearer",
      app_id: "APP-SIMULATED",
      expires_in: 32400,
      nonce: `${iso(now)}${randomUUID()}`,
    },
  };
}

// ---------- Routing ----------

type Handler = (req: SimRequest, id: string) => SimResult;
const ID = "([^/]+)";
/** method, path pattern (its one group is the decoded resource id), handler. GET handlers never write. */
const ROUTES: Array<[method: "GET" | "POST" | "DELETE", pattern: RegExp, handle: Handler]> = [
  ["POST", /^\/v3\/vault\/setup-tokens$/, createSetupToken],
  ["GET", new RegExp(`^/v3/vault/setup-tokens/${ID}$`), (_req, id) => getOr404("setup_token", id, setupTokenView)],
  ["POST", /^\/v3\/vault\/payment-tokens$/, createPaymentToken],
  ["GET", /^\/v3\/vault\/payment-tokens$/, listPaymentTokens],
  ["GET", new RegExp(`^/v3/vault/payment-tokens/${ID}$`), (_req, id) => getOr404("payment_token", id, paymentTokenView)],
  ["DELETE", new RegExp(`^/v3/vault/payment-tokens/${ID}$`), deletePaymentToken],
  ["GET", new RegExp(`^/v1/customer/disputes/${ID}$`), (req, id) => getOr404("dispute", id, (d) => disputeView(d, req.now))],
  ["POST", new RegExp(`^/v1/customer/disputes/${ID}/provide-evidence$`), provideEvidence],
  ["POST", new RegExp(`^/v1/customer/disputes/${ID}/accept-claim$`), acceptClaim],
  ["POST", /^\/v2\/checkout\/orders$/, createOrder],
  ["GET", new RegExp(`^/v2/checkout/orders/${ID}$`), (_req, id) => getOr404("order", id, orderView)],
  ["POST", new RegExp(`^/v2/checkout/orders/${ID}/capture$`), captureOrder],
  ["GET", new RegExp(`^/v2/payments/captures/${ID}$`), (_req, id) => getOr404("capture", id, (c) => captureView(c, true))],
  ["POST", new RegExp(`^/v2/payments/captures/${ID}/refund$`), refundCapture],
  ["GET", new RegExp(`^/v2/payments/refunds/${ID}$`), (_req, id) => getOr404("refund", id, refundView)],
  ["POST", /^\/v1\/payments\/payouts$/, createPayouts],
  ["GET", new RegExp(`^/v1/payments/payouts/${ID}$`), (req, id) => {
    const b = get("batch", id);
    return b ? { status: 200, body: batchView(b, req.now) } : payoutNotFound();
  }],
  ["GET", new RegExp(`^/v1/payments/payouts-item/${ID}$`), getPayoutItem],
  ["POST", /^\/v2\/invoicing\/invoices$/, createInvoice],
  ["GET", new RegExp(`^/v2/invoicing/invoices/${ID}$`), (_req, id) => getOr404("invoice", id, invoiceView)],
  ["POST", new RegExp(`^/v2/invoicing/invoices/${ID}/send$`), sendInvoice],
  ["POST", new RegExp(`^/v2/invoicing/invoices/${ID}/payments$`), recordInvoicePayment],
  ["POST", /^\/v1\/notifications\/verify-webhook-signature$/, () => ({ status: 200, body: { verification_status: "SUCCESS" } })],
];

function route(req: SimRequest): SimResult {
  for (const [method, pattern, handle] of ROUTES) {
    if (method !== req.method) continue;
    const m = pattern.exec(req.path);
    if (m) return handle(req, decodeURIComponent(m[1] ?? ""));
  }
  return err(404, "RESOURCE_NOT_FOUND", `Simulated PayPal has no ${req.method} ${req.path}`, "INVALID_RESOURCE_ID");
}

// ---------- fetch ----------

function json(status: number, body: unknown, debugId: string): Response {
  return new Response(body === null || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": debugId },
  });
}

const malformed = (debugId: string) => json(400, { name: "INVALID_REQUEST", message: "Request is not well-formed, syntactically incorrect, or violates schema.", debug_id: debugId }, debugId);

/** Reads a multipart provide-evidence body (async, so before the state is touched). */
async function readUpload(body: NonNullable<RequestInit["body"]>, contentType: string): Promise<EvidenceUpload> {
  const form = await new Response(body, { headers: { "content-type": contentType } }).formData();
  const upload: EvidenceUpload = { input: null, files: [] };
  for (const [field, value] of form.entries()) {
    if (typeof value === "string") {
      if (field === "input") upload.input = asRecord(JSON.parse(value));
      continue;
    }
    if (field === "input") {
      upload.input = asRecord(JSON.parse(await value.text()));
      continue;
    }
    const bytes = new Uint8Array(await value.arrayBuffer());
    upload.files.push({ field, name: value.name || field, size: bytes.length, type: value.type, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return upload;
}

/** A fetch for PayPalClient: answers PayPal's REST API from the simulator's state. */
export const simulatedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const raw = typeof init?.body === "string" ? init.body : "";
  const contentType = headers.get("content-type") ?? "";
  const debugId = ids.debug();
  const now = Date.now();
  if (url.host !== "api-m.sandbox.paypal.com" && url.host !== "api-m.paypal.com") return json(404, { name: "RESOURCE_NOT_FOUND", message: `unknown host ${url.host}` }, debugId);

  if (url.pathname === "/v1/oauth2/token" && method === "POST") {
    const r = token(headers, raw, now);
    return json(r.status, r.body, debugId);
  }
  if (!headers.get("authorization")?.startsWith("Bearer ")) {
    return json(401, { error: "invalid_token", error_description: "Authentication failed due to missing Authorization header" }, debugId);
  }
  let upload: EvidenceUpload | null = null;
  if (/^multipart\/form-data/i.test(contentType) && init?.body && typeof init.body !== "string") {
    try {
      upload = await readUpload(init.body, contentType);
    } catch {
      return malformed(debugId);
    }
  }
  let body: Record<string, unknown> | null = null;
  if (raw) {
    try {
      body = asRecord(JSON.parse(raw));
    } catch {
      return malformed(debugId);
    }
  }
  const req: SimRequest = { method, path: url.pathname, body, headers, now, upload, query: url.search };
  const requestId = method === "POST" ? headers.get("paypal-request-id") : null;

  const result =
    method === "GET"
      ? read(() => route(req))
      : await transact((): SimResult => {
          if (!requestId) return route(req);
          // Like PayPal: the same request id on the same endpoint replays the first 2xx answer (errors are not kept).
          const key = `${method} ${url.pathname} ${requestId}`;
          const seen = get("idem", key);
          if (seen) return { status: seen.status, body: seen.body };
          const r = route(req);
          if (r.status >= 200 && r.status < 300) put({ kind: "idem", key, status: r.status, body: r.body });
          return r;
        });
  for (const e of result.events ?? []) scheduleWebhook(e.event, e.delayMs ?? config.webhookDelayMs);
  return json(result.status, result.body, debugId);
};

// ---------- Webhook delivery ----------

const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000];

function scheduleWebhook(evt: WebhookEvent, delayMs: number): void {
  setTimeout(() => void deliver(evt, 0), delayMs);
}

async function deliver(evt: WebhookEvent, attempt: number): Promise<void> {
  try {
    if (config.deliver) {
      await config.deliver(evt);
      return;
    }
    const res = await fetch(`${appUrl()}/api/webhooks/paypal`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [SIMULATED_WEBHOOK_HEADER]: simulatedWebhookSecret() ?? "dev",
        "PAYPAL-TRANSMISSION-ID": randomUUID(),
        "PAYPAL-TRANSMISSION-TIME": new Date().toISOString(),
        "PAYPAL-AUTH-ALGO": "SHA256withRSA",
        "PAYPAL-CERT-URL": `${API}/v1/notifications/certs/CERT-SIMULATED`,
        "PAYPAL-TRANSMISSION-SIG": `SIM-${randomBytes(32).toString("base64")}`,
      },
      body: JSON.stringify(evt),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (e) {
    const wait = RETRY_MS[attempt];
    const why = e instanceof Error ? e.message : String(e);
    if (wait === undefined) {
      console.error(`[simulated paypal] gave up delivering ${evt.event_type} ${evt.id}: ${why}`);
      return;
    }
    console.warn(`[simulated paypal] ${evt.event_type} ${evt.id} not delivered (${why}); retrying in ${wait / 1000}s`);
    setTimeout(() => void deliver(evt, attempt + 1), wait).unref?.();
  }
}

// ---------- Operator / dev controls (used by /api/dev/paypal/*) ----------

/** The buyer approves the order (what PayPal's checkout page does). Idempotent; null when the order is unknown. */
export function approveSimulatedOrder(orderId: string): SimulatedOrderSummary | null {
  return transactSync(() => {
    const o = get("order", orderId);
    if (!o) return null;
    if (o.status === "CREATED") {
      o.status = "APPROVED";
      o.updateTime = new Date().toISOString();
      put(o);
    }
    return summary(o);
  });
}

export function simulatedOrder(orderId: string): SimulatedOrderSummary | null {
  return read(() => {
    const o = get("order", orderId);
    return o ? summary(o) : null;
  });
}

/** Makes the NEXT payout item with this sender_item_id come back FAILED (once). */
export function failNextSimulatedPayout(senderItemId: string, reason = "RECEIVER_ACCOUNT_LOCKED"): { senderItemId: string; reason: string } {
  const r = /^[A-Z_]{3,64}$/.test(reason) ? reason : "RECEIVER_ACCOUNT_LOCKED";
  transactSync(() => put({ kind: "fail", senderItemId, reason: r }));
  return { senderItemId, reason: r };
}

/** sender_item_ids with an armed failure. */
export function armedSimulatedFailures(): Array<{ senderItemId: string; reason: string }> {
  return read(() => [...records("fail")].map((r) => ({ senderItemId: r.senderItemId, reason: r.reason })));
}

// ---------- Vault dev controls (used by /api/dev/paypal/vault-approve) ----------

/**
 * The payer approves a setup token (what PayPal's approval page does): PAYER_ACTION_REQUIRED -> APPROVED. Idempotent;
 * null when the token is unknown. The summary's returnUrl is where to send the payer next.
 */
export function approveSimulatedSetupToken(setupTokenId: string, opts: { payerEmail?: string } = {}): SimulatedSetupTokenSummary | null {
  return transactSync(() => {
    const t = get("setup_token", setupTokenId);
    if (!t) return null;
    if (t.status === "PAYER_ACTION_REQUIRED") {
      t.status = "APPROVED";
      t.payerEmail = opts.payerEmail ?? PAYER.email_address;
      t.updateTime = new Date().toISOString();
      put(t);
    }
    return setupSummary(t);
  });
}

export function simulatedSetupToken(setupTokenId: string): SimulatedSetupTokenSummary | null {
  return read(() => {
    const t = get("setup_token", setupTokenId);
    return t ? setupSummary(t) : null;
  });
}

/** Makes the NEXT charge of this vault id come back with a PENDING capture, or DECLINED (once). */
export function armSimulatedVaultCharge(vaultId: string, outcome: "PENDING" | "DECLINED"): { vaultId: string; outcome: "PENDING" | "DECLINED" } {
  transactSync(() => put({ kind: "vault_arm", vaultId, outcome }));
  return { vaultId, outcome };
}

// ---------- Disputes (POST /api/disputes/dev) ----------

export interface SimulatedDispute {
  disputeId: string;
  captureId: string;
  reason: string;
  amount: Amount;
  /** False when an open dispute already existed for this capture and was returned instead. */
  created: boolean;
}

const DISPUTE_REASONS = new Set(["MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "UNAUTHORISED", "CREDIT_NOT_PROCESSED", "DUPLICATE_TRANSACTION", "INCORRECT_AMOUNT", "PAYMENT_BY_OTHER_MEANS", "CANCELED_RECURRING_BILLING", "PROBLEM_WITH_REMITTANCE", "OTHER"]);

/**
 * The buyer opens a dispute against a capture (what PayPal's Resolution Center does) and CUSTOMER.DISPUTE.CREATED is
 * sent after the webhook delay. The capture does not need to exist in the simulator (showcase captures are display
 * data). One open dispute per capture: a second call returns the open one and sends nothing.
 */
export function openSimulatedDispute(input: { captureId: string; amountMinor: number; currency: string; reason?: string; buyerNote?: string; responseDays?: number }): SimulatedDispute {
  const reason = input.reason && DISPUTE_REASONS.has(input.reason) ? input.reason : "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED";
  const now = Date.now();
  const out = transactSync((): { d: DisputeRec; created: boolean } => {
    for (const r of records("dispute")) {
      if (r.captureId === input.captureId && !isResolved(r, now)) return { d: r, created: false };
    }
    const d: DisputeRec = {
      kind: "dispute",
      id: ids.dispute(),
      captureId: input.captureId,
      reason,
      amount: amount(input.amountMinor, input.currency),
      buyerNote: input.buyerNote ?? "The work I received does not match what was described.",
      createTime: iso(now),
      updateTime: iso(now),
      dueDate: iso(now + (input.responseDays ?? 10) * 86_400_000),
      evidences: [],
    };
    put(d);
    return { d, created: true };
  });
  if (out.created) scheduleWebhook(event("CUSTOMER.DISPUTE.CREATED", "dispute", `A new dispute was created with ID ${out.d.id}.`, disputeView(out.d, now)), config.webhookDelayMs);
  return { disputeId: out.d.id, captureId: out.d.captureId, reason: out.d.reason, amount: out.d.amount, created: out.created };
}
