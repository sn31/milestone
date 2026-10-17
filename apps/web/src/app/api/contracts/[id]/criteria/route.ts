import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  CRITERIA_AUDIT,
  CriteriaEditBody,
  applyCriteriaOps,
  audit,
  contracts,
  criteria,
  criteriaLock,
  milestones,
  validateCriteriaEdit,
  type CriteriaEditError,
  type EditableCriterion,
} from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor, isContractClient, isContractFreelancer } from "@/lib/session";

type Outcome =
  | { status: 200; body: { ok: true; milestoneId: string; criteria: EditableCriterion[]; approvalsCleared: boolean; changed: boolean } }
  | { status: 403 | 404; error: string }
  | { status: 409; error: "contract_locked"; reason: string }
  | { status: 422; error: "invalid_criteria"; errors: CriteriaEditError[] };

const view = (c: typeof criteria.$inferSelect): EditableCriterion => ({ id: c.id, milestoneId: c.milestoneId, kind: c.kind, description: c.description, spec: c.spec ?? {}, required: c.required });

/**
 * PATCH /api/contracts/[id]/criteria: either party proposes an edit to one milestone's release conditions while the
 * contract is a draft. Body: { milestoneId, operations: [{ op: "add" | "remove" | "update" | "reorder", ... }] } or a
 * single operation inline. The contract row is locked for the edit (the approve route takes the same lock), the result
 * is validated with the compiler's rules, and every accepted edit is audited with the criteria before and after. An
 * edit after one party approved clears both approvals. Once both approved, or any milestone is funded: 409 contract_locked.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const raw = await req.json().catch(() => undefined);
  const parsed = CriteriaEditBody.safeParse(raw);
  if (!parsed.success) return jsonError("expected { milestoneId, operations: [{ op: add | remove | update | reorder, ... }] }", 400);
  const { milestoneId, operations } = parsed.data;
  const actor = await getActor();

  const outcome = await getDb().transaction(async (tx): Promise<Outcome> => {
    const [contract] = await tx.select().from(contracts).where(eq(contracts.id, id)).for("update");
    if (!contract) return { status: 404, error: "contract not found" };
    if (!isContractClient(actor, contract) && !isContractFreelancer(actor, contract)) return { status: 403, error: "only the contract's client or freelancer can edit its criteria" };
    const ms = await tx.select({ id: milestones.id, seq: milestones.seq, status: milestones.status, contractId: milestones.contractId }).from(milestones).where(eq(milestones.contractId, id));
    if (!ms.some((m) => m.id === milestoneId)) return { status: 404, error: "milestone not found on this contract" };
    const locked = criteriaLock(contract, ms);
    if (locked) return { status: 409, error: "contract_locked", reason: locked };

    const all = (await tx.select().from(criteria).where(inArray(criteria.milestoneId, ms.map((m) => m.id)))).map(view);
    const before = all.filter((c) => c.milestoneId === milestoneId);
    const applied = applyCriteriaOps(milestoneId, before, operations, () => `crt_${randomUUID()}`);
    if (!applied.ok) return { status: 422, error: "invalid_criteria", errors: applied.errors };
    const after = applied.criteria;
    const valid = validateCriteriaEdit(contract, ms, [...all.filter((c) => c.milestoneId !== milestoneId), ...after]);
    if (!valid.ok) return { status: 422, error: "invalid_criteria", errors: valid.errors };

    // Nothing changed (a save with the same words): no rewrite, no audit, approvals stand.
    if (JSON.stringify(before) === JSON.stringify(after)) return { status: 200, body: { ok: true, milestoneId, criteria: after, approvalsCleared: false, changed: false } };

    // Rewrite the milestone's rows in the edited order (ids kept): the list order is the insertion order.
    await tx.delete(criteria).where(eq(criteria.milestoneId, milestoneId));
    if (after.length) await tx.insert(criteria).values(after.map((c) => ({ id: c.id, milestoneId, kind: c.kind as typeof criteria.$inferInsert.kind, description: c.description, spec: c.spec, required: c.required })));
    // Every milestone keeps a deterministic check (validated above), so it stays eligible for an advance.
    await tx.update(milestones).set({ advanceEligible: true }).where(eq(milestones.id, milestoneId));

    const approvalsCleared = contract.clientApprovedAt !== null || contract.freelancerApprovedAt !== null;
    if (approvalsCleared) {
      await tx.update(contracts).set({ clientApprovedAt: null, freelancerApprovedAt: null }).where(eq(contracts.id, id));
      await audit(tx, {
        actor: actor.userId,
        event: CRITERIA_AUDIT.approvalsCleared,
        contractId: id,
        milestoneId,
        detail: { by: actor.role, clientApprovedAt: contract.clientApprovedAt?.toISOString() ?? null, freelancerApprovedAt: contract.freelancerApprovedAt?.toISOString() ?? null },
      });
    }
    await audit(tx, { actor: actor.userId, event: CRITERIA_AUDIT.edited, contractId: id, milestoneId, detail: { by: actor.role, operations, before, after, approvalsCleared } });
    return { status: 200, body: { ok: true, milestoneId, criteria: after, approvalsCleared, changed: true } };
  });

  if (outcome.status === 200) return json(outcome.body);
  if (outcome.status === 409) return jsonError(outcome.error, 409, { reason: outcome.reason });
  if (outcome.status === 422) return jsonError(outcome.error, 422, { errors: outcome.errors });
  return jsonError(outcome.error, outcome.status);
}
