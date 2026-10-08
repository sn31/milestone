import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { Db } from "./db.js";
import { auditLog, milestones } from "./schema.js";
import type { MilestoneStatus } from "./schemas.js";

/** Legal transitions from the Implementation tab's state diagram. */
export const TRANSITIONS: Record<MilestoneStatus, readonly MilestoneStatus[]> = {
  draft: ["funded"],
  funded: ["verifying"],
  verifying: ["review", "held", "needs_client"],
  review: ["released", "held"],
  held: ["verifying"],
  needs_client: ["released", "partial_released", "held"],
  released: [],
  partial_released: [],
};

export interface AuditInput {
  actor: string; // "system", "verifier", "policy", "paypal", or a user id
  event: string; // e.g. "milestone.funded", "verdict.stored", "policy.decided", "paypal.payout"
  detail?: unknown;
  contractId?: string;
  milestoneId?: string;
}

export async function audit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditLog).values({
    id: randomUUID(),
    actor: input.actor,
    event: input.event,
    detail: input.detail ?? null,
    contractId: input.contractId ?? null,
    milestoneId: input.milestoneId ?? null,
  });
}

/**
 * Moves a milestone to `to`, refusing illegal transitions, and writes the audit entry in the same call.
 * Idempotent: if the milestone is already in `to`, nothing happens and false is returned.
 */
export async function transition(db: Db, milestoneId: string, to: MilestoneStatus, entry: Omit<AuditInput, "milestoneId" | "contractId">): Promise<boolean> {
  const [m] = await db.select({ status: milestones.status, contractId: milestones.contractId }).from(milestones).where(eq(milestones.id, milestoneId)).limit(1);
  if (!m) throw new Error(`milestone ${milestoneId} not found`);
  if (m.status === to) return false;
  if (!TRANSITIONS[m.status].includes(to)) throw new Error(`illegal transition ${m.status} -> ${to} for milestone ${milestoneId}`);
  await db.update(milestones).set({ status: to }).where(eq(milestones.id, milestoneId));
  await audit(db, { ...entry, milestoneId, contractId: m.contractId, detail: { from: m.status, to, ...(entry.detail && typeof entry.detail === "object" ? entry.detail : { note: entry.detail }) } });
  return true;
}
