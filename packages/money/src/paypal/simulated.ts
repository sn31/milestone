/**
 * Simulated PayPal: a fetchImpl for PayPalClient that answers the REST calls Milestone makes with sandbox-shaped JSON,
 * so the whole loop (fund -> verify -> release -> settle) runs locally and as a demo-day backup.
 *
 * - PAYPAL_MODE=simulated turns it on; unset, it is the default when PAYPAL_CLIENT_ID is empty and NODE_ENV is not
 *   production. createPayPalClient() picks the simulated or the real client.
 * - Idempotent on PayPal-Request-Id like PayPal: the same id on the same endpoint replays the first 2xx response
 *   (errors are not remembered, so a capture refused before approval succeeds later with the same id).
 * - State lives in a module-level Map and is persisted to var/simulated-paypal.json (repo root) so web and worker
 *   share it. Every call reloads, mutates and saves under a lock file; writes go to a temp file and are renamed.
 * - Disputes: openSimulatedDispute (POST /api/disputes/dev) opens one against a capture and emits
 *   CUSTOMER.DISPUTE.CREATED; provide-evidence (multipart) puts it under review and emits CUSTOMER.DISPUTE.RESOLVED in
 *   the seller's favour ~2 s later; accept-claim resolves it in the buyer's favour.
 * - Captures, payouts and refunds emit the matching webhook events to APP_URL/api/webhooks/paypal after ~1.5 s with
 *   header X-Milestone-Simulated: <SIMULATED_WEBHOOK_SECRET or "dev">. The webhook route accepts that header instead of
 *   PayPal's signature only in simulated mode (see isSimulatedWebhook).
 *
 * No money moves here; nothing in this file is reachable from the browser.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fromPayPalValue, toPayPalValue } from "@milestone/core";
import { PayPalClient } from "./client.ts";
import type { WebhookEvent } from "./webhooks.ts";

// ---------- Mode ----------

export type PayPalMode = "simulated" | "sandbox";

/** PAYPAL_MODE wins; unset or empty, simulated when there are no PayPal credentials outside production. */
export function paypalMode(env: NodeJS.ProcessEnv = process.env): PayPalMode {
  const explicit = env.PAYPAL_MODE?.trim().toLowerCase();
  if (explicit === "simulated") return "simulated";
  if (explicit === "sandbox" || explicit === "live" || explicit === "paypal") return "sandbox";
  if (!env.PAYPAL_CLIENT_ID && env.NODE_ENV !== "production") return "simulated";
  return "sandbox";
}

/** The PayPal client for this process: the simulator in simulated mode, otherwise PayPalClient.fromEnv. */
export function createPayPalClient(env: NodeJS.ProcessEnv = process.env, prefix = "PAYPAL_"): PayPalClient {
  if (paypalMode(env) === "simulated") return createSimulatedPayPalClient(prefix === "PAYPAL_" ? "platform" : prefix.toLowerCase());
  return PayPalClient.fromEnv(env, prefix);
}

export function createSimulatedPayPalClient(account = "platform"): PayPalClient {
  return new PayPalClient({ clientId: `SIM-${account}`, clientSecret: "SIM-secret", env: "sandbox", fetchImpl: simulatedFetch });
}

// ---------- Simulated webhook authentication ----------

export const SIMULATED_WEBHOOK_HEADER = "X-Milestone-Simulated";

/** The shared secret for simulated webhooks. Outside production it defaults to "dev"; in production it must be set. */
export function simulatedWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.SIMULATED_WEBHOOK_SECRET;
  if (s) return s;
  return env.NODE_ENV === "production" ? null : "dev";
}

/** True only in simulated mode and only when X-Milestone-Simulated carries the secret (constant-time compare). */
export function isSimulatedWebhook(headers: Headers | Record<string, string | undefined>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (paypalMode(env) !== "simulated") return false;
  const secret = simulatedWebhookSecret(env);
  if (!secret) return false;
  const got = headers instanceof Headers ? headers.get(SIMULATED_WEBHOOK_HEADER) : (headers[SIMULATED_WEBHOOK_HEADER] ?? headers[SIMULATED_WEBHOOK_HEADER.toLowerCase()]);
  if (!got) return false;
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}

// ---------- Configuration ----------

export interface SimulatorOptions {
  /** JSON file shared by web and worker. null keeps state in memory only (tests). */
  stateFile?: string | null;
  /** Delay before the webhook events of a capture, payout or refund are sent. Default 1500 ms. */
  webhookDelayMs?: number;
  /** Replaces the HTTP delivery of webhook events (tests). */
  deliver?: ((event: WebhookEvent) => Promise<void> | void) | null;
  /** Base for the approve link and the webhook target. Default APP_URL or http://localhost:3000. */
  appUrl?: string;
  /** Delay between provide-evidence and the dispute resolving (CUSTOMER.DISPUTE.RESOLVED). Default 2000 ms. */
  disputeResolveDelayMs?: number;
}

