import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { AUDIT_EVENTS, audit, contracts, criteria, criteriaVersion, milestones } from "@milestone/core";
import { getDb } from "@/lib/db";
import { jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";

/**
 * The client or the freelancer approves the drafted contract. A repeat approval is a no-op (no second audit row);
 * the contract becomes active exactly once, when the second approval lands.
 *
 * Lock check: the approval holds the contract row lock that criteria edits take, so an edit and an approval never
 * interleave. When the form carries `criteriaVersion` (the fingerprint of the checks the page showed) and the criteria
 * have changed since, nothing is recorded and the page reloads with the current checks to read before signing.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (actor.role !== "client" && actor.role !== "freelancer") return jsonError("only the client or freelancer can approve", 403);
  const form = await req.formData().catch(() => null);
  const seen = form?.get("criteriaVersion");

  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const [contract] = await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, id)).for("update");
    if (!contract) return "missing" as const;
    if (typeof seen === "string" && seen) {
      const ms = await tx.select({ id: milestones.id }).from(milestones).where(eq(milestones.contractId, id));
      const rows = ms.length ? await tx.select().from(criteria).where(inArray(criteria.milestoneId, ms.map((m) => m.id))) : [];
      if (criteriaVersion(rows) !== seen) return "stale" as const;
    }

    // Only the first approval sets the time and writes the audit row.
    const col = actor.role === "client" ? contracts.clientApprovedAt : contracts.freelancerApprovedAt;
    const first = await tx
      .update(contracts)
      .set(actor.role === "client" ? { clientApprovedAt: new Date() } : { freelancerApprovedAt: new Date() })
      .where(and(eq(contracts.id, id), isNull(col)))
      .returning({ id: contracts.id });
    if (first.length) await audit(tx, { actor: actor.userId, event: `contract.approved_by_${actor.role}`, contractId: id });

    const activated = await tx
      .update(contracts)
      .set({ status: "active" })
      .where(and(eq(contracts.id, id), eq(contracts.status, "draft"), isNotNull(contracts.clientApprovedAt), isNotNull(contracts.freelancerApprovedAt)))
      .returning({ id: contracts.id });
    if (activated.length) await audit(tx, { actor: actor.userId, event: AUDIT_EVENTS.contractApproved, contractId: id });
    return "ok" as const;
  });
  if (result === "missing") return jsonError("contract not found", 404);

  return NextResponse.redirect(new URL(`/contracts/${id}`, req.url), 303);
}
