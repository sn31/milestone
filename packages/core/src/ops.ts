import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.ts";
import { paypalOps, webhookEvents } from "./schema.ts";

/**
 * Idempotency: one paypal_ops row per (kind, key). The row's request_id becomes PayPal-Request-Id,
 * so a retried job reuses the same id and PayPal returns the original result instead of paying again.
 */
export async function requestIdFor(db: Db, kind: string, key: string): Promise<string> {
  const existing = await db.select({ requestId: paypalOps.requestId }).from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key))).limit(1);
  if (existing[0]) return existing[0].requestId;
  const requestId = randomUUID();
  await db.insert(paypalOps).values({ id: randomUUID(), kind, key, requestId }).onConflictDoNothing();
  const row = await db.select({ requestId: paypalOps.requestId }).from(paypalOps).where(and(eq(paypalOps.kind, kind), eq(paypalOps.key, key))).limit(1);
  return row[0]?.requestId ?? requestId;
}

export async function recordOpResult(db: Db, requestId: string, result: { status: "succeeded" | "failed"; paypalId?: string; response?: unknown }) {
  await db.update(paypalOps).set({ status: result.status, paypalId: result.paypalId ?? null, response: result.response ?? null, updatedAt: new Date() }).where(eq(paypalOps.requestId, requestId));
}

/** Returns false when this event was already stored, so the caller can drop the duplicate. */
export async function storeWebhookOnce(db: Db, input: { source: "paypal" | "github"; eventId: string; type: string; payload: unknown }): Promise<boolean> {
  const inserted = await db
    .insert(webhookEvents)
    .values({ id: randomUUID(), source: input.source, eventId: input.eventId, type: input.type, payload: input.payload })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id });
  return inserted.length > 0;
}