interface Config {
  stateFile: string | null | undefined; // undefined: resolve from env on first use
  webhookDelayMs: number;
  deliver: ((event: WebhookEvent) => Promise<void> | void) | null;
  appUrl: string | undefined;
  disputeResolveDelayMs: number;
}

const config: Config = { stateFile: undefined, webhookDelayMs: 1500, deliver: null, appUrl: undefined, disputeResolveDelayMs: 2000 };

export function configureSimulator(opts: SimulatorOptions): void {
  if (opts.stateFile !== undefined) {
    config.stateFile = opts.stateFile === null ? null : resolve(opts.stateFile);
    store.clear();
  }
  if (opts.webhookDelayMs !== undefined) config.webhookDelayMs = opts.webhookDelayMs;
  if (opts.deliver !== undefined) config.deliver = opts.deliver;
  if (opts.appUrl !== undefined) config.appUrl = opts.appUrl;
  if (opts.disputeResolveDelayMs !== undefined) config.disputeResolveDelayMs = opts.disputeResolveDelayMs;
}

function appUrl(): string {
  return (config.appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/** var/simulated-paypal.json at the workspace root (found from the cwd), or SIMULATED_PAYPAL_STATE_FILE. */
function stateFile(): string | null {
  if (config.stateFile !== undefined) return config.stateFile;
  const fromEnv = process.env.SIMULATED_PAYPAL_STATE_FILE;
  if (fromEnv === "memory") return (config.stateFile = null);
  if (fromEnv) return (config.stateFile = resolve(fromEnv));
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) break;
    const up = dirname(dir);
    if (up === dir) {
      dir = process.cwd();
      break;
    }
    dir = up;
  }
  return (config.stateFile = join(dir, "var", "simulated-paypal.json"));
}

// ---------- State ----------

type Amount = { currency_code: string; value: string };

interface OrderRec {
  kind: "order";
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  intent: string;
  units: Array<{ reference_id: string; description?: string; custom_id?: string; amount: Amount }>;
  returnUrl?: string;
  cancelUrl?: string;
  createTime: string;
  updateTime: string;
  captureId?: string;
}
interface CaptureRec {
  kind: "capture";
  id: string;
  orderId: string;
  amount: Amount;
  refundedMinor: number;
  createTime: string;
  updateTime: string;
}
interface RefundRec {
  kind: "refund";
  id: string;
  captureId: string;
  amount: Amount;
  note?: string;
  createTime: string;
}
interface PayoutItemRec {
  payout_item_id: string;
  transaction_id: string;
  outcome: "SUCCESS" | "FAILED";
  failure?: { name: string; message: string };
  payout_item: { recipient_type: string; amount: { currency: string; value: string }; note?: string; receiver: string; sender_item_id: string };
}
interface BatchRec {
  kind: "batch";
  id: string;
  sender_batch_header: { sender_batch_id: string; email_subject?: string };
  createTime: string;
  /** Items stay PENDING until this time (epoch ms), then show their outcome; the webhooks fire then too. */
  settleAt: number;
  items: PayoutItemRec[];
}
interface InvoiceRec {
  kind: "invoice";
  id: string;
  number: string;
  status: "DRAFT" | "SENT" | "PAID";
  body: Record<string, unknown>;
  payments: Array<{ payment_id: string; amount?: unknown; method?: string; note?: string }>;
}
interface IndexRec {
  kind: "index";
  target: string;
}
interface IdemRec {
  kind: "idem";
  status: number;
  body: unknown;
}
interface FailRec {
  kind: "fail";
  senderItemId: string;
  reason: string;
}
interface DisputeEvidenceRec {
  evidence_type: string;
  notes?: string;
  documents: Array<{ name: string; size: number; type: string; sha256: string }>;
  date: string;
}
interface DisputeRec {
  kind: "dispute";
  id: string;
  captureId: string;
  reason: string;
  amount: Amount;
  buyerNote: string;
  createTime: string;
  updateTime: string;
  dueDate: string;
  /** Set by provide-evidence or accept-claim: the dispute reads RESOLVED with `outcome` from this time (epoch ms). */
  resolveAt?: number;
  outcome?: "RESOLVED_SELLER_FAVOUR" | "RESOLVED_BUYER_FAVOUR";
  /** Set once evidence is in: UNDER_REVIEW until resolveAt. */
  reviewing?: boolean;
  evidences: DisputeEvidenceRec[];
  acceptNote?: string;
}
type Rec = OrderRec | CaptureRec | RefundRec | BatchRec | InvoiceRec | IndexRec | IdemRec | FailRec | DisputeRec;

