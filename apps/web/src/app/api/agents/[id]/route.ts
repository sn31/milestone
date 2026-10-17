import { and, eq } from "drizzle-orm";
import { agentMandates, audit, MandateAction } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";
import { AGENT_REFUSAL, DELEGABLE, mandateView, parseFundTerms } from "../_shared";

export const dynamic = "force-dynamic";

const FUND_KEYS = ["fundCap", "fundCapMinor", "fundTotalCap", "fundTotalCapMinor", "autoFundNext"] as const;

/**
 * Changes the funding terms of one of the signed-in user's live mandates: { fundCap? | fundCapMinor?, fundTotalCap? |
 * fundTotalCapMinor?, autoFundNext? }. A key left out keeps its value; null (or "") clears a cap. The same rules as
 * creating apply (both caps or neither, auto-fund needs "fund" and both caps). Actions, approval cap, currency and expiry
 * never change here: revoke and create a new mandate for that. Agents (any Authorization header) are refused.
 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (req.headers.get("authorization") !== null) return jsonError(AGENT_REFUSAL, 403, { reason: "agents_cannot_manage_mandates" });
  const { id } = await ctx.params;
  const actor = await getActor();
  const body = (await req.json().catch(() => null)) as unknown;
  if (!body || typeof body !== "object" || Array.isArray(body)) return jsonError("expected a JSON object", 400);
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).filter((k) => !(FUND_KEYS as readonly string[]).includes(k));
  if (unknown.length) return jsonError(`only the funding terms can change here (${FUND_KEYS.join(", ")}); unknown: ${unknown.join(", ")}`, 400);

  const db = getDb();
  const [m] = await db.select().from(agentMandates).where(and(eq(agentMandates.id, id), eq(agentMandates.userId, actor.userId))).limit(1);
  if (!m) return jsonError("mandate not found", 404);
  const now = new Date();
  if (m.revokedAt) return jsonError("the mandate was revoked", 409, { reason: "mandate_revoked" });
  if (m.expiresAt.getTime() <= now.getTime()) return jsonError("the mandate has expired", 409, { reason: "mandate_expired" });

  const actions = MandateAction.array().parse(m.actions);
  if (!actions.every((a) => DELEGABLE[actor.role].includes(a))) return jsonError(`a ${actor.role} cannot hold this mandate's actions`, 403);
  // Keys left out keep the stored value.
  const has = (k: string) => Object.prototype.hasOwnProperty.call(b, k);
  const merged: Record<string, unknown> = {
    ...(has("fundCap") || has("fundCapMinor") ? { fundCap: b.fundCap, fundCapMinor: b.fundCapMinor } : { fundCapMinor: m.fundCapMinor }),
    ...(has("fundTotalCap") || has("fundTotalCapMinor") ? { fundTotalCap: b.fundTotalCap, fundTotalCapMinor: b.fundTotalCapMinor } : { fundTotalCapMinor: m.fundTotalCapMinor }),
    autoFundNext: has("autoFundNext") ? b.autoFundNext : m.autoFundNext,
  };
  const terms = parseFundTerms(merged, actions, m.currency);
  if ("error" in terms) return jsonError(terms.error, 400);

  const [updated] = await db
    .update(agentMandates)
    .set(terms)
    .where(and(eq(agentMandates.id, m.id), eq(agentMandates.userId, actor.userId)))
    .returning();
  if (!updated) return jsonError("mandate not found", 404);
  const changed = updated.fundCapMinor !== m.fundCapMinor || updated.fundTotalCapMinor !== m.fundTotalCapMinor || updated.autoFundNext !== m.autoFundNext;
  if (changed) {
    await audit(db, {
      actor: actor.userId,
      event: "agent.mandate_updated",
      detail: {
        mandateId: m.id,
        agentName: m.agentName,
        before: { fundCapMinor: m.fundCapMinor, fundTotalCapMinor: m.fundTotalCapMinor, autoFundNext: m.autoFundNext },
        after: terms,
        currency: m.currency,
      },
    });
  }
  return json({ ok: true, changed, mandate: mandateView(updated) });
}
