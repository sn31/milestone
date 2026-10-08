import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { auditLog, deliveries, milestones, paypalOps, type Db } from "@milestone/core";

/** Milestone statuses where something moves without the viewer doing anything: the agent, the window, or the client. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["verifying", "review", "needs_client"]);
/** paypal_ops kinds keyed by milestone id whose outcome arrives later (a webhook, the release job). */
const PENDING_KINDS = ["capture", "payout", "refund"];
const PENDING_STATUSES = ["pending", "sent"] as const;
const MAX_EVIDENCE = 40;
const MAX_EVENTS = 40;
const MAX_SUMMARY = 240;

export interface EvidenceLine {
  id: string;
  kind: string;
  status: string | null;
  summary: string;
}

export interface EventLine {
  id: string;
  /** ISO time. */
  at: string;
  event: string;
}

/** What GET /api/milestones/[id]/status returns: everything the contract page shows that can change on its own. */
export interface MilestoneSnapshot {
  id: string;
  status: string;
  /** Still worth polling: a live status, or a PayPal operation still waiting for its outcome. */
  live: boolean;
  decidedAt: string | null;
  reviewEndsAt: string | null;
  delivery: { id: string; receivedAt: string; verifiedAt: string | null; result: string | null; evidenceCount: number } | null;
  /** The latest delivery's evidence summaries, in the order the verifier recorded them. */
  evidence: EvidenceLine[];
  /** Audit events on this milestone since the latest delivery came in (the last few when there is none), oldest first. */
  events: EventLine[];
  /** The newest audit row on this milestone. */
  auditId: string | null;
  /** The newest PayPal operation on this milestone still waiting for its outcome. */
  pendingOp: { kind: string; status: string } | null;
}

type MilestoneRow = Pick<typeof milestones.$inferSelect, "id" | "status" | "decidedAt" | "reviewEndsAt">;
type DeliveryRow = Pick<typeof deliveries.$inferSelect, "id" | "receivedAt" | "verifiedAt" | "result" | "evidence">;
type AuditRow = Pick<typeof auditLog.$inferSelect, "id" | "createdAt" | "event">;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** Normalizes deliveries.evidence into short log lines; unknown shapes are skipped. */
export function evidenceLines(evidence: unknown[] | null | undefined): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const e of evidence ?? []) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const summary = (str(o.summary) ?? "").replace(/\s+/g, " ").trim();
    out.push({
      id: str(o.id) ?? `ev_${out.length}`,
      kind: str(o.kind) ?? "note",
      status: str(o.status),
      summary: summary.length > MAX_SUMMARY ? `${summary.slice(0, MAX_SUMMARY - 1)}…` : summary,
    });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

/** Pure: the snapshot from the rows. `events` newest first, as queried. */
export function toSnapshot(m: MilestoneRow, delivery: DeliveryRow | null, events: AuditRow[], latestAudit: AuditRow | null, op: { kind: string; status: string } | null): MilestoneSnapshot {
  const evidence = evidenceLines(delivery?.evidence);
  return {
    id: m.id,
    status: m.status,
    live: LIVE_STATUSES.has(m.status) || op !== null,
    decidedAt: iso(m.decidedAt),
    reviewEndsAt: iso(m.reviewEndsAt),
    delivery: delivery
      ? { id: delivery.id, receivedAt: delivery.receivedAt.toISOString(), verifiedAt: iso(delivery.verifiedAt), result: delivery.result ?? null, evidenceCount: Array.isArray(delivery.evidence) ? delivery.evidence.length : 0 }
      : null,
    evidence,
    events: [...events].reverse().map((e) => ({ id: e.id, at: e.createdAt.toISOString(), event: e.event })),
    auditId: latestAudit?.id ?? null,
    pendingOp: op,
  };
}

/** Loads one milestone's snapshot, or null when it does not exist. */
export async function loadSnapshot(db: Db, id: string): Promise<MilestoneSnapshot | null> {
  const m = await db.query.milestones.findFirst({ columns: { id: true, status: true, decidedAt: true, reviewEndsAt: true }, where: (t, o) => o.eq(t.id, id) });
  if (!m) return null;
  const [delivery, latest, op] = await Promise.all([
    db.query.deliveries.findFirst({
      columns: { id: true, receivedAt: true, verifiedAt: true, result: true, evidence: true },
      where: (t, o) => o.eq(t.milestoneId, id),
      orderBy: (t, o) => [o.desc(t.receivedAt), o.desc(t.id)],
    }),
    db.select({ id: auditLog.id, createdAt: auditLog.createdAt, event: auditLog.event }).from(auditLog).where(eq(auditLog.milestoneId, id)).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1),
    db
      .select({ kind: paypalOps.kind, status: paypalOps.status })
      .from(paypalOps)
      .where(and(eq(paypalOps.key, id), inArray(paypalOps.kind, PENDING_KINDS), inArray(paypalOps.status, [...PENDING_STATUSES])))
      .orderBy(desc(paypalOps.createdAt))
      .limit(1),
  ]);
  const events = await db
    .select({ id: auditLog.id, createdAt: auditLog.createdAt, event: auditLog.event })
    .from(auditLog)
    .where(delivery ? and(eq(auditLog.milestoneId, id), gte(auditLog.createdAt, delivery.receivedAt)) : eq(auditLog.milestoneId, id))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(MAX_EVENTS);
  return toSnapshot(m, delivery ?? null, events, latest[0] ?? null, op[0] ?? null);
}

/** Of these milestones, the ids with a PayPal operation still waiting for its outcome. */
export async function pendingOpMilestones(db: Db, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ key: paypalOps.key })
    .from(paypalOps)
    .where(and(inArray(paypalOps.key, ids), inArray(paypalOps.kind, PENDING_KINDS), inArray(paypalOps.status, [...PENDING_STATUSES])));
  return new Set(rows.map((r) => r.key));
}
