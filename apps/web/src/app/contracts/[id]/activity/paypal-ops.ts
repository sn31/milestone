import { and, inArray, like, or, sql } from "drizzle-orm";
import { advances, paypalOps, type Db } from "@milestone/core";

/** What a contract's paypal_ops rows are keyed by (see requestIdFor callers in packages/money and the routes). */
export interface OpScope {
  /** order, capture, payout, refund, invoice: keyed by the milestone id. */
  milestoneIds: readonly string[];
  /** advance-payout: keyed by the advance id. */
  advanceIds: readonly string[];
  /** dispute_accept: keyed by the dispute id; dispute_evidence: by "<dispute id>:<round>". */
  disputeIds: readonly string[];
}

/** The dispute id a dispute_* op key names: "<dispute id>" or "<dispute id>:<round>". */
export const disputeOfKey = (key: string) => key.replace(/:\d+$/, "");

/** Pure: whether one paypal_ops row belongs to the contract described by `scope`. */
export function opBelongsTo(op: { kind: string; key: string }, scope: OpScope): boolean {
  if (op.kind === "advance-payout") return scope.advanceIds.includes(op.key);
  if (op.kind.startsWith("dispute_")) return scope.disputeIds.includes(disputeOfKey(op.key));
  return scope.milestoneIds.includes(op.key);
}

/** Dispute ids named by a contract's audit rows (every dispute.* row carries detail.disputeId). */
export function disputeIdsOf(rows: ReadonlyArray<{ event: string; detail: unknown }>): string[] {
  const ids = new Set<string>();
  for (const r of rows) {
    if (!r.event.startsWith("dispute.")) continue;
    const id = r.detail && typeof r.detail === "object" ? (r.detail as { disputeId?: unknown }).disputeId : undefined;
    if (typeof id === "string" && id) ids.add(id);
  }
  return [...ids];
}

/**
 * The PayPal calls made for a contract: every paypal_ops row (one per PayPal-Request-Id) for its milestones' orders,
 * captures, payouts, refunds and invoices, its advances' payouts and its disputes' evidence and accept calls.
 */
export async function countContractOps(db: Db, input: { milestoneIds: string[]; disputeIds: string[] }): Promise<number> {
  if (input.milestoneIds.length === 0) return 0;
  const adv = await db.select({ id: advances.id }).from(advances).where(inArray(advances.milestoneId, input.milestoneIds));
  const scope: OpScope = { milestoneIds: input.milestoneIds, advanceIds: adv.map((a) => a.id), disputeIds: input.disputeIds };
  const keys = [...scope.milestoneIds, ...scope.advanceIds, ...scope.disputeIds];
  const rows = await db
    .select({ kind: paypalOps.kind, key: paypalOps.key })
    .from(paypalOps)
    .where(
      scope.disputeIds.length
        ? or(inArray(paypalOps.key, keys), and(like(paypalOps.kind, "dispute\\_%"), inArray(sql`regexp_replace(${paypalOps.key}, ':[0-9]+$', '')`, [...scope.disputeIds])))
        : inArray(paypalOps.key, keys),
    );
  return rows.filter((r) => opBelongsTo(r, scope)).length;
}
