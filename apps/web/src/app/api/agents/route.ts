import { desc, eq } from "drizzle-orm";
import { agentMandates, audit, createMandate } from "@milestone/core";
import { getDb } from "@/lib/db";
import { json, jsonError } from "@/lib/http";
import { getActor } from "@/lib/session";
import { AGENT_REFUSAL, mandateView, parseCreate } from "./_shared";

export const dynamic = "force-dynamic";

/** The signed-in (role cookie) user's mandates, newest first. Never the tokens. */
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== null) return jsonError(AGENT_REFUSAL, 403, { reason: "agents_cannot_manage_mandates" });
  const actor = await getActor();
  const rows = await getDb().select().from(agentMandates).where(eq(agentMandates.userId, actor.userId)).orderBy(desc(agentMandates.createdAt));
  return json({ userId: actor.userId, mandates: rows.map((m) => mandateView(m)) });
}

/**
 * Creates a mandate for the signed-in user. The bearer token is in this response only (it is stored as its sha256):
 * { mandate, token, mcp: { url, header } }.
 */
export async function POST(req: Request) {
  if (req.headers.get("authorization") !== null) return jsonError(AGENT_REFUSAL, 403, { reason: "agents_cannot_manage_mandates" });
  const actor = await getActor();
  const parsed = parseCreate(await req.json().catch(() => null), actor.role);
  if ("error" in parsed) return jsonError(parsed.error, 400);
  const db = getDb();
  const { mandate, token } = await createMandate(db, { userId: actor.userId, ...parsed });
  await audit(db, {
    actor: actor.userId,
    event: "agent.mandate_created",
    detail: { mandateId: mandate.id, agentName: mandate.agentName, actions: mandate.actions, approveCapMinor: mandate.approveCapMinor, fundCapMinor: mandate.fundCapMinor, fundTotalCapMinor: mandate.fundTotalCapMinor, autoFundNext: mandate.autoFundNext, currency: mandate.currency, expiresAt: mandate.expiresAt.toISOString() },
  });
  const base = (process.env.APP_URL || new URL(req.url).origin).replace(/\/+$/, "");
  return json({ mandate: mandateView(mandate), token, shownOnce: true, mcp: { url: `${base}/api/mcp`, header: `Authorization: Bearer ${token}` } }, 201);
}
