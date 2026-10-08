import { NextResponse } from "next/server";
import type { Db } from "@milestone/core";
import type { Actor } from "@/lib/session";
import { loadDisputes, type DisputeView } from "@/app/disputes/_lib";

export const noStore = { "Cache-Control": "no-store" };

export function jsonError(error: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error, ...extra }, { status, headers: noStore });
}

/**
 * The dispute and its contract, for a freelancer's action on it. Only the contract's freelancer may respond to PayPal;
 * the client sees the evidence pack read-only on /disputes.
 */
export async function disputeForFreelancer(db: Db, actor: Actor, disputeId: string): Promise<{ dispute: DisputeView } | { error: Response }> {
  const [dispute] = await loadDisputes(db, { disputeId });
  if (!dispute) return { error: jsonError("dispute not found", 404) };
  const contract = dispute.contractId ? await db.query.contracts.findFirst({ columns: { freelancerId: true }, where: (t, { eq }) => eq(t.id, dispute.contractId!) }) : undefined;
  if (!contract) return { error: jsonError("dispute not found", 404) };
  if (actor.role !== "freelancer" || actor.userId !== contract.freelancerId) return { error: jsonError("only the contract's freelancer can respond to a dispute", 403) };
  if (dispute.resolved) return { error: jsonError("PayPal has already resolved this dispute", 409, { reason: "resolved" }) };
  if (dispute.accepted) return { error: jsonError("the claim was already accepted", 409, { reason: "accepted" }) };
  // A further round is allowed only after PayPal asked for more evidence (status back to awaiting_response).
  if (dispute.status === "submitted") return { error: jsonError("evidence was already sent to PayPal", 409, { reason: "submitted" }) };
  return { dispute };
}
