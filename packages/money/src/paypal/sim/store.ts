/**
 * The simulator's configuration and state. State is a Map keyed "<kind>:<id>", persisted to var/simulated-paypal.json
 * (repo root) so web and worker share it. A write runs under a lock file: reload (only when the file changed since this
 * process last saw it), mutate, and save only when something was put or deleted; saves go to a temp file and are
 * renamed. Reads take no lock (the rename is atomic) and never write.
 */
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { WebhookEvent } from "../webhooks.ts";

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

export const config: Config = { stateFile: undefined, webhookDelayMs: 1500, deliver: null, appUrl: undefined, disputeResolveDelayMs: 2000 };

export function configureSimulator(opts: SimulatorOptions): void {
  if (opts.stateFile !== undefined) {
    config.stateFile = opts.stateFile === null ? null : resolve(opts.stateFile);
    store.clear();
    seen = null;
  }
  if (opts.webhookDelayMs !== undefined) config.webhookDelayMs = opts.webhookDelayMs;
  if (opts.deliver !== undefined) config.deliver = opts.deliver;
  if (opts.appUrl !== undefined) config.appUrl = opts.appUrl;
  if (opts.disputeResolveDelayMs !== undefined) config.disputeResolveDelayMs = opts.disputeResolveDelayMs;
}

