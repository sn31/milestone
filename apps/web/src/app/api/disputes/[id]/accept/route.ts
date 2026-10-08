import { NextResponse } from "next/server";
import { acceptDisputeClaim } from "@milestone/money";
import { getDb } from "@/lib/db";
import { paypal } from "@/lib/paypal";
import { getActor } from "@/lib/session";
import { disputeForFreelancer, jsonError, noStore } from "../../_shared";

export const dynamic = "force-dynamic";

/**
 * The freelancer accepts the buyer's claim: POST accept-claim, and PayPal refunds the buyer. Body:
 * { "confirm": true, "note"?: "..." }; without confirm nothing is sent.
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
  const r = await acceptDisputeClaim(db, paypal(), { disputeId: id, actor: actor.userId, note });
  if (!r.ok) return jsonError(r.error ?? "PayPal refused to accept the claim", r.status ?? 502);
  return NextResponse.json({ ok: true, requestId: r.requestId }, { headers: noStore });
}
