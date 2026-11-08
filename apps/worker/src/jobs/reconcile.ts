import type { Job } from "pg-boss";
import { and, gte, inArray, like, or } from "drizzle-orm";
import { OP_KINDS, asRecord, asString, audit, isFreelancerAccount, isSimulatorId, isPartnerAccount, ledgerEntries, paypalMode, paypalOps, webhookEvents, type Db } from "@milestone/core";
import { PayPalMcpError, openPayPalMcp, parseTransactions, type PayPalMcpSession, type PayPalTransaction } from "@milestone/money";
import type { JobData } from "../handlers.ts";
import { getDb } from "../lib/db.ts";

/**
 * Reconciliation through PayPal's MCP server (read-only). For a window that ends RECONCILE_LAG_HOURS ago (default 3:
 * Transaction Search lags behind live payments) and spans RECONCILE_WINDOW_HOURS (default 24, at most 31 days), it
 * calls list_transactions through the allowlisted MCP client and matches every PayPal transaction id against what
 * Milestone recorded: capture ids, refund ids and payout item ids (paypal_ops), and the amounts against the ledger.
 *
 * The result is one audit row, "ops.reconciled", with { window, paypalCount, matched, missingInLedger,
 * missingInPayPal, amountMismatches } (the last three are lists). Any mismatch shows on /ops as its own reconciliation
 * card; no milestone changes state. A call that fails is recorded as "ops.reconcile_failed" with PayPal's error body,
 * and the job does not retry (the next run covers the window again).
 *
 * Everything here is deterministic. The summary line is a template over the counts; no model computes or decides.
 */

export const RECONCILE_EVENTS = { reconciled: "ops.reconciled", failed: "ops.reconcile_failed" } as const;
/** The milestone id the reconcile job is enqueued under (enqueue needs one; reconciliation is account-wide). */
export const RECONCILE_QUEUE_KEY = "ops";
export const RECONCILE_TOOL = "list_transactions";
/** Items kept per list in the audit detail; the counts are always complete. */
const LIST_CAP = 100;
const MAX_PAGES = 20;
const PAGE_SIZE = 500;
const HOUR = 3_600_000;

export interface ReconcileWindow {
  start: string;
  end: string;
  lagHours: number;
}

const isoSeconds = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
const numberEnv = (v: string | undefined, fallback: number) => {
  const n = v === undefined || v.trim() === "" ? NaN : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * The window to reconcile: explicit { start, end } when given (clamped to 31 days, ending at the start's +31d), else
 * [now - lag - hours, now - lag]. Simulated mode has no Transaction Search lag, so its lag defaults to 0.
 */
export function reconcileWindow(now: Date, env: NodeJS.ProcessEnv = process.env, explicit?: { start?: unknown; end?: unknown }): ReconcileWindow {
  const simulated = paypalMode(env) === "simulated";
  const lagHours = numberEnv(env.RECONCILE_LAG_HOURS, simulated ? 0 : 3);
  const hours = Math.min(numberEnv(env.RECONCILE_WINDOW_HOURS, 24), 31 * 24);
  const s = Date.parse(asString(explicit?.start) ?? "");
  const e = Date.parse(asString(explicit?.end) ?? "");
  if (Number.isFinite(s) && Number.isFinite(e) && e > s) {
    return { start: isoSeconds(new Date(Math.max(s, e - 31 * 24 * HOUR))), end: isoSeconds(new Date(e)), lagHours: 0 };
  }
  const end = new Date(now.getTime() - lagHours * HOUR);
  return { start: isoSeconds(new Date(end.getTime() - hours * HOUR)), end: isoSeconds(end), lagHours };
}

// ---------- What Milestone expects PayPal to show ----------

export interface OpLike {
  kind: string;
  key: string;
  paypalId: string | null;
  status: string;
  response: unknown;
  createdAt: Date;
  updatedAt: Date | null;
}
export interface LedgerLike {
  ref: string;
  account: string;
  direction: string;
  amountMinor: number;
  currency: string;
}

export interface Expected {
  kind: "capture" | "refund" | "payout" | "advance-payout";
  opKey: string;
  party?: "freelancer" | "partner";
  /** PayPal ids that identify this movement as a transaction id. */
  ids: string[];
  /** Ids PayPal may name as the row's paypal_reference_id instead (payout item / batch). */
  refIds: string[];
  /** What the ledger booked for it (positive), or null when nothing is booked yet. */
  ledgerMinor: number | null;
  currency: string | null;
  at: Date;
  /** Counted as missing in PayPal when no row matches (succeeded on our side and on this account). */
  required: boolean;
}

/** An op the showcase seed recorded with simulator ids (its PayPal id, or an id in its stored response). */
export function isRecordedOp(op: Pick<OpLike, "paypalId" | "response">): boolean {
  if (isSimulatorId(op.paypalId)) return true;
  return [...idsIn(op.response, ITEM_KEYS_AND_BATCH)].some((id) => isSimulatorId(id));
}

/** Every string value under these keys in a stored PayPal response (payout items carry their ids there). */
function idsIn(v: unknown, keys: ReadonlySet<string>, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 6 || v === null || typeof v !== "object") return out;
  if (Array.isArray(v)) {
    for (const x of v) idsIn(x, keys, out, depth + 1);
    return out;
  }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (keys.has(k) && typeof x === "string" && x) out.add(x);
    else idsIn(x, keys, out, depth + 1);
  }
  return out;
}
const ITEM_KEYS: ReadonlySet<string> = new Set(["payout_item_id", "payoutItemId", "transaction_id"]);
const ITEM_KEYS_AND_BATCH: ReadonlySet<string> = new Set([...ITEM_KEYS, "payout_batch_id", "id"]);

