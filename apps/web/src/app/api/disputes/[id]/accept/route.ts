import { NextResponse } from "next/server";
import { requestIdFor } from "@milestone/core";
import { acceptDisputeClaim, disputeAcceptPlan } from "@milestone/money";
import { getDb } from "@/lib/db";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { disputeForFreelancer, jsonError, noStore } from "../../_shared";

export const dynamic = "force-dynamic";

/**
 * The freelancer accepts the buyer's claim: POST accept-claim, and PayPal refunds the buyer. Body:
 * { "confirm": true, "note"?: "..." }; without confirm nothing is sent. Only once the milestone's money left escrow
 * (released or partial_released): otherwise 409 { reason: "milestone_not_final" } and an operator settles it, since a
 * refund then would leave the ledger holding money PayPal already returned and a release could still pay it out.
 * The money moves through acceptDisputeClaim in policy/execute.ts, which books it in the ledger and flags an operator.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await disputeForFreelancer(db, actor, id);
  if ("error" in found) return found.error;

  const body = (await req.json().catch(() => null)) as { confirm?: unknown; note?: unknown } | null;
  if (body?.confirm !== true) return jsonError("accepting the claim refunds the buyer; send { \"confirm\": true }", 400);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 2000) : "The seller accepts the claim.";
  const planned = await disputeAcceptPlan(db, { disputeId: id, actor: actor.userId, note });
  if (!planned.ok) return jsonError(planned.error, planned.status, { reason: planned.reason });
  const r = await acceptDisputeClaim({ db, client: paypal(), requestIdFor: (kind, key) => requestIdFor(db, kind, key) }, planned.plan);
  if (!r.ok) return jsonError(r.error ?? "PayPal refused to accept the claim", r.status ?? 502, r.reason ? { reason: r.reason } : undefined);
  return NextResponse.json({ ok: true, requestId: r.requestId }, { headers: noStore });
}