/** The simulator's state, keyed "<kind>:<id>". Mirrors the state file while persistence is on. */
const store = new Map<string, Rec>();

function get<K extends Rec["kind"]>(kind: K, id: string): Extract<Rec, { kind: K }> | undefined {
  const r = store.get(`${kind}:${id}`);
  return r && r.kind === kind ? (r as Extract<Rec, { kind: K }>) : undefined;
}
function put(key: string, rec: Rec): void {
  store.set(key, rec);
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleepBuf, 0, 0, ms);
}

/** Cross-process lock: an exclusive lock file next to the state file. A lock older than 10 s is treated as stale. */
function lock(file: string): () => void {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      closeSync(fd);
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 10_000) unlinkSync(lockPath);
      } catch {
        /* raced with the owner */
      }
      if (Date.now() > deadline) throw new Error(`simulated PayPal: could not lock ${lockPath}`);
      sleepSync(5);
    }
  }
}

function load(file: string): void {
  store.clear();
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return; // deleting the file resets the simulator
    throw e;
  }
  if (!text.trim()) return;
  const data = JSON.parse(text) as { records?: Record<string, Rec> };
  for (const [k, v] of Object.entries(data.records ?? {})) store.set(k, v);
}

function save(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), records: Object.fromEntries(store) }, null, 1));
  renameSync(tmp, file);
}

/** Runs fn against fresh state and saves it, all synchronously, so no other call (in or across processes) interleaves. */
function transact<T>(fn: () => T): T {
  const file = stateFile();
  if (!file) return fn();
  mkdirSync(dirname(file), { recursive: true });
  const release = lock(file);
  try {
    load(file);
    const out = fn();
    save(file);
    return out;
  } finally {
    release();
  }
}

/** Test helper: forget everything (memory and, when persisted, the state file). */
export function resetSimulator(): void {
  transact(() => store.clear());
}

// ---------- Ids ----------

const ALNUM = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
function code(n: number): string {
  const bytes = randomBytes(n);
  let s = "";
  for (let i = 0; i < n; i++) s += ALNUM[(bytes[i] ?? 0) % ALNUM.length];
  return s;
}
const ids = {
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
};

// ---------- Views (sandbox-shaped JSON) ----------

const API = "https://api-m.sandbox.paypal.com";
const MERCHANT = { email_address: "sb-sim-merchant@business.example.com", merchant_id: "SIMMERCHANT01" };
const PAYER = {
  name: { given_name: "Sim", surname: "Client" },
  email_address: "sb-sim-client@personal.example.com",
  payer_id: "SIMPAYER0001",
  address: { country_code: "US" },
};

function minor(a: Amount): number {
  return fromPayPalValue(a.value, a.currency_code);
}
function amount(minorUnits: number, currency: string): Amount {
  return { currency_code: currency, value: toPayPalValue(minorUnits, currency) };
}
function feeMinor(grossMinor: number): number {
  return Math.round(grossMinor * 0.0349);
}