/** Sum of one direction's lines whose ref passes `ref` (and whose account passes `account`), with their currency. */
function booked(ledger: LedgerLike[], ref: (r: string) => boolean, direction: "debit" | "credit", account: (a: string) => boolean = () => true): { minor: number | null; currency: string | null } {
  const rows = ledger.filter((l) => ref(l.ref) && l.direction === direction && account(l.account));
  if (!rows.length) return { minor: null, currency: null };
  return { minor: rows.reduce((s, l) => s + l.amountMinor, 0), currency: rows[0]!.currency };
}

/**
 * What PayPal should show, from paypal_ops and the ledger. Captures by capture id (ledger ref = capture id), refunds by
 * refund id (ref refund:<milestone>), each payout item by its item id or transaction id (credits to that party under
 * release:<milestone>*), advance payouts as known ids only (they leave the partner's account, not the platform's).
 */
export function expectedFromOps(ops: OpLike[], ledger: LedgerLike[], itemTxnIds: ReadonlyMap<string, readonly string[]> = new Map()): Expected[] {
  /** An item's ids plus the PayPal transaction ids its webhooks named (Transaction Search lists a payout by those). */
  const withTxns = (ids: string[]) => [...new Set([...ids, ...ids.flatMap((id) => itemTxnIds.get(id) ?? [])])];
  const out: Expected[] = [];
  for (const op of ops) {
    const at = op.updatedAt ?? op.createdAt;
    if (op.kind === OP_KINDS.capture && op.paypalId) {
      const b = booked(ledger, (r) => r === op.paypalId, "debit");
      out.push({ kind: "capture", opKey: op.key, ids: [op.paypalId], refIds: [], ledgerMinor: b.minor, currency: b.currency, at, required: op.status === "succeeded" });
    } else if (op.kind === OP_KINDS.refund && op.paypalId) {
      const b = booked(ledger, (r) => r === `refund:${op.key}`, "debit");
      out.push({ kind: "refund", opKey: op.key, ids: [op.paypalId], refIds: [], ledgerMinor: b.minor, currency: b.currency, at, required: op.status === "succeeded" });
    } else if (op.kind === OP_KINDS.payout) {
      const items = asRecord(asRecord(op.response).items);
      const parties = (["freelancer", "partner"] as const).filter((p) => Object.keys(asRecord(items[p])).length > 0);
      const isRelease = (r: string) => r === `release:${op.key}` || r.startsWith(`release:${op.key}:`);
      for (const party of parties) {
        const item = asRecord(items[party]);
        const itemIds = withTxns([...idsIn(item, ITEM_KEYS)]);
        const b = booked(ledger, isRelease, "credit", party === "freelancer" ? isFreelancerAccount : isPartnerAccount);
        // A lone item may be named by its batch id; with two items the batch id cannot tell them apart.
        const refIds = [...itemIds, ...(parties.length === 1 && op.paypalId ? [op.paypalId] : [])];
        out.push({ kind: "payout", opKey: op.key, party, ids: itemIds, refIds, ledgerMinor: b.minor, currency: b.currency, at, required: item.status === "succeeded" && itemIds.length > 0 });
      }
      if (!parties.length && op.paypalId) {
        // No item outcome yet (the webhooks have not settled it): known by batch id, not required.
        const b = booked(ledger, isRelease, "credit", (a) => isFreelancerAccount(a) || isPartnerAccount(a));
        out.push({ kind: "payout", opKey: op.key, ids: [op.paypalId], refIds: [op.paypalId], ledgerMinor: b.minor, currency: b.currency, at, required: false });
      }
    } else if (op.kind === OP_KINDS.advancePayout && (op.paypalId || op.response)) {
      const ids = withTxns([...idsIn(op.response, new Set([...ITEM_KEYS, "payout_batch_id"]))]);
      if (op.paypalId) ids.push(op.paypalId);
      const b = booked(ledger, (r) => r === `advance:${op.key}`, "debit");
      out.push({ kind: "advance-payout", opKey: op.key, ids, refIds: ids, ledgerMinor: b.minor, currency: b.currency, at, required: false });
    }
  }
  return out;
}