export function appUrl(): string {
  return (config.appUrl ?? process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

export const SIMULATED_WEBHOOK_HEADER = "X-Milestone-Simulated";

/** The shared secret for simulated webhooks. Outside production it defaults to "dev"; in production it must be set. */
export function simulatedWebhookSecret(env: NodeJS.ProcessEnv = process.env): string | null {
  const s = env.SIMULATED_WEBHOOK_SECRET;
  if (s) return s;
  return env.NODE_ENV === "production" ? null : "dev";
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

// ---------- Records ----------

export type Amount = { currency_code: string; value: string };

export interface OrderRec {
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
  /** Set for an order paid from a saved PayPal (payment_source.paypal.vault_id). */
  vaultId?: string;
}
export interface CaptureRec {
  kind: "capture";
  id: string;
  orderId: string;
  amount: Amount;
  refundedMinor: number;
  createTime: string;
  updateTime: string;
  /** A capture held as PENDING until this time (epoch ms); PAYMENT.CAPTURE.COMPLETED fires then. */
  pendingUntil?: number;
}
export interface RefundRec {
  kind: "refund";
  id: string;
  captureId: string;
  amount: Amount;
  note?: string;
  createTime: string;
}
export interface PayoutItemRec {
  payout_item_id: string;
  transaction_id: string;
  outcome: "SUCCESS" | "FAILED";
  failure?: { name: string; message: string };
  payout_item: { recipient_type: string; amount: { currency: string; value: string }; note?: string; receiver: string; sender_item_id: string };
}
export interface BatchRec {
  kind: "batch";
  id: string;
  sender_batch_header: { sender_batch_id: string; email_subject?: string };
  createTime: string;
  /** Items stay PENDING until this time (epoch ms), then show their outcome; the webhooks fire then too. */
  settleAt: number;
  items: PayoutItemRec[];
}
export interface InvoiceRec {
  kind: "invoice";
  id: string;
  number: string;
  status: "DRAFT" | "SENT" | "PAID";
  body: Record<string, unknown>;
  payments: Array<{ payment_id: string; amount?: unknown; method?: string; note?: string }>;
}
/** A lookup "index:<name>" -> target id (e.g. batch-sender:<sender_batch_id>). */
export interface IndexRec {
  kind: "index";
  name: string;
  target: string;
}
/** A remembered 2xx answer, "idem:<method> <path> <PayPal-Request-Id>". */
export interface IdemRec {
  kind: "idem";
  key: string;
  status: number;
  body: unknown;
}
export interface FailRec {
  kind: "fail";
  senderItemId: string;
  reason: string;
}
export interface DisputeEvidenceRec {
  evidence_type: string;
  notes?: string;
  documents: Array<{ name: string; size: number; type: string; sha256: string }>;
  date: string;
}
export interface DisputeRec {
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
/** The PayPal attributes a setup token / payment token was created with (payment_source.paypal). */
export interface VaultSource {
  description?: string;
  usage_type?: string;
  customer_type?: string;
  usage_pattern?: string;
  permit_multiple_payment_tokens?: boolean;
  brand_name?: string;
}
/** POST /v3/vault/setup-tokens: PAYER_ACTION_REQUIRED until the payer approves, VAULTED once a payment token exists. */
export interface SetupTokenRec {
  kind: "setup_token";
  id: string;
  customerId: string;
  status: "PAYER_ACTION_REQUIRED" | "APPROVED" | "VAULTED";
  source: VaultSource;
  returnUrl?: string;
  cancelUrl?: string;
  payerEmail?: string;
  paymentTokenId?: string;
  createTime: string;
  updateTime: string;
}
/** A saved PayPal: what an order's payment_source.paypal.vault_id names. Deleted by DELETE /v3/vault/payment-tokens/{id}. */
export interface PaymentTokenRec {
  kind: "payment_token";
  id: string;
  customerId: string;
  setupTokenId: string;
  payerEmail: string;
  payerId: string;
  source: VaultSource;
  createTime: string;
}
/** An armed outcome for the NEXT charge of a vault id (dev control): PENDING capture or DECLINED. Used once. */
export interface VaultArmRec {
  kind: "vault_arm";
  vaultId: string;
  outcome: "PENDING" | "DECLINED";
}
export type Rec = OrderRec | CaptureRec | RefundRec | BatchRec | InvoiceRec | IndexRec | IdemRec | FailRec | DisputeRec | SetupTokenRec | PaymentTokenRec | VaultArmRec;
type Kind = Rec["kind"];

// ---------- State ----------

/** Idempotency records kept; older ones are dropped (a replay that old gets a fresh answer). */
const IDEM_LIMIT = 500;

const store = new Map<string, Rec>();
/** Set by put/del inside a transaction; only then is the file written. */
let dirty = false;
/** Identity of the file version the Map mirrors (inode, mtime, size), so an unchanged file is not re-read. */
let seen: string | null = null;

function keyOf(rec: Rec): string {
  switch (rec.kind) {
    case "index":
      return `index:${rec.name}`;
    case "idem":
      return `idem:${rec.key}`;
    case "fail":
      return `fail:${rec.senderItemId}`;
    case "vault_arm":
      return `vault_arm:${rec.vaultId}`;
    default:
      return `${rec.kind}:${rec.id}`;
  }
}

export function get<K extends Kind>(kind: K, id: string): Extract<Rec, { kind: K }> | undefined {
  const r = store.get(`${kind}:${id}`);
  return r && r.kind === kind ? (r as Extract<Rec, { kind: K }>) : undefined;
}

/** Stores (or re-stores after an in-place change) a record under the key derived from it. */
export function put(rec: Rec): void {
  const key = keyOf(rec);
  const added = !store.has(key);
  store.set(key, rec);
  dirty = true;
  if (added && rec.kind === "idem") trimIdem();
}

export function del(kind: Kind, id: string): void {
  if (store.delete(`${kind}:${id}`)) dirty = true;
}

export function* records<K extends Kind>(kind: K): Generator<Extract<Rec, { kind: K }>> {
  for (const r of store.values()) if (r.kind === kind) yield r as Extract<Rec, { kind: K }>;
}

function trimIdem(): void {
  const keys = [...store.keys()].filter((k) => k.startsWith("idem:"));
  for (const k of keys.slice(0, Math.max(0, keys.length - IDEM_LIMIT))) store.delete(k);
}

function clearAll(): void {
  store.clear();
  dirty = true;
}

function fileIdentity(file: string): string | null {
  try {
    const st = statSync(file, { bigint: true });
    return `${st.ino}:${st.mtimeNs}:${st.size}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Brings the Map in line with the file, re-reading it only when it changed. A missing file resets the simulator. */
function load(file: string): void {
  const id = fileIdentity(file);
  if (id !== null && id === seen) return;
  store.clear();
  seen = id;
  if (id === null) return;
  const text = readFileSync(file, "utf8");
  if (!text.trim()) return;
  const data = JSON.parse(text) as { records?: Record<string, Rec> };
  for (const [k, v] of Object.entries(data.records ?? {})) store.set(k, v);
}

function save(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, savedAt: new Date().toISOString(), records: Object.fromEntries(store) }));
  renameSync(tmp, file);
  seen = fileIdentity(file);
}

// ---------- Cross-process lock ----------

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 10_000;
const LOCK_RETRY_MS = 5;

/** One attempt at the lock file next to the state file: its release function, or null while another holder has it. */
function tryLock(lockPath: string): (() => void) | null {
  try {
    closeSync(openSync(lockPath, "wx"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      mkdirSync(dirname(lockPath), { recursive: true });
      return tryLock(lockPath);
    }
    if (code !== "EEXIST") throw e;
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) unlinkSync(lockPath);
    } catch {
      /* raced with the owner */
    }
    return null;
  }
  return () => {
    try {
      unlinkSync(lockPath);
    } catch {
      /* already gone */
    }
  };
}

async function lock(file: string): Promise<() => void> {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = tryLock(lockPath);
    if (release) return release;
    if (Date.now() > deadline) throw new Error(`simulated PayPal: could not lock ${lockPath}`);
    await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
  }
}

const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
/** For the synchronous dev controls only (their callers are synchronous); the fetch path waits asynchronously. */
function lockSync(file: string): () => void {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const release = tryLock(lockPath);
    if (release) return release;
    if (Date.now() > deadline) throw new Error(`simulated PayPal: could not lock ${lockPath}`);
    Atomics.wait(sleepBuf, 0, 0, LOCK_RETRY_MS);
  }
}

// ---------- Transactions ----------

/** load -> fn -> save-if-dirty, synchronously between taking and releasing the lock, so nothing interleaves. */
function run<T>(file: string, fn: () => T): T {
  load(file);
  dirty = false;
  try {
    const out = fn();
    if (dirty) save(file);
    return out;
  } catch (e) {
    seen = null; // drop any half-applied change: the next call re-reads the file
    throw e;
  } finally {
    dirty = false;
  }
}

/** Runs fn against fresh state and saves what it changed. The lock is awaited without blocking the event loop. */
export async function transact<T>(fn: () => T): Promise<T> {
  const file = stateFile();
  if (!file) return fn();
  const release = await lock(file);
  try {
    return run(file, fn);
  } finally {
    release();
  }
}

/** transact for synchronous callers (the dev controls). */
export function transactSync<T>(fn: () => T): T {
  const file = stateFile();
  if (!file) return fn();
  const release = lockSync(file);
  try {
    return run(file, fn);
  } finally {
    release();
  }
}

/** Runs a read-only fn against fresh state without the lock (saves are atomic renames). */
export function read<T>(fn: () => T): T {
  const file = stateFile();
  if (!file) return fn();
  load(file);
  dirty = false;
  const out = fn();
  if (dirty) {
    // A read must not change state; if one did, forget it rather than diverge from the file.
    seen = null;
    dirty = false;
  }
  return out;
}

/** Test helper: forget everything (memory and, when persisted, the state file). */
export function resetSimulator(): void {
  transactSync(clearAll);
}
