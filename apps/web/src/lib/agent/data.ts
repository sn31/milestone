// Server only. Reads for the /agents pages: the viewer's mandates and what their agents did (audit rows whose actor
// is agentActor(mandate) for this user). Mandates are created and revoked through /api/agents, never here.
import { and, desc, eq, like } from "drizzle-orm";
import { agentMandates, auditLog, type AgentMandate, type Executor } from "@milestone/core";
import type { MandateSummary } from "./protocol";

export function toSummary(m: AgentMandate): MandateSummary {
  return {
    id: m.id,
    agentName: m.agentName,
    actions: Array.isArray(m.actions) ? [...m.actions] : [],
    approveCapMinor: m.approveCapMinor ?? null,
    currency: m.currency,
    expiresAt: m.expiresAt.toISOString(),
    revokedAt: m.revokedAt ? m.revokedAt.toISOString() : null,
    lastUsedAt: m.lastUsedAt ? m.lastUsedAt.toISOString() : null,
    createdAt: m.createdAt.toISOString(),
  };
}

export type MandateState = "active" | "revoked" | "expired";

export function mandateState(m: Pick<MandateSummary, "revokedAt" | "expiresAt">, now = Date.now()): MandateState {
  if (m.revokedAt && Date.parse(m.revokedAt) <= now) return "revoked";
  if (Date.parse(m.expiresAt) <= now) return "expired";
  return "active";
}

export async function loadMandates(db: Executor, userId: string): Promise<MandateSummary[]> {
  const rows = await db.select().from(agentMandates).where(eq(agentMandates.userId, userId)).orderBy(desc(agentMandates.createdAt));
  return rows.map(toSummary);
}

export interface AgentAuditRow {
  id: string;
  createdAt: string;
  actor: string;
  event: string;
  contractId: string | null;
  milestoneId: string | null;
  detail: Record<string, unknown>;
}

/** Audit rows written by this user's agents, newest first. The actor is "agent:<name> for <userId>". */
export async function loadAgentAudit(db: Executor, userId: string, limit = 40): Promise<AgentAuditRow[]> {
  const suffix = ` for ${userId}`.replace(/[\\%_]/g, (c) => `\\${c}`);
  const rows = await db
    .select()
    .from(auditLog)
    .where(and(like(auditLog.actor, "agent:%"), like(auditLog.actor, `%${suffix}`)))
    .orderBy(desc(auditLog.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.createdAt.toISOString(),
    actor: r.actor,
    event: r.event,
    contractId: r.contractId,
    milestoneId: r.milestoneId,
    detail: r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {},
  }));
}

/** The agent's name from an audit actor ("agent:Casey's agent for usr_client" -> "Casey's agent"). */
export function agentNameOf(actor: string): string {
  const m = /^agent:(.*) for [^ ]+$/.exec(actor);
  return m ? m[1]! : actor.replace(/^agent:/, "");
}
