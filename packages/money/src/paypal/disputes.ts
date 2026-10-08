/**
 * PayPal disputes (week 3, the dispute copilot). PayPal's MCP tools can only list, read and accept disputes, so evidence
 * goes by REST:
 *   GET  /v1/customer/disputes/{id}
 *   POST /v1/customer/disputes/{id}/provide-evidence   multipart: an "input" JSON part + optional file parts
 *   POST /v1/customer/disputes/{id}/accept-claim       JSON { note }
 * Events: CUSTOMER.DISPUTE.CREATED / UPDATED / RESOLVED.
 *
 * Both POSTs carry a PayPal-Request-Id from a paypal_ops row created first: "dispute_evidence" keyed by
 * "<disputeId>:<n>" (n = evidence submissions that already succeeded, so a retry replays and a second round after
 * PayPal asks for more evidence gets a fresh id) and "dispute_accept" keyed by the dispute id.
 *
 * accept-claim makes PayPal refund the buyer from the platform account, so it moves money: the REST call lives in
 * ./money.ts and is reached only through acceptDisputeClaim in ../policy/execute.ts. This module only builds its plan.
 */
import { randomBytes } from "node:crypto";
import { audit, fromPayPalValue, recordOpResult, requestIdFor, type Db } from "@milestone/core";
import { PayPalError, type PayPalClient, type RequestOptions } from "./client.ts";
import type { WebhookEvent } from "./webhooks.ts";

// ---------- Types (the subset of PayPal's dispute resource Milestone reads) ----------

export interface DisputeAmount {
  currency_code: string;
  value: string;
}

export interface Dispute {
  dispute_id: string;
  reason?: string;
  status?: string;
  dispute_state?: string;
  dispute_amount?: DisputeAmount;
  dispute_life_cycle_stage?: string;
  dispute_channel?: string;
  dispute_outcome?: { outcome_code?: string; amount_refunded?: DisputeAmount };
  disputed_transactions?: Array<{ seller_transaction_id?: string; buyer_transaction_id?: string; gross_amount?: DisputeAmount }>;
  messages?: Array<{ posted_by?: string; time_posted?: string; content?: string }>;
  seller_response_due_date?: string;
  create_time?: string;
  update_time?: string;
  links?: Array<{ href: string; rel: string; method?: string }>;
}

/** One entry of provide-evidence's "input.evidences". `documents` names the file parts sent with it. */
export interface Evidence {
  evidence_type: string;
  notes?: string;
  documents?: Array<{ name: string }>;
}

/** A file sent as its own multipart part. */
export interface EvidenceFile {
  name: string;
  bytes: Uint8Array;
  mime: string;
}

/** PayPal's limits for evidence: notes up to 2000 characters, files of these types, 10 MB per file and per request. */
export const EVIDENCE_NOTES_MAX = 2000;
export const EVIDENCE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_TOTAL_MAX_BYTES = 10 * 1024 * 1024;
export const EVIDENCE_FILE_TYPES: ReadonlySet<string> = new Set(["application/pdf", "image/png", "image/jpeg", "image/gif"]);
/** The evidence type for delivered digital work or a service. */
export const SERVICE_EVIDENCE_TYPE = "PROOF_FOR_SOFTWARE_OR_SERVICE_DELIVERED";

const path = (id: string, suffix = "") => `/v1/customer/disputes/${encodeURIComponent(id)}${suffix}`;

// ---------- REST ----------

export async function getDispute(client: PayPalClient, disputeId: string): Promise<Dispute> {
  return client.request<Dispute>("GET", path(disputeId));
}

