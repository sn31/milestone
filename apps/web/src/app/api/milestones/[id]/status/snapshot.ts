import { and, asc, desc, inArray, lte, sql } from "drizzle-orm";
import { OP_KINDS, asRecord, auditLog, deliveries, milestones, paypalOps, type Executor } from "@milestone/core";
import { awaitingVerdict } from "../../../../../components/live-rules";

/** Milestone statuses where something moves without the viewer doing anything: the agent, the window, or the client. */
export const LIVE_STATUSES: ReadonlySet<string> = new Set(["verifying", "review", "needs_client"]);
/**
 * Statuses where the next move is a delivery from the other party: watched too, at a slower pace (see LiveRefresh),
 * so a client page opened before the freelancer delivers sees the delivery arrive and the agent start checking.
 */
export const WATCH_STATUSES: ReadonlySet<string> = new Set(["funded", "held"]);
/** paypal_ops kinds keyed by milestone id whose outcome arrives later (a webhook, the release job). */
const PENDING_KINDS = [OP_KINDS.capture, OP_KINDS.payout, OP_KINDS.refund];
const PENDING_STATUSES = ["pending", "sent"] as const;
const MAX_EVIDENCE = 40;
const MAX_EVENTS = 40;
const MAX_SUMMARY = 240;
/**
 * The baseline-suite item (evd_tamper_check, BASELINE_EVIDENCE_ID in lines.ts) gets more room: its summary names the
 * files the client's suite restored and removed, and the first-parent wording alone takes about 150 characters, so at
 * 240 the demo's m1-pass log line was cut mid-file-name. The verifier already caps its file lists (capList).
 */
const MAX_BASELINE_SUMMARY = 600;
/** Evidence summaries are cut to this many characters in SQL, before transfer (evidenceLines then caps them at MAX_SUMMARY). */
const MAX_SUMMARY_RAW = 2048;

export interface EvidenceLine {
  id: string;
  kind: string;
  status: string | null;
  summary: string;
  /** The criterion this item settles, or null for context (diff, tree, commit text, a delivered file). */
  criterionId: string | null;
}

