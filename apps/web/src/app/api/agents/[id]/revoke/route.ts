import { audit, revokeMandate } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";
import { AGENT_REFUSAL, mandateView } from "../../_shared";

/** Revokes one of the signed-in user's mandates (idempotent). Takes effect on the agent's next request. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (req.headers.get("authorization") !== null) return jsonError(AGENT_REFUSAL, 403, { reason: "agents_cannot_manage_mandates" });
  const { id } = await ctx.params;
  const actor = await getActor();
  const db = getDb();
  const before = await db.query.agentMandates.findFirst({ columns: { revokedAt: true }, where: (t, { and, eq }) => and(eq(t.id, id), eq(t.userId, actor.userId)) });
  const mandate = await revokeMandate(db, id, { userId: actor.userId });
  if (!mandate) return jsonError("mandate not found", 404);
  const changed = !before?.revokedAt;
  if (changed) await audit(db, { actor: actor.userId, event: "agent.mandate_revoked", detail: { mandateId: mandate.id, agentName: mandate.agentName } });
  return json({ ok: true, changed, mandate: mandateView(mandate) });
}