// ---------- Matching ----------

/**
 * Transaction Search rows that are not money movements of ours: PayPal holds the payout amount plus fee on the balance
 * (T15xx, "hold on available balance") and releases the hold when the payout goes (T1105, "reversal of general account
 * hold"). Counted as ignored, never as missing.
 */
export function isBalanceHold(eventCode: string | null): boolean {
  return eventCode !== null && (/^T15\d\d$/.test(eventCode) || eventCode === "T1105");
}

export interface ReconcileReport {
  window: ReconcileWindow;
  paypalCount: number;
  matched: number;
  /** Balance holds and their reversals (see isBalanceHold): listed by PayPal, not money movements. */
  ignored: number;
  missingInLedger: Array<{ id: string; referenceId: string | null; eventCode: string | null; at: string | null; amountMinor: number | null; currency: string | null }>;
  missingInPayPal: Array<{ kind: string; opKey: string; party: string | null; ids: string[]; at: string; amountMinor: number | null; currency: string | null }>;
  amountMismatches: Array<{ id: string; kind: string; opKey: string; party: string | null; paypalMinor: number | null; paypalCurrency: string | null; ledgerMinor: number | null; ledgerCurrency: string | null }>;
  counts: { missingInLedger: number; missingInPayPal: number; amountMismatches: number };
}

/**
 * Pure. A PayPal row matches an expectation when its transaction id is one of ours, or (payouts only) its reference id
 * is one of the payout's ids; a refund's reference (the capture id) never matches the capture. A matched row whose
 * absolute amount or currency differs from the ledger's (or with nothing booked yet) is an amount mismatch. A required
 * expectation inside the window that no row matched is missing in PayPal.
 */
export function matchTransactions(window: ReconcileWindow, txns: PayPalTransaction[], expected: Expected[]): ReconcileReport {
  const byId = new Map<string, Expected>();
  const byRef = new Map<string, Expected>();
  for (const e of expected) {
    for (const id of e.ids) if (!byId.has(id)) byId.set(id, e);
    for (const id of e.refIds) if (!byRef.has(id)) byRef.set(id, e);
  }
  const seen = new Set<Expected>();
  const report: ReconcileReport = { window, paypalCount: txns.length, matched: 0, ignored: 0, missingInLedger: [], missingInPayPal: [], amountMismatches: [], counts: { missingInLedger: 0, missingInPayPal: 0, amountMismatches: 0 } };
  const sorted = [...txns].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "") || a.id.localeCompare(b.id));
  for (const t of sorted) {
    const e = byId.get(t.id) ?? (t.referenceId ? byRef.get(t.referenceId) : undefined);
    if (!e && isBalanceHold(t.eventCode)) {
      report.ignored++;
      continue;
    }
    if (!e) {
      report.counts.missingInLedger++;
      if (report.missingInLedger.length < LIST_CAP) report.missingInLedger.push({ id: t.id, referenceId: t.referenceId, eventCode: t.eventCode, at: t.at, amountMinor: t.amountMinor, currency: t.currency });
      continue;
    }
    report.matched++;
    seen.add(e);
    const paypalMinor = t.amountMinor === null ? null : Math.abs(t.amountMinor);
    if (paypalMinor === null || e.ledgerMinor === null || paypalMinor !== e.ledgerMinor || t.currency !== e.currency) {
      report.counts.amountMismatches++;
      if (report.amountMismatches.length < LIST_CAP) report.amountMismatches.push({ id: t.id, kind: e.kind, opKey: e.opKey, party: e.party ?? null, paypalMinor, paypalCurrency: t.currency, ledgerMinor: e.ledgerMinor, ledgerCurrency: e.currency });
    }
  }
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  for (const e of [...expected].sort((a, b) => a.at.getTime() - b.at.getTime() || a.opKey.localeCompare(b.opKey))) {
    const t = e.at.getTime();
    if (!e.required || seen.has(e) || t < start || t > end) continue;
    report.counts.missingInPayPal++;
    if (report.missingInPayPal.length < LIST_CAP) report.missingInPayPal.push({ kind: e.kind, opKey: e.opKey, party: e.party ?? null, ids: e.ids, at: e.at.toISOString(), amountMinor: e.ledgerMinor, currency: e.currency });
  }
  return report;
}