/** How the verdict judged one criterion (no rationale: the receipt prints that once the page re-renders). */
export interface JudgedLine {
  criterionId: string;
  status: string;
  confidence: number | null;
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
  /** Still worth polling: a live status, a PayPal operation still waiting for its outcome, or a delivery awaiting its verdict. */
  live: boolean;
  decidedAt: string | null;
  reviewEndsAt: string | null;
  delivery: {
    id: string;
    receivedAt: string;
    verifiedAt: string | null;
    result: string | null;
    evidenceCount: number;
    /** Who judged it: a model id, or "deterministic-only" when no model was reachable (checks only). */
    model?: string | null;
    /** The verdict's criteria, once stored. */
    judged?: JudgedLine[];
  } | null;
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
/** `evidence` may be trimmed (the loader sends only the first MAX_EVIDENCE items); `evidenceCount` is then the full count. */
type DeliveryRow = Pick<typeof deliveries.$inferSelect, "id" | "receivedAt" | "verifiedAt" | "result" | "evidence"> & { evidenceCount?: number; model?: string | null; judged?: unknown };
type AuditRow = Pick<typeof auditLog.$inferSelect, "id" | "createdAt" | "event">;

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

const cap = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Normalizes deliveries.evidence into short log lines; unknown shapes are skipped. */
export function evidenceLines(evidence: unknown[] | null | undefined): EvidenceLine[] {
  const out: EvidenceLine[] = [];
  for (const e of evidence ?? []) {
    if (!e || typeof e !== "object") continue;
    const o = asRecord(e);
    const str = (v: unknown) => (typeof v === "string" ? v : null);
    const summary = (str(o.summary) ?? "").replace(/\s+/g, " ").trim();
    out.push({
      id: str(o.id) ?? `ev_${out.length}`,
      kind: str(o.kind) ?? "note",
      status: str(o.status),
      summary: cap(summary, str(o.id) === "evd_tamper_check" ? MAX_BASELINE_SUMMARY : MAX_SUMMARY),
      criterionId: str(o.criterion_id),
    });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

/** The verdict's criteria as stored (criterion_id, status, confidence), or the trimmed list the loader selects; unknown shapes are skipped. */
export function judgedLines(raw: unknown): JudgedLine[] {
  const list = Array.isArray(raw) ? raw : Array.isArray(asRecord(raw).criteria) ? (asRecord(raw).criteria as unknown[]) : [];
  const out: JudgedLine[] = [];
  for (const c of list) {
    const o = asRecord(c);
    const id = typeof o.criterion_id === "string" ? o.criterion_id : typeof o.id === "string" ? o.id : null;
    if (!id || typeof o.status !== "string") continue;
    out.push({ criterionId: id, status: o.status, confidence: typeof o.confidence === "number" ? o.confidence : null });
    if (out.length >= MAX_EVIDENCE) break;
  }
  return out;
}

/** Pure: the snapshot from the rows. `events` newest first, as queried. */
export function toSnapshot(m: MilestoneRow, delivery: DeliveryRow | null, events: AuditRow[], latestAudit: AuditRow | null, op: { kind: string; status: string } | null, now: number = Date.now()): MilestoneSnapshot {
  const evidence = evidenceLines(delivery?.evidence);
  return {
    id: m.id,
    status: m.status,
    // A delivery awaiting its verdict counts whatever the status: right after Deliver the milestone is still funded or held.
    live: LIVE_STATUSES.has(m.status) || WATCH_STATUSES.has(m.status) || op !== null || awaitingVerdict(delivery, now),
    decidedAt: iso(m.decidedAt),
    reviewEndsAt: iso(m.reviewEndsAt),
    delivery: delivery
      ? {
          id: delivery.id,
          receivedAt: delivery.receivedAt.toISOString(),
          verifiedAt: iso(delivery.verifiedAt),
          result: delivery.result ?? null,
          evidenceCount: delivery.evidenceCount ?? (Array.isArray(delivery.evidence) ? delivery.evidence.length : 0),
          model: delivery.model ?? null,
          judged: judgedLines(delivery.judged),
        }
      : null,
    evidence,
    events: [...events].reverse().map((e) => ({ id: e.id, at: e.createdAt.toISOString(), event: e.event })),
    auditId: latestAudit?.id ?? null,
    pendingOp: op,
  };
}

/**
 * deliveries.evidence trimmed in SQL: the first MAX_EVIDENCE object items, each reduced to its string id, kind, status
 * and (capped) summary. Anything else reads as null, which evidenceLines treats exactly as it treats the full row.
 */
const trimmedEvidence = sql<unknown[]>`(
  select coalesce(jsonb_agg(t.o order by t.ord), '[]'::jsonb) from (
    select jsonb_build_object(
      'id', case when jsonb_typeof(x.e->'id') = 'string' then x.e->'id' end,
      'kind', case when jsonb_typeof(x.e->'kind') = 'string' then x.e->'kind' end,
      'status', case when jsonb_typeof(x.e->'status') = 'string' then x.e->'status' end,
      'summary', case when jsonb_typeof(x.e->'summary') = 'string' then to_jsonb(left(x.e->>'summary', ${MAX_SUMMARY_RAW})) end,
      'criterion_id', case when jsonb_typeof(x.e->'criterion_id') = 'string' then x.e->'criterion_id' end
    ) as o, x.ord
    from jsonb_array_elements(case when jsonb_typeof(${deliveries.evidence}) = 'array' then ${deliveries.evidence} else '[]'::jsonb end) with ordinality as x(e, ord)
    where jsonb_typeof(x.e) = 'object'
    order by x.ord
    limit ${MAX_EVIDENCE}
  ) t
)`;
/** The verdict's criteria reduced to id, status and confidence (no rationales), in verdict order. */
const judgedCriteria = sql<unknown[]>`(
  select coalesce(jsonb_agg(jsonb_build_object('criterion_id', x.c->'criterion_id', 'status', x.c->'status', 'confidence', x.c->'confidence') order by x.ord), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(${deliveries.verdict}->'criteria') = 'array' then ${deliveries.verdict}->'criteria' else '[]'::jsonb end) with ordinality as x(c, ord)
  where jsonb_typeof(x.c) = 'object'
)`;
const evidenceCount = sql<number>`case when jsonb_typeof(${deliveries.evidence}) = 'array' then jsonb_array_length(${deliveries.evidence}) else 0 end`;

/**
 * Snapshots of these milestones (missing ids are left out), with one query per table, all in parallel: the milestones,
 * each one's latest delivery (DISTINCT ON, evidence trimmed in SQL), each one's newest MAX_EVENTS audit rows (flagged
 * when at or after its latest delivery came in) and each one's newest PayPal operation still in flight (DISTINCT ON).
 */
export async function loadSnapshots(db: Executor, ids: readonly string[]): Promise<Map<string, MilestoneSnapshot>> {
  const out = new Map<string, MilestoneSnapshot>();
  const want = [...new Set(ids)];
  if (want.length === 0) return out;

  const ranked = db
    .select({
      id: auditLog.id,
      milestoneId: auditLog.milestoneId,
      createdAt: auditLog.createdAt,
      event: auditLog.event,
      rn: sql<number>`row_number() over (partition by ${auditLog.milestoneId} order by ${auditLog.createdAt} desc, ${auditLog.id} desc)`.as("rn"),
      // At or after the latest delivery's arrival (the latest delivery's received_at is the max); true without one.
      // Spelled out: inside .as() subqueries drizzle drops table qualifiers, and a bare milestone_id would bind to d.
      sinceDelivery: sql<boolean>`coalesce("audit_log"."created_at" >= (select max(d.created_at) from "deliveries" d where d.milestone_id = "audit_log"."milestone_id"), true)`.as("since_delivery"),
    })
    .from(auditLog)
    .where(inArray(auditLog.milestoneId, want))
    .as("ranked");

  const [ms, ds, audits, ops] = await Promise.all([
    db.select({ id: milestones.id, status: milestones.status, decidedAt: milestones.decidedAt, reviewEndsAt: milestones.reviewEndsAt }).from(milestones).where(inArray(milestones.id, want)),
    db
      .selectDistinctOn([deliveries.milestoneId], { milestoneId: deliveries.milestoneId, id: deliveries.id, receivedAt: deliveries.receivedAt, verifiedAt: deliveries.verifiedAt, result: deliveries.result, evidence: trimmedEvidence, evidenceCount, model: deliveries.model, judged: judgedCriteria })
      .from(deliveries)
      .where(inArray(deliveries.milestoneId, want))
      .orderBy(deliveries.milestoneId, desc(deliveries.receivedAt), desc(deliveries.id)),
    db.select().from(ranked).where(lte(ranked.rn, MAX_EVENTS)).orderBy(ranked.milestoneId, asc(ranked.rn)),
    db
      .selectDistinctOn([paypalOps.key], { key: paypalOps.key, kind: paypalOps.kind, status: paypalOps.status })
      .from(paypalOps)
      .where(and(inArray(paypalOps.key, want), inArray(paypalOps.kind, PENDING_KINDS), inArray(paypalOps.status, [...PENDING_STATUSES])))
      .orderBy(paypalOps.key, desc(paypalOps.createdAt)),
  ]);

  const delivery = new Map(ds.map((d) => [d.milestoneId, d]));
  const op = new Map(ops.map((o) => [o.key, { kind: o.kind, status: o.status }]));
  const rows = new Map<string, typeof audits>();
  for (const r of audits) {
    if (!r.milestoneId) continue;
    const list = rows.get(r.milestoneId);
    if (list) list.push(r);
    else rows.set(r.milestoneId, [r]);
  }
  const byId = new Map(ms.map((m) => [m.id, m]));
  for (const id of want) {
    const m = byId.get(id);
    if (!m) continue;
    const events = rows.get(id) ?? [];
    out.set(id, toSnapshot(m, delivery.get(id) ?? null, events.filter((e) => e.sinceDelivery), events[0] ?? null, op.get(id) ?? null));
  }
  return out;
}

/** Loads one milestone's snapshot, or null when it does not exist. */
export async function loadSnapshot(db: Executor, id: string): Promise<MilestoneSnapshot | null> {
  return (await loadSnapshots(db, [id])).get(id) ?? null;
}
