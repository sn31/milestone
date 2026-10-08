import { NextResponse } from "next/server";
import { audit, enqueue, milestones, transition } from "@milestone/core";
import { getDb } from "@/lib/db";
import { getActor } from "@/lib/session";
import { isContractClient, jsonError, loadMilestone } from "../../_shared";

const ACTIONS = ["approve", "veto", "confirm_partial", "hold"] as const;
type Action = (typeof ACTIONS)[number];

/** Which statuses each client action is allowed from. */
const ALLOWED: Record<Action, readonly string[]> = {
  approve: ["review", "needs_client"],
  veto: ["review"],
  confirm_partial: ["needs_client"],
  hold: ["needs_client"],
};

/**
 * The client's answer during the review window or on a needs_client decision. approve/confirm_partial enqueue the
 * release job (it re-derives the window state from the DB); veto/hold move the milestone to held.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const found = await loadMilestone(db, id);
  if (!found) return jsonError("milestone not found", 404);
  const { milestone: m, contract: c, ops } = found;
  if (!isContractClient(actor, c)) return jsonError("only the contract's client can respond", 403);

  const body = (await req.json().catch(() => null)) as { action?: unknown } | null;
  const action = ACTIONS.find((a) => a === body?.action);
  if (!action) return jsonError(`action must be one of ${ACTIONS.join(", ")}`, 400);
  if (!ALLOWED[action].includes(m.status)) return jsonError(`cannot ${action} while milestone is ${m.status}`, 409);
  if (action === "approve" && m.status === "needs_client" && m.decision?.action !== "ask_client") {
    return jsonError("full approval is only offered when the agent asked the client", 409);
  }
  if (action === "confirm_partial" && m.decision?.action !== "partial" && m.decision?.action !== "ask_client") {
    return jsonError("there is no proposed partial amount to confirm", 409);
  }

  await db.update(milestones).set({ clientResponse: action }).where(ops.eq(milestones.id, m.id));
  const entry = { actor: actor.userId, event: `client.${action}`, detail: { status: m.status } };

  if (action === "approve" || action === "confirm_partial") {
    await audit(db, { ...entry, milestoneId: m.id, contractId: c.id });
    await enqueue("release", m.id, { clientResponse: action }, { dedupe: `client-${action}-${m.id}` });
    return NextResponse.json({ ok: true, queued: "release" }, { headers: { "Cache-Control": "no-store" } });
  }
  const moved = await transition(db, m.id, "held", entry);
  return NextResponse.json({ ok: true, status: "held", changed: moved }, { headers: { "Cache-Control": "no-store" } });
}