/** Two plain sentences over the counts, the same every time for the same report. */
export function reconcileSummary(r: ReconcileReport, simulated: boolean): string {
  const total = r.counts.missingInLedger + r.counts.missingInPayPal + r.counts.amountMismatches;
  const first = `${simulated ? "The simulator" : "PayPal"} listed ${r.paypalCount} transaction${r.paypalCount === 1 ? "" : "s"} between ${r.window.start} and ${r.window.end}, and ${r.matched} matched Milestone's records${r.ignored ? ` (${r.ignored} balance hold${r.ignored === 1 ? "" : "s"} set aside)` : ""}.`;
  if (total === 0) return `${first} Nothing is missing on either side and every matched amount agrees with the ledger.`;
  const parts = [
    r.counts.missingInLedger ? `${r.counts.missingInLedger} on PayPal with no Milestone record` : "",
    r.counts.missingInPayPal ? `${r.counts.missingInPayPal} recorded by Milestone but not on PayPal` : "",
    r.counts.amountMismatches ? `${r.counts.amountMismatches} with an amount that differs from the ledger` : "",
  ].filter(Boolean);
  return `${first} An operator should check ${parts.join(", ")}.`;
}

// ---------- The run ----------

export type ReconcileOutcome =
  | { kind: "reconciled"; report: ReconcileReport; simulated: boolean; summary: string }
  | { kind: "failed"; window: ReconcileWindow; error: string; body: unknown; code: string | null; status: number | null; simulated: boolean };

export interface RunReconcileOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  window?: { start?: unknown; end?: unknown };
  /** Who asked (an operator's user id, "schedule"); recorded in the audit detail. */
  trigger?: string;
  /** A session to use instead of opening one (tests). It is not closed here. */
  session?: PayPalMcpSession;
}

/** Every page of list_transactions for the window, through the MCP session. */
async function listAll(session: PayPalMcpSession, w: ReconcileWindow): Promise<{ txns: PayPalTransaction[]; pages: number }> {
  const txns: PayPalTransaction[] = [];
  let page = 1;
  let pages = 1;
  for (; page <= MAX_PAGES; page++) {
    const res = await session.callPayPalTool(RECONCILE_TOOL, { start_date: w.start, end_date: w.end, page_size: PAGE_SIZE, page });
    txns.push(...parseTransactions(res.data));
    const total = Number(asRecord(res.data).total_pages);
    pages = Number.isFinite(total) && total > 0 ? total : 1;
    if (page >= pages) break;
  }
  return { txns, pages: Math.min(page, pages) };
}