function captureView(c: CaptureRec, withOrder = false): Record<string, unknown> {
  const gross = minor(c.amount);
  const fee = feeMinor(gross);
  const status = c.refundedMinor === 0 ? "COMPLETED" : c.refundedMinor >= gross ? "REFUNDED" : "PARTIALLY_REFUNDED";
  return {
    id: c.id,
    status,
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

function orderView(o: OrderRec): Record<string, unknown> {
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
    ...(o.status !== "CREATED" ? { payment_source: { paypal: { email_address: PAYER.email_address, account_id: PAYER.payer_id, account_status: "VERIFIED", name: PAYER.name, address: PAYER.address } } } : {}),
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

function refundView(r: RefundRec): Record<string, unknown> {
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

function itemView(b: BatchRec, it: PayoutItemRec, now: number): Record<string, unknown> {
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

function batchView(b: BatchRec, now: number): Record<string, unknown> {
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

function event(eventType: string, resourceType: string, summary: string, resource: Record<string, unknown>): WebhookEvent & Record<string, unknown> {
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

// ---------- Handlers ----------

interface SimRequest {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  headers: Headers;
  now: number;
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

const iso = (now: number) => new Date(now).toISOString();
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function createOrder(req: SimRequest): SimResult {
  const body = obj(req.body);
  const units = Array.isArray(body.purchase_units) ? body.purchase_units.map(obj) : [];
  if (body.intent !== "CAPTURE" && body.intent !== "AUTHORIZE") return err(400, "INVALID_REQUEST", "intent is required", "MISSING_REQUIRED_PARAMETER");
  if (units.length === 0) return err(400, "INVALID_REQUEST", "purchase_units is required", "MISSING_REQUIRED_PARAMETER");
  const parsed: OrderRec["units"] = [];
  for (const [i, u] of units.entries()) {
    const a = obj(u.amount);
    const currency = str(a.currency_code);
    const value = str(a.value);
    if (!currency || !value || !/^\d+(\.\d{1,2})?$/.test(value)) return err(422, "UNPROCESSABLE_ENTITY", "amount is invalid", "INVALID_PARAMETER_VALUE");
    const unit: OrderRec["units"][number] = { reference_id: str(u.reference_id) ?? (i === 0 ? "default" : String(i)), amount: { currency_code: currency, value } };
    const description = str(u.description);
    if (description) unit.description = description;
    const customId = str(u.custom_id);
    if (customId) unit.custom_id = customId;
    parsed.push(unit);
  }
  const ctx = obj(obj(obj(body.payment_source).paypal).experience_context);
  const o: OrderRec = { kind: "order", id: ids.order(), status: "CREATED", intent: String(body.intent), units: parsed, createTime: iso(req.now), updateTime: iso(req.now) };
  const ret = str(ctx.return_url);
  if (ret) o.returnUrl = ret;
  const cancel = str(ctx.cancel_url);
  if (cancel) o.cancelUrl = cancel;
  put(`order:${o.id}`, o);
  return { status: 201, body: orderView(o) };
}

function captureOrder(req: SimRequest, orderId: string): SimResult {
  const o = get("order", orderId);
  if (!o) return err(404, "RESOURCE_NOT_FOUND", `The specified resource ${orderId} does not exist.`, "INVALID_RESOURCE_ID");
  if (o.status === "COMPLETED") return err(422, "UNPROCESSABLE_ENTITY", "Order already captured.", "ORDER_ALREADY_CAPTURED");
  if (o.status !== "APPROVED") return err(422, "UNPROCESSABLE_ENTITY", "Payer has not yet approved the Order for payment.", "ORDER_NOT_APPROVED");
  const unit = o.units[0];
  if (!unit) return err(422, "UNPROCESSABLE_ENTITY", "Order has no purchase unit.", "INVALID_PARAMETER_VALUE");
  const c: CaptureRec = { kind: "capture", id: ids.capture(), orderId: o.id, amount: unit.amount, refundedMinor: 0, createTime: iso(req.now), updateTime: iso(req.now) };
  put(`capture:${c.id}`, c);
  o.status = "COMPLETED";
  o.captureId = c.id;
  o.updateTime = iso(req.now);
  const resource = { ...captureView(c, true), ...(unit.custom_id ? { custom_id: unit.custom_id } : {}) };
  return {
    status: 201,
    body: orderView(o),
    events: [{ event: event("PAYMENT.CAPTURE.COMPLETED", "capture", `Payment completed for ${unit.amount.value} ${unit.amount.currency_code}`, resource) }],
  };
}

function refundCapture(req: SimRequest, captureId: string): SimResult {
  const c = get("capture", captureId);
  if (!c) return err(404, "RESOURCE_NOT_FOUND", `The specified resource ${captureId} does not exist.`, "INVALID_RESOURCE_ID");
  const body = obj(req.body);
  const gross = minor(c.amount);
  const remaining = gross - c.refundedMinor;
  const a = obj(body.amount);
  let refundMinor = remaining;
  if (body.amount !== undefined) {
    const currency = str(a.currency_code);
    const value = str(a.value);
    if (!currency || !value) return err(400, "INVALID_REQUEST", "amount is invalid", "MISSING_REQUIRED_PARAMETER");
    if (currency !== c.amount.currency_code) return err(422, "UNPROCESSABLE_ENTITY", "Refund currency must match the capture currency.", "REFUND_CURRENCY_MISMATCH");
    refundMinor = fromPayPalValue(value, currency);
  }
  if (remaining <= 0) return err(422, "UNPROCESSABLE_ENTITY", "Capture has already been fully refunded.", "CAPTURE_FULLY_REFUNDED");
  if (refundMinor <= 0 || refundMinor > remaining) return err(422, "UNPROCESSABLE_ENTITY", "The refund amount must be less than or equal to the capture amount that has not yet been refunded.", "REFUND_AMOUNT_EXCEEDED");
  const r: RefundRec = { kind: "refund", id: ids.refund(), captureId: c.id, amount: amount(refundMinor, c.amount.currency_code), createTime: iso(req.now) };
  const note = str(body.note_to_payer);
  if (note) r.note = note;
  put(`refund:${r.id}`, r);
  c.refundedMinor += refundMinor;
  c.updateTime = iso(req.now);
  const view = refundView(r);
  return {
    status: 201,
    body: view,
    events: [{ event: event("PAYMENT.CAPTURE.REFUNDED", "refund", `A ${r.amount.value} ${r.amount.currency_code} capture payment was refunded`, view) }],
  };
}

function createPayouts(req: SimRequest): SimResult {
  const body = obj(req.body);
  const header = obj(body.sender_batch_header);
  const senderBatchId = str(header.sender_batch_id);
  const items = Array.isArray(body.items) ? body.items.map(obj) : [];
  if (!senderBatchId) return { status: 400, body: { name: "VALIDATION_ERROR", message: "Invalid request - see details", debug_id: ids.debug(), details: [{ field: "sender_batch_header.sender_batch_id", location: "body", issue: "required" }] } };
  if (items.length === 0) return { status: 400, body: { name: "VALIDATION_ERROR", message: "Invalid request - see details", debug_id: ids.debug(), details: [{ field: "items", location: "body", issue: "required" }] } };
  if (get("index", `batch-sender:${senderBatchId}`)) {
    return { status: 400, body: { name: "USER_BUSINESS_ERROR", message: "Batch with given sender_batch_id already exists", debug_id: ids.debug(), information_link: "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors" } };
  }
  const recs: PayoutItemRec[] = [];
  for (const it of items) {
    const a = obj(it.amount);
    const currency = str(a.currency);
    const value = str(a.value);
    const receiver = str(it.receiver);
    const senderItemId = str(it.sender_item_id) ?? "";
    if (!currency || !value || !receiver) return { status: 400, body: { name: "VALIDATION_ERROR", message: "Invalid request - see details", debug_id: ids.debug(), details: [{ field: "items.amount", location: "body", issue: "required" }] } };
    const rec: PayoutItemRec = {
      payout_item_id: ids.item(),
      transaction_id: ids.txn(),
      outcome: "SUCCESS",
      payout_item: { recipient_type: str(it.recipient_type) ?? "EMAIL", amount: { currency, value }, receiver, sender_item_id: senderItemId },
    };
    const note = str(it.note);
    if (note) rec.payout_item.note = note;
    // An armed failure (POST /api/dev/paypal/fail) applies to the next item with this sender_item_id, once.
    const fail = senderItemId ? get("fail", senderItemId) : undefined;
    if (fail) {
      rec.outcome = "FAILED";
      rec.failure = { name: fail.reason, message: failureMessage(fail.reason) };
      store.delete(`fail:${senderItemId}`);
    }
    recs.push(rec);
  }
  const b: BatchRec = {
    kind: "batch",
    id: ids.batch(),
    sender_batch_header: { sender_batch_id: senderBatchId, ...(str(header.email_subject) ? { email_subject: String(header.email_subject) } : {}) },
    createTime: iso(req.now),
    settleAt: req.now + config.webhookDelayMs,
    items: recs,
  };
  put(`batch:${b.id}`, b);
  put(`index:batch-sender:${senderBatchId}`, { kind: "index", target: b.id });
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

const FAILURES: Record<string, string> = {
  RECEIVER_ACCOUNT_LOCKED: "Receiver's account is locked or inactive",
  RECEIVER_UNREGISTERED: "Receiver is unregistered",
  RECEIVER_UNCONFIRMED: "Receiver's email or phone number is unconfirmed",
  RISK_DECLINE: "Transaction declined due to risk",
  INSUFFICIENT_FUNDS: "Sender does not have sufficient funds",
};
function failureMessage(reason: string): string {
  return FAILURES[reason] ?? "Payout item failed (simulated)";
}

function createInvoice(req: SimRequest): SimResult {
  const body = obj(req.body);
  const detail = obj(body.detail);
  const number = str(detail.invoice_number) ?? `SIM-${code(8)}`;
  if (get("index", `invoice-number:${number}`)) return err(422, "UNPROCESSABLE_ENTITY", "Invoice number is already used.", "DUPLICATE_INVOICE_NUMBER");
  const inv: InvoiceRec = { kind: "invoice", id: ids.invoice(), number, status: "DRAFT", body, payments: [] };
  put(`invoice:${inv.id}`, inv);
  put(`index:invoice-number:${number}`, { kind: "index", target: inv.id });
  return { status: 201, body: { rel: "self", href: `${API}/v2/invoicing/invoices/${inv.id}`, method: "GET" } };
}

function invoiceView(inv: InvoiceRec): Record<string, unknown> {
  return {
    id: inv.id,
    status: inv.status,
    ...inv.body,
    detail: { ...obj(inv.body.detail), invoice_number: inv.number },
    ...(inv.payments.length ? { payments: { transactions: inv.payments } } : {}),
    links: [{ href: `${API}/v2/invoicing/invoices/${inv.id}`, rel: "self", method: "GET" }],
  };
}

function sendInvoice(id: string): SimResult {
  const inv = get("invoice", id);
  if (!inv) return err(404, "RESOURCE_NOT_FOUND", `The specified resource ${id} does not exist.`, "INVALID_RESOURCE_ID");
  if (inv.status === "DRAFT") inv.status = "SENT";
  return { status: 200, body: { rel: "self", href: `https://www.sandbox.paypal.com/invoice/p/#${id}`, method: "GET" } };
}

function recordInvoicePayment(req: SimRequest, id: string): SimResult {
  const inv = get("invoice", id);
  if (!inv) return err(404, "RESOURCE_NOT_FOUND", `The specified resource ${id} does not exist.`, "INVALID_RESOURCE_ID");
  const body = obj(req.body);
  const payment: InvoiceRec["payments"][number] = { payment_id: ids.payment() };
  if (body.amount !== undefined) payment.amount = body.amount;
  const method = str(body.method);
  if (method) payment.method = method;
  const note = str(body.note);
  if (note) payment.note = note;
  inv.payments.push(payment);
  inv.status = "PAID";
  return { status: 200, body: { payment_id: payment.payment_id } };
}

function token(req: SimRequest, raw: string): SimResult {
  if (!req.headers.get("authorization")?.startsWith("Basic ")) return { status: 401, body: { error: "invalid_client", error_description: "Client Authentication failed" } };
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
      nonce: `${iso(req.now)}${randomUUID()}`,
    },
  };
}

// ---------- Disputes ----------

function disputeView(d: DisputeRec, now: number): Record<string, unknown> {
  const resolved = d.resolveAt !== undefined && now >= d.resolveAt;
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

function disputeOpen(d: DisputeRec, now: number): boolean {
  return !(d.resolveAt !== undefined && now >= d.resolveAt) && !d.reviewing;
}

function resolvedEvent(d: DisputeRec): WebhookEvent {
  const at = d.resolveAt ?? Date.now();
  return event("CUSTOMER.DISPUTE.RESOLVED", "dispute", `Dispute ${d.id} was resolved.`, disputeView(d, at));
}

/** The parsed multipart body of provide-evidence: the "input" JSON part and the file parts. */
interface EvidenceUpload {
  input: Record<string, unknown> | null;
  files: Array<{ field: string; name: string; size: number; type: string; sha256: string }>;
}

function provideEvidence(req: SimRequest, id: string, upload: EvidenceUpload | null): SimResult {
  const d = get("dispute", id);
  if (!d) return err(404, "RESOURCE_NOT_FOUND", `The specified resource ${id} does not exist.`, "INVALID_RESOURCE_ID");
  if (!upload?.input) return err(400, "INVALID_REQUEST", "The input part is required and must be JSON.", "MISSING_REQUIRED_PARAMETER");
  if (!disputeOpen(d, req.now)) return err(422, "UNPROCESSABLE_ENTITY", "The dispute is not waiting for the seller's evidence.", "INVALID_DISPUTE_STATUS");
  const evidences = Array.isArray(upload.input.evidences) ? upload.input.evidences.map(obj) : [];
  if (evidences.length === 0 || evidences.some((e) => !str(e.evidence_type))) return err(400, "INVALID_REQUEST", "evidences[].evidence_type is required.", "MISSING_REQUIRED_PARAMETER");
  const byName = new Map(upload.files.map((f) => [f.name, f]));
  const recs: DisputeEvidenceRec[] = [];
  for (const e of evidences) {
    const notes = str(e.notes);
    if (notes && notes.length > 2000) return err(400, "INVALID_REQUEST", "notes must be at most 2000 characters.", "INVALID_STRING_MAX_LENGTH");
    const docs = Array.isArray(e.documents) ? e.documents.map(obj) : [];
    const documents: DisputeEvidenceRec["documents"] = [];
    for (const doc of docs) {
      const f = byName.get(str(doc.name) ?? "");
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
  return {
    status: 200,
    body: { links: [{ href: `${API}/v1/customer/disputes/${d.id}`, rel: "self", method: "GET" }] },
    events: [{ event: resolvedEvent(d), delayMs: config.disputeResolveDelayMs }],
  };
}

function acceptClaim(req: SimRequest, id: string): SimResult {
  const d = get("dispute", id);
  if (!d) return err(404, "RESOURCE_NOT_FOUND", `The specified resource ${id} does not exist.`, "INVALID_RESOURCE_ID");
  if (!disputeOpen(d, req.now)) return err(422, "UNPROCESSABLE_ENTITY", "The dispute can no longer be accepted.", "INVALID_DISPUTE_STATUS");
  d.acceptNote = str(obj(req.body).note) ?? "";
  d.updateTime = iso(req.now);
  d.resolveAt = req.now;
  d.outcome = "RESOLVED_BUYER_FAVOUR";
  // The refund comes out of the capture when the simulator knows it (showcase captures are display data only).
  const c = get("capture", d.captureId);
  if (c) {
    c.refundedMinor = Math.min(minor(c.amount), c.refundedMinor + minor(d.amount));
    c.updateTime = iso(req.now);
  }
  return {
    status: 200,
    body: { links: [{ href: `${API}/v1/customer/disputes/${d.id}`, rel: "self", method: "GET" }] },
    events: [{ event: resolvedEvent(d) }],
  };
}

/** The routing switch. Runs inside transact(): reads and writes `store` synchronously. */
function route(req: SimRequest, upload: EvidenceUpload | null = null): SimResult {
  const { method, path } = req;
  let m: RegExpExecArray | null;
  if ((m = /^\/v1\/customer\/disputes\/([^/]+)$/.exec(path)) && method === "GET") {
    const d = get("dispute", decodeURIComponent(m[1] ?? ""));
    return d ? { status: 200, body: disputeView(d, req.now) } : err(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
  }
  if ((m = /^\/v1\/customer\/disputes\/([^/]+)\/provide-evidence$/.exec(path)) && method === "POST") return provideEvidence(req, decodeURIComponent(m[1] ?? ""), upload);
  if ((m = /^\/v1\/customer\/disputes\/([^/]+)\/accept-claim$/.exec(path)) && method === "POST") return acceptClaim(req, decodeURIComponent(m[1] ?? ""));
  if (path === "/v2/checkout/orders" && method === "POST") return createOrder(req);
  if ((m = /^\/v2\/checkout\/orders\/([^/]+)$/.exec(path)) && method === "GET") {
    const o = get("order", decodeURIComponent(m[1] ?? ""));
    return o ? { status: 200, body: orderView(o) } : err(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
  }
  if ((m = /^\/v2\/checkout\/orders\/([^/]+)\/capture$/.exec(path)) && method === "POST") return captureOrder(req, decodeURIComponent(m[1] ?? ""));
  if ((m = /^\/v2\/payments\/captures\/([^/]+)$/.exec(path)) && method === "GET") {
    const c = get("capture", decodeURIComponent(m[1] ?? ""));
    return c ? { status: 200, body: captureView(c, true) } : err(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
  }
  if ((m = /^\/v2\/payments\/captures\/([^/]+)\/refund$/.exec(path)) && method === "POST") return refundCapture(req, decodeURIComponent(m[1] ?? ""));
  if ((m = /^\/v2\/payments\/refunds\/([^/]+)$/.exec(path)) && method === "GET") {
    const r = get("refund", decodeURIComponent(m[1] ?? ""));
    return r ? { status: 200, body: refundView(r) } : err(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
  }
  if (path === "/v1/payments/payouts" && method === "POST") return createPayouts(req);
  if ((m = /^\/v1\/payments\/payouts\/([^/]+)$/.exec(path)) && method === "GET") {
    const b = get("batch", decodeURIComponent(m[1] ?? ""));
    return b ? { status: 200, body: batchView(b, req.now) } : { status: 404, body: { name: "INVALID_RESOURCE_ID", message: "Requested resource ID was not found.", debug_id: ids.debug() } };
  }
  if ((m = /^\/v1\/payments\/payouts-item\/([^/]+)$/.exec(path)) && method === "GET") {
    const itemId = decodeURIComponent(m[1] ?? "");
    for (const rec of store.values()) {
      if (rec.kind !== "batch") continue;
      const it = rec.items.find((i) => i.payout_item_id === itemId);
      if (it) return { status: 200, body: itemView(rec, it, req.now) };
    }
    return { status: 404, body: { name: "INVALID_RESOURCE_ID", message: "Requested resource ID was not found.", debug_id: ids.debug() } };
  }
  if (path === "/v2/invoicing/invoices" && method === "POST") return createInvoice(req);
  if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)$/.exec(path)) && method === "GET") {
    const inv = get("invoice", decodeURIComponent(m[1] ?? ""));
    return inv ? { status: 200, body: invoiceView(inv) } : err(404, "RESOURCE_NOT_FOUND", "The specified resource does not exist.", "INVALID_RESOURCE_ID");
  }
  if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)\/send$/.exec(path)) && method === "POST") return sendInvoice(decodeURIComponent(m[1] ?? ""));
  if ((m = /^\/v2\/invoicing\/invoices\/([^/]+)\/payments$/.exec(path)) && method === "POST") return recordInvoicePayment(req, decodeURIComponent(m[1] ?? ""));
  if (path === "/v1/notifications/verify-webhook-signature" && method === "POST") return { status: 200, body: { verification_status: "SUCCESS" } };
  return err(404, "RESOURCE_NOT_FOUND", `Simulated PayPal has no ${method} ${path}`, "INVALID_RESOURCE_ID");
}

function json(status: number, body: unknown, debugId: string): Response {
  return new Response(body === null || body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "paypal-debug-id": debugId },
  });
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
    const r = token({ method, path: url.pathname, body: null, headers, now }, raw);
    return json(r.status, r.body, debugId);
  }
  if (!headers.get("authorization")?.startsWith("Bearer ")) {
    return json(401, { error: "invalid_token", error_description: "Authentication failed due to missing Authorization header" }, debugId);
  }
  let body: Record<string, unknown> | null = null;
  // Multipart (provide-evidence): parsed before the lock, since reading a body is async.
  let upload: EvidenceUpload | null = null;
  if (/^multipart\/form-data/i.test(contentType) && init?.body && typeof init.body !== "string") {
    try {
      const form = await new Response(init.body, { headers: { "content-type": contentType } }).formData();
      upload = { input: null, files: [] };
      for (const [field, value] of form.entries()) {
        if (typeof value === "string") {
          if (field === "input") upload.input = obj(JSON.parse(value));
          continue;
        }
        if (field === "input") {
          upload.input = obj(JSON.parse(await value.text()));
          continue;
        }
        const bytes = new Uint8Array(await value.arrayBuffer());
        upload.files.push({ field, name: value.name || field, size: bytes.length, type: value.type, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    } catch {
      return json(400, { name: "INVALID_REQUEST", message: "Request is not well-formed, syntactically incorrect, or violates schema.", debug_id: debugId }, debugId);
    }
  }
  if (raw) {
    try {
      body = obj(JSON.parse(raw));
    } catch {
      return json(400, { name: "INVALID_REQUEST", message: "Request is not well-formed, syntactically incorrect, or violates schema.", debug_id: debugId }, debugId);
    }
  }
  const req: SimRequest = { method, path: url.pathname, body, headers, now };
  const requestId = method === "POST" ? headers.get("paypal-request-id") : null;

  const result = transact((): SimResult => {
    if (requestId) {
      const key = `idem:${method} ${url.pathname} ${requestId}`;
      const seen = store.get(key);
      if (seen?.kind === "idem") return { status: seen.status, body: seen.body };
      const r = route(req, upload);
      if (r.status >= 200 && r.status < 300) put(key, { kind: "idem", status: r.status, body: r.body });
      return r;
    }
    return route(req, upload);
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

export interface SimulatedOrderSummary {
  id: string;
  status: "CREATED" | "APPROVED" | "COMPLETED";
  referenceId: string | null;
  amount: Amount | null;
}

function summary(o: OrderRec): SimulatedOrderSummary {
  const u = o.units[0];
  return { id: o.id, status: o.status, referenceId: u?.reference_id ?? null, amount: u?.amount ?? null };
}

/** The buyer approves the order (what PayPal's checkout page does). Idempotent; null when the order is unknown. */
export function approveSimulatedOrder(orderId: string): SimulatedOrderSummary | null {
  return transact(() => {
    const o = get("order", orderId);
    if (!o) return null;
    if (o.status === "CREATED") {
      o.status = "APPROVED";
      o.updateTime = new Date().toISOString();
    }
    return summary(o);
  });
}

export function simulatedOrder(orderId: string): SimulatedOrderSummary | null {
  return transact(() => {
    const o = get("order", orderId);
    return o ? summary(o) : null;
  });
}

/** Makes the NEXT payout item with this sender_item_id come back FAILED (once). */
export function failNextSimulatedPayout(senderItemId: string, reason = "RECEIVER_ACCOUNT_LOCKED"): { senderItemId: string; reason: string } {
  const r = /^[A-Z_]{3,64}$/.test(reason) ? reason : "RECEIVER_ACCOUNT_LOCKED";
  transact(() => put(`fail:${senderItemId}`, { kind: "fail", senderItemId, reason: r }));
  return { senderItemId, reason: r };
}

/** sender_item_ids with an armed failure. */
export function armedSimulatedFailures(): Array<{ senderItemId: string; reason: string }> {
  return transact(() => [...store.values()].flatMap((r) => (r.kind === "fail" ? [{ senderItemId: r.senderItemId, reason: r.reason }] : [])));
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
  const out = transact((): { d: DisputeRec; created: boolean } => {
    for (const r of store.values()) {
      if (r.kind === "dispute" && r.captureId === input.captureId && !(r.resolveAt !== undefined && now >= r.resolveAt)) return { d: r, created: false };
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
    put(`dispute:${d.id}`, d);
    return { d, created: true };
  });
  if (out.created) scheduleWebhook(event("CUSTOMER.DISPUTE.CREATED", "dispute", `A new dispute was created with ID ${out.d.id}.`, disputeView(out.d, now)), config.webhookDelayMs);
  return { disputeId: out.d.id, captureId: out.d.captureId, reason: out.d.reason, amount: out.d.amount, created: out.created };
}
