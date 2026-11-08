import { NextResponse } from "next/server";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { AUDIT_EVENTS, AUP_REFUSAL_TEXT, audit, auditAupRefusal, aupGateNow, contracts, criteria, criteriaVersion, milestones, type AupRefusal } from "@milestone/core";
import { ensureAup } from "@/lib/aup";
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
 *
 * PayPal Acceptable Use Policy gate: neither party can sign while the contract's check is not clear, keywords only or
 * cleared by an operator (aupGateNow, under the same lock). A refusal is audited (aup.refused) and answered 409 with
 * the reason; a browser form post is sent back to the contract page, which shows the check.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  if (actor.role !== "client" && actor.role !== "freelancer") return jsonError("only the client or freelancer can approve", 403);
  const form = await req.formData().catch(() => null);
  const seen = form?.get("criteriaVersion");

  const db = getDb();
  // A text with no check yet (never checked, or edited since) gets one now; the gate below reads the result.
  await ensureAup(db, id, actor.userId);
  const result = await db.transaction(async (tx): Promise<"missing" | "stale" | "ok" | { aup: AupRefusal }> => {
    const [contract] = await tx.select({ id: contracts.id }).from(contracts).where(eq(contracts.id, id)).for("update");
    if (!contract) return "missing" as const;
    const aup = await aupGateNow(tx, id);
    if ("refused" in aup) return { aup: aup.refused };
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
  if (typeof result === "object") {
    await auditAupRefusal(db, { actor: actor.userId, contractId: id, action: "sign", reason: result.aup, via: "approve_route" });
    if ((req.headers.get("accept") ?? "").includes("text/html")) return NextResponse.redirect(new URL(`/contracts/${id}?aup=${result.aup}`, req.url), 303);
    return jsonError(`cannot sign: ${AUP_REFUSAL_TEXT[result.aup]}`, 409, { reason: result.aup });
  }

  return NextResponse.redirect(new URL(`/contracts/${id}`, req.url), 303);
}