/** Builds a multipart/form-data body by hand so each part's headers are exactly what PayPal documents. */
export function multipartBody(parts: Array<{ name: string; filename?: string; contentType: string; data: Uint8Array | string }>, boundary = `----milestone${randomBytes(12).toString("hex")}`): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const quote = (s: string) => s.replace(/["\r\n\\]/g, "_");
  for (const p of parts) {
    const disposition = `form-data; name="${quote(p.name)}"${p.filename !== undefined ? `; filename="${quote(p.filename)}"` : ""}`;
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: ${p.contentType}\r\n\r\n`));
    chunks.push(typeof p.data === "string" ? enc.encode(p.data) : p.data);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const body = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The transport the client was built with, so the simulator answers multipart calls too.
 * DESIGN: PayPalClient keeps fetchImpl private and has no multipart helper; a requestMultipart on the client would
 * replace this accessor (client.ts is shared, so it is left alone here).
 */
function transport(client: PayPalClient): typeof fetch {
  return (client as unknown as { fetchImpl?: typeof fetch }).fetchImpl ?? fetch;
}

/** A multipart POST with the client's token, PayPal-Request-Id and error handling. */
export async function requestMultipart<T>(client: PayPalClient, p: string, parts: Parameters<typeof multipartBody>[0], opts: RequestOptions = {}): Promise<T> {
  const { body, contentType } = multipartBody(parts);
  const headers: Record<string, string> = { Authorization: `Bearer ${await client.accessToken()}`, "Content-Type": contentType, ...opts.headers };
  if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
  const res = await transport(client)(`${client.baseUrl}${p}`, { method: "POST", headers, body });
  const text = await res.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) throw new PayPalError(res.status, json, res.headers.get("paypal-debug-id") ?? undefined);
  return json as T;
}

/** POST provide-evidence: the "input" JSON part plus one part per file (named as in evidences[].documents). */
export async function provideEvidence(client: PayPalClient, disputeId: string, input: { evidences: Evidence[]; files?: EvidenceFile[] }, opts: RequestOptions & { requestId: string }): Promise<{ links?: unknown[] }> {
  const evidences = input.evidences.map((e) => ({ ...e, ...(e.notes !== undefined ? { notes: e.notes.slice(0, EVIDENCE_NOTES_MAX) } : {}) }));
  const parts: Parameters<typeof multipartBody>[0] = [{ name: "input", contentType: "application/json", data: JSON.stringify({ evidences }) }];
  for (const f of input.files ?? []) parts.push({ name: f.name, filename: f.name, contentType: f.mime, data: f.bytes });
  return requestMultipart(client, path(disputeId, "/provide-evidence"), parts, opts);
}

// ---------- Events ----------

export interface DisputeEventInfo {
  disputeId: string;
  reason: string | null;
  status: string | null;
  stage: string | null;
  outcome: string | null;
  /** seller_transaction_id of each disputed transaction: our capture id. */
  transactionIds: string[];
  amountMinor: number | null;
  currency: string | null;
  dueAt: string | null;
}

const s = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const o = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Reads a dispute resource (a CUSTOMER.DISPUTE.* event's resource or a GET response). Null without a dispute id. */
export function parseDispute(resource: unknown): DisputeEventInfo | null {
  const r = o(resource);
  const disputeId = s(r.dispute_id);
  if (!disputeId) return null;
  const amount = o(r.dispute_amount);
  const currency = s(amount.currency_code);
  const value = s(amount.value);
  const txns = Array.isArray(r.disputed_transactions) ? r.disputed_transactions : [];
  return {
    disputeId,
    reason: s(r.reason),
    status: s(r.status),
    stage: s(r.dispute_life_cycle_stage),
    outcome: s(o(r.dispute_outcome).outcome_code),
    transactionIds: txns.map((t) => s(o(t).seller_transaction_id)).filter((t): t is string => t !== null),
    amountMinor: currency && value ? fromPayPalValue(value, currency) : null,
    currency,
    dueAt: s(r.seller_response_due_date),
  };
}

export type DisputeEventOutcome =
  | { outcome: "opened"; disputeId: string; milestoneId: string; enqueue: true }
  | { outcome: "updated" | "resolved" | "already"; disputeId: string; milestoneId: string; enqueue: false }
  | { outcome: "unmatched" | "ignored"; disputeId: string | null; enqueue: false };

/** The dispute.opened audit row of a dispute: where every later step finds its milestone and contract. */
export async function findOpenedDispute(db: Db, disputeId: string) {
  return db.query.auditLog.findFirst({
    where: (t, { and, eq, sql }) => and(eq(t.event, "dispute.opened"), sql`${t.detail}->>'disputeId' = ${disputeId}`),
  });
}

/** The audit scope of a dispute's rows: its milestone and contract. */
function scope(milestoneId: string, contractId: string | null): { milestoneId: string; contractId?: string } {
  return contractId ? { milestoneId, contractId } : { milestoneId };
}

async function hasAudit(db: Db, event: string, key: string, value: string): Promise<boolean> {
  const row = await db.query.auditLog.findFirst({
    columns: { id: true },
    where: (t, { and, eq, sql }) => and(eq(t.event, event), sql`${t.detail}->>${key} = ${value}`),
  });
  return Boolean(row);
}

/**
 * The CUSTOMER.DISPUTE.* side of the PayPal webhook, shared by the route and the worker's e2e test. Idempotent: a
 * redelivered event finds its audit row and does nothing.
 * - CREATED: finds the milestone by the disputed transaction id (= milestones.paypal_capture_id), audits
 *   "dispute.opened" with the dispute id and reason, and asks the caller to enqueue the "dispute" job.
 * - UPDATED: audits "dispute.updated" (status, stage) once per event.
 * - RESOLVED: audits "dispute.resolved" with the outcome.
 */
export async function recordDisputeEvent(db: Db, event: WebhookEvent): Promise<DisputeEventOutcome> {
  const info = parseDispute(event.resource);
  if (!info) return { outcome: "ignored", disputeId: null, enqueue: false };
  const { disputeId } = info;
  let opened = await findOpenedDispute(db, disputeId);

  if (!opened) {
    let milestone: { id: string; contractId: string } | undefined;
    for (const captureId of info.transactionIds) {
      milestone = await db.query.milestones.findFirst({ columns: { id: true, contractId: true }, where: (t, { eq }) => eq(t.paypalCaptureId, captureId) });
      if (milestone) break;
    }
    if (!milestone) {
      if (!(await hasAudit(db, "paypal.dispute_unmatched", "eventId", event.id))) {
        await audit(db, { actor: "paypal", event: "paypal.dispute_unmatched", detail: { eventId: event.id, disputeId, eventType: event.event_type, transactionIds: info.transactionIds } });
      }
      return { outcome: "unmatched", disputeId, enqueue: false };
    }
    // Any dispute event can be the first we see (CREATED lost or reordered): open it from whichever arrives.
    await audit(db, {
      actor: "paypal",
      event: "dispute.opened",
      milestoneId: milestone.id,
      contractId: milestone.contractId,
      detail: { disputeId, reason: info.reason, status: info.status, stage: info.stage, amountMinor: info.amountMinor, currency: info.currency, captureId: info.transactionIds[0] ?? null, dueAt: info.dueAt, eventId: event.id },
    });
    opened = await findOpenedDispute(db, disputeId);
    if (!opened?.milestoneId) throw new Error(`dispute ${disputeId}: opened row not found after insert`);
    if (event.event_type !== "CUSTOMER.DISPUTE.RESOLVED") return { outcome: "opened", disputeId, milestoneId: opened.milestoneId, enqueue: true };
  }
  const milestoneId = opened.milestoneId;
  if (!milestoneId) return { outcome: "unmatched", disputeId, enqueue: false };
  const where = scope(milestoneId, opened.contractId);

  if (event.event_type === "CUSTOMER.DISPUTE.RESOLVED") {
    if (await hasAudit(db, "dispute.resolved", "disputeId", disputeId)) return { outcome: "already", disputeId, milestoneId, enqueue: false };
    await audit(db, { actor: "paypal", event: "dispute.resolved", ...where, detail: { disputeId, outcome: info.outcome, status: info.status, amountMinor: info.amountMinor, currency: info.currency, eventId: event.id } });
    return { outcome: "resolved", disputeId, milestoneId, enqueue: false };
  }
  if (event.event_type === "CUSTOMER.DISPUTE.UPDATED") {
    if (await hasAudit(db, "dispute.updated", "eventId", event.id)) return { outcome: "already", disputeId, milestoneId, enqueue: false };
    await audit(db, { actor: "paypal", event: "dispute.updated", ...where, detail: { disputeId, status: info.status, stage: info.stage, eventId: event.id } });
    return { outcome: "updated", disputeId, milestoneId, enqueue: false };
  }
  // A redelivered CREATED: the job may not have run (enqueue failed after the audit), so ask for it again; the job
  // and the queue's dedupe key make the repeat a no-op.
  return { outcome: "opened", disputeId, milestoneId, enqueue: true };
}

// ---------- Open disputes (the release guard) ----------

/**
 * Disputes on this milestone that were opened and not resolved since (a dispute.opened row with no later
 * dispute.resolved for the same dispute id). The release job refuses to pay while any is open.
 */
export async function openDisputesFor(db: Db, milestoneId: string): Promise<string[]> {
  const rows = await db.query.auditLog.findMany({
    columns: { event: true, detail: true, createdAt: true },
    where: (t, { and, eq, inArray }) => and(eq(t.milestoneId, milestoneId), inArray(t.event, ["dispute.opened", "dispute.resolved"])),
  });
  const id = (d: unknown) => s(o(d).disputeId);
  const resolved = rows.filter((r) => r.event === "dispute.resolved");
  const open = rows
    .filter((r) => r.event === "dispute.opened" && id(r.detail) !== null)
    .filter((r) => !resolved.some((x) => id(x.detail) === id(r.detail) && x.createdAt >= r.createdAt))
    .map((r) => id(r.detail)!);
  return [...new Set(open)];
}

// ---------- Responding (the freelancer's two choices) ----------

export interface DisputeActionResult {
  ok: boolean;
  requestId: string;
  error?: string;
  status?: number;
  /** Machine-readable refusal, e.g. "milestone_not_final". */
  reason?: string;
}

/** The evidence op's key for the next submission: the dispute id plus the count of submissions that succeeded. */
export async function evidenceOpKey(db: Db, disputeId: string): Promise<string> {
  const rows = await db.query.auditLog.findMany({
    columns: { id: true },
    where: (t, { and, eq, sql }) => and(eq(t.event, "dispute.evidence_submitted"), sql`${t.detail}->>'disputeId' = ${disputeId}`),
  });
  return `${disputeId}:${rows.length}`;
}

/**
 * Sends the freelancer's response: one evidence entry (the final text as notes, the attached files as documents).
 * The audit row "dispute.evidence_submitted" keeps the text and each file's name, size and sha256. A later round (PayPal
 * asked for more evidence) gets its own PayPal-Request-Id; a retry of the same round reuses the first one.
 */
export async function submitDisputeEvidence(db: Db, client: PayPalClient, input: { disputeId: string; actor: string; text: string; files: Array<EvidenceFile & { sha256?: string }>; skipped?: Array<{ name: string; reason: string }>; evidenceType?: string }): Promise<DisputeActionResult> {
  const opened = await findOpenedDispute(db, input.disputeId);
  if (!opened?.milestoneId) return { ok: false, requestId: "", error: "dispute not found", status: 404 };
  const opKey = await evidenceOpKey(db, input.disputeId);
  const requestId = await requestIdFor(db, "dispute_evidence", opKey);
  const notes = input.text.trim().slice(0, EVIDENCE_NOTES_MAX);
  const evidence: Evidence = { evidence_type: input.evidenceType ?? SERVICE_EVIDENCE_TYPE, notes, ...(input.files.length ? { documents: input.files.map((f) => ({ name: f.name })) } : {}) };
  const where = scope(opened.milestoneId, opened.contractId);
  try {
    const res = await provideEvidence(client, input.disputeId, { evidences: [evidence], files: input.files }, { requestId });
    await recordOpResult(db, requestId, { status: "succeeded", paypalId: input.disputeId, response: res });
    // Two racing submits of one round share the request id (PayPal answers once); only one of them is recorded.
    if (!(await hasAudit(db, "dispute.evidence_submitted", "requestId", requestId))) {
      await audit(db, {
        actor: input.actor,
        event: "dispute.evidence_submitted",
        ...where,
        detail: { disputeId: input.disputeId, requestId, opKey, evidenceType: evidence.evidence_type, text: notes, documents: input.files.map((f) => ({ name: f.name, size: f.bytes.length, mime: f.mime, sha256: f.sha256 ?? null })), skipped: input.skipped ?? [] },
      });
    }
    return { ok: true, requestId };
  } catch (e) {
    // The op row stays pending so a retry reuses the same PayPal-Request-Id.
    const message = e instanceof Error ? e.message : String(e);
    await audit(db, { actor: input.actor, event: "dispute.evidence_failed", ...where, detail: { disputeId: input.disputeId, requestId, error: message.slice(0, 500) } });
    return { ok: false, requestId, error: message, status: e instanceof PayPalError ? 502 : 500 };
  }
}

/** What acceptDisputeClaim (policy/execute.ts) needs: the dispute, its milestone and who gets the refund in the ledger. */
export interface AcceptClaimPlan {
  disputeId: string;
  milestoneId: string;
  contractId: string;
  clientId: string;
  /** What PayPal refunds the buyer, in the contract's currency (never more than the milestone). */
  amountMinor: number;
  currency: string;
  actor: string;
  note: string;
}

/** Milestone states in which the money has left escrow, so an accepted claim cannot also be paid out by a release. */
export const ACCEPT_CLAIM_STATUSES: ReadonlySet<string> = new Set(["released", "partial_released"]);

/**
 * Builds the accept-claim plan, or refuses: 404 for an unknown dispute, 409 "milestone_not_final" while the milestone's
 * money is still held (funded, verifying, review, needs_client, held). Accepting then would refund the buyer while the
 * ledger still holds the money and a release could pay the freelancer too; an operator settles those disputes by hand.
 */
export async function disputeAcceptPlan(db: Db, input: { disputeId: string; actor: string; note: string }): Promise<{ ok: true; plan: AcceptClaimPlan } | { ok: false; status: number; error: string; reason: string }> {
  const opened = await findOpenedDispute(db, input.disputeId);
  if (!opened?.milestoneId) return { ok: false, status: 404, error: "dispute not found", reason: "not_found" };
  const milestoneId = opened.milestoneId;
  const m = await db.query.milestones.findFirst({ columns: { id: true, status: true, amountMinor: true, contractId: true }, where: (t, { eq }) => eq(t.id, milestoneId) });
  const c = m ? await db.query.contracts.findFirst({ columns: { id: true, clientId: true, currency: true }, where: (t, { eq }) => eq(t.id, m.contractId) }) : undefined;
  if (!m || !c) return { ok: false, status: 404, error: "dispute not found", reason: "not_found" };
  if (!ACCEPT_CLAIM_STATUSES.has(m.status)) {
    return { ok: false, status: 409, reason: "milestone_not_final", error: `the milestone is ${m.status}: its money is still in escrow, so the claim cannot be accepted here; an operator settles it` };
  }
  const d = o(opened.detail);
  const disputed = typeof d.amountMinor === "number" && s(d.currency) === c.currency ? d.amountMinor : m.amountMinor;
  return {
    ok: true,
    plan: { disputeId: input.disputeId, milestoneId, contractId: c.id, clientId: c.clientId, amountMinor: Math.min(disputed, m.amountMinor), currency: c.currency, actor: input.actor, note: input.note.slice(0, 2000) },
  };
}