/** Loads ops and the ledger rows they refer to (ops from 62 days back, so ids made just before the window still match). */
async function loadRecords(db: Db, w: ReconcileWindow): Promise<{ ops: OpLike[]; ledger: LedgerLike[]; itemTxnIds: Map<string, string[]> }> {
  const since = new Date(Date.parse(w.start) - 31 * 24 * HOUR);
  const ops = await db
    .select({ kind: paypalOps.kind, key: paypalOps.key, paypalId: paypalOps.paypalId, status: paypalOps.status, response: paypalOps.response, createdAt: paypalOps.createdAt, updatedAt: paypalOps.updatedAt })
    .from(paypalOps)
    .where(and(inArray(paypalOps.kind, [OP_KINDS.capture, OP_KINDS.refund, OP_KINDS.payout, OP_KINDS.advancePayout]), gte(paypalOps.createdAt, since)));
  const exact = new Set<string>();
  const prefixes = new Set<string>();
  for (const o of ops) {
    if (o.kind === OP_KINDS.capture && o.paypalId) exact.add(o.paypalId);
    if (o.kind === OP_KINDS.refund) exact.add(`refund:${o.key}`);
    if (o.kind === OP_KINDS.advancePayout) exact.add(`advance:${o.key}`);
    if (o.kind === OP_KINDS.payout) {
      exact.add(`release:${o.key}`);
      prefixes.add(`release:${o.key}:%`);
    }
  }
  const conds = [...(exact.size ? [inArray(ledgerEntries.ref, [...exact])] : []), ...[...prefixes].map((p) => like(ledgerEntries.ref, p))];
  const ledger = conds.length
    ? await db.select({ ref: ledgerEntries.ref, account: ledgerEntries.account, direction: ledgerEntries.direction, amountMinor: ledgerEntries.amountMinor, currency: ledgerEntries.currency }).from(ledgerEntries).where(or(...conds))
    : [];
  // Payout item webhooks name the PayPal transaction id Transaction Search lists the payout under; settle keeps only
  // the item id, so the raw events (stored signature-verified and de-duplicated) supply the link.
  const hooks = await db
    .select({ payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(and(like(webhookEvents.type, "PAYMENT.PAYOUTS-ITEM.%"), gte(webhookEvents.receivedAt, since)));
  const itemTxnIds = new Map<string, string[]>();
  for (const h of hooks) {
    const r = asRecord(asRecord(h.payload).resource);
    const item = asString(r.payout_item_id);
    const txn = asString(r.transaction_id);
    if (item && txn) itemTxnIds.set(item, [...new Set([...(itemTxnIds.get(item) ?? []), txn])]);
  }
  return { ops, ledger, itemTxnIds };
}

/** Runs one reconciliation and records it. Never throws for a PayPal failure: that is recorded as ops.reconcile_failed. */
export async function runReconcile(db: Db, opts: RunReconcileOptions = {}): Promise<ReconcileOutcome> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const window = reconcileWindow(now, env, opts.window);
  const base = { via: "paypal_mcp", tool: RECONCILE_TOOL, trigger: opts.trigger ?? null };
  let session = opts.session;
  let simulated = session?.simulated ?? paypalMode(env) === "simulated";
  let fetched: { txns: PayPalTransaction[]; pages: number };
  try {
    session ??= await openPayPalMcp({ env });
    simulated = session.simulated;
    try {
      fetched = await listAll(session, window);
    } finally {
      if (!opts.session) await session.close();
    }
  } catch (e) {
    const err = e instanceof PayPalMcpError ? e : null;
    const error = e instanceof Error ? e.message : String(e);
    const outcome: ReconcileOutcome = { kind: "failed", window, error, body: err?.body ?? null, code: err?.code ?? null, status: err?.status ?? null, simulated };
    await audit(db, { actor: "worker", event: RECONCILE_EVENTS.failed, detail: { ...base, window, simulated, error: error.slice(0, 1000), body: err?.body ?? null, code: outcome.code, status: outcome.status } });
    return outcome;
  }
  const loaded = await loadRecords(db, window);
  const { ledger, itemTxnIds } = loaded;
  // Against the real PayPal, ops the showcase seed recorded with simulator ids were never sent there: matching them
  // would report them missing in PayPal. They are left out and counted (recordedSkipped).
  const ops = simulated ? loaded.ops : loaded.ops.filter((o) => !isRecordedOp(o));
  const recordedSkipped = loaded.ops.length - ops.length;
  const report = matchTransactions(window, fetched.txns, expectedFromOps(ops, ledger, itemTxnIds));
  const summary = reconcileSummary(report, simulated);
  await audit(db, {
    actor: "worker",
    event: RECONCILE_EVENTS.reconciled,
    detail: { ...base, simulated, pages: fetched.pages, ...(recordedSkipped ? { recordedSkipped } : {}), ...report, mismatches: report.counts.missingInLedger + report.counts.missingInPayPal + report.counts.amountMismatches, summary, summarySource: "template" },
  });
  return { kind: "reconciled", report, simulated, summary };
}

/** The "reconcile" job: { start?, end?, trigger? }. Enqueued by POST /api/ops/reconcile. */
export async function reconcile(job: Job<JobData>): Promise<void> {
  const out = await runReconcile(getDb(), { window: { start: job.data.start, end: job.data.end }, trigger: asString(job.data.trigger) ?? "job" });
  if (out.kind === "failed") console.warn(`[reconcile] failed: ${out.error}`);
  else console.log(`[reconcile] ${out.summary}`);
}
