import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Executor } from "./db.ts";
import { paypalOps, webhookEvents } from "./schema.ts";

/** paypal_ops.kind values. The strings are stored; never change one. */
export const OP_KINDS = {
  capture: "capture",
  order: "order",
  payout: "payout",
  refund: "refund",
  invoice: "invoice",
  advancePayout: "advance-payout",
  disputeEvidence: "dispute_evidence",
  disputeAccept: "dispute_accept",
} as const;
export type OpKind = (typeof OP_KINDS)[keyof typeof OP_KINDS];

export type OpRow = typeof paypalOps.$inferSelect;

/**
 * Idempotency: one paypal_ops row per (kind, key). The row's request_id becomes PayPal-Request-Id,
 * so a retried job reuses the same id and PayPal returns the original result instead of paying again.
 */
export async function requestIdFor(db: Executor, kind: string, key: string): Promise<string> {
  const existing = await db.select({ requestId: paypalOps.requestId }).from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key))).limit(1);
  if (existing[0]) return existing[0].requestId;
  const requestId = randomUUID();
  await db.insert(paypalOps).values({ id: randomUUID(), kind, key, requestId }).onConflictDoNothing();
  const row = await db.select({ requestId: paypalOps.requestId }).from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key))).limit(1);
  return row[0]?.requestId ?? requestId;
}

/**
 * Claims the (kind, key) op before a PayPal call: inserts it as "sent" with `request`, or moves a never-sent
 * "pending" row (made by requestIdFor) to "sent" with `request`. A row in any other status is left as it is. The
 * request id of an existing row is kept, so a retry replays the same PayPal-Request-Id. Returns the row as it now
 * stands; the caller decides whether it owns it (status "sent" and its own request, or e.g. "succeeded" already).
 * Run on the pool (not inside the caller's transaction) when the claim must survive a rollback.
 */
export async function claimOp(q: Executor, kind: string, key: string, request: Record<string, unknown>, now: Date = new Date()): Promise<OpRow> {
  await q
    .insert(paypalOps)
    .values({ id: randomUUID(), kind, key, requestId: randomUUID(), status: "sent", request, updatedAt: now })
    .onConflictDoUpdate({ target: [paypalOps.kind, paypalOps.key], set: { status: "sent", request, updatedAt: now }, setWhere: eq(paypalOps.status, "pending") });
  const [row] = await q.select().from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key)));
  if (!row) throw new Error(`could not claim ${kind} op ${key}`);
  return row;
}

export async function recordOpResult(db: Executor, requestId: string, result: { status: "succeeded" | "failed"; paypalId?: string; response?: unknown }) {
  await db.update(paypalOps).set({ status: result.status, paypalId: result.paypalId ?? null, response: result.response ?? null, updatedAt: new Date() }).where(eq(paypalOps.requestId, requestId));
}

/** Returns false when this event was already stored, so the caller can drop the duplicate. */
export async function storeWebhookOnce(db: Executor, input: { source: "paypal" | "github"; eventId: string; type: string; payload: unknown }): Promise<boolean> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ id: randomUUID(), source: input.source, eventId: input.eventId, type: input.type, payload: input.payload })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  return inserted.length > 0;
}

/**
 * Stamps processed_at on a stored webhook event, by its row id or by (source, event id). Only the first stamp sticks
 * (a row already processed keeps its time); readers only ask whether processed_at is set.
 */
export async function markWebhookProcessed(q: Executor, which: { id: string } | { source: "paypal" | "github"; eventId: string }, at: Date = new Date()): Promise<void> {
  const row = "id" in which ? eq(webhookEvents.id, which.id) : and(eq(webhookEvents.source, which.source), eq(webhookEvents.eventId, which.eventId));
  await q.update(webhookEvents).set({ processedAt: at }).where(and(row, isNull(webhookEvents.processedAt)));
}
