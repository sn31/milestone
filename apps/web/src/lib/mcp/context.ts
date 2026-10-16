import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { agentMandates, agentActor, audit, type AgentMandate, type Db } from "@milestone/core";
import { ACTOR_COOKIE, type AgentActor, type Role } from "@/lib/session";

/** Who is calling the MCP server: the mandate's agent acting as the mandate's user, for one HTTP request. */
export interface McpContext {
  db: Db;
  /** The bearer token the request presented; forwarded to the review route so it re-authenticates the agent itself. */
  token: string;
  agent: AgentActor;
  /** Origin of the MCP request, used as the base URL of the in-process route calls. */
  origin: string;
}

export const userOf = (ctx: McpContext): { userId: string; role: Role } => ({ userId: ctx.agent.userId, role: ctx.agent.role });

/** The mandate as stored now (re-read on every tool call so a revoke between calls is seen at once); null when gone. */
export async function currentMandate(ctx: McpContext): Promise<AgentMandate | null> {
  const [m] = await ctx.db.select().from(agentMandates).where(eq(agentMandates.id, ctx.agent.mandate.id)).limit(1);
  return m ?? null;
}

/**
 * One audit row per MCP tool call, with actor agentActor(mandate). Reads (list_contracts, get_milestone, get_ledger)
 * are recorded without contract / milestone ids so an agent polling a milestone does not flood the contract's activity
 * list; the ids are in the detail. Writes carry the ids and appear on the contract page.
 */
export async function auditTool(
  ctx: McpContext,
  event: string,
  o: { contractId?: string | null; milestoneId?: string | null; read?: boolean; detail?: Record<string, unknown> } = {},
): Promise<void> {
  const ids = o.read ? {} : { ...(o.contractId ? { contractId: o.contractId } : {}), ...(o.milestoneId ? { milestoneId: o.milestoneId } : {}) };
  await audit(ctx.db, {
    actor: agentActor(ctx.agent.mandate),
    event,
    ...ids,
    detail: {
      via: "mcp",
      mandateId: ctx.agent.mandate.id,
      agentName: ctx.agent.mandate.agentName,
      onBehalfOf: ctx.agent.userId,
      ...(o.read ? { contractId: o.contractId ?? null, milestoneId: o.milestoneId ?? null } : {}),
      ...o.detail,
    },
  });
}

/**
 * Runs `fn` with the request's role cookie set to `userId`, then puts the cookie back as it was. The routes the MCP
 * tools call in-process (POST /api/contracts, /api/milestones/[id]/order, /api/milestones/[id]/deliver) take their
 * caller from getActor(), which reads that cookie; binding it to the mandate's user for the whole MCP request means
 * they see exactly the user the mandate acts for (never whatever cookie the MCP client happened to send). The review
 * route ignores the cookie when the request carries the bearer token, which the tools always forward.
 */
export async function withActorCookie<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const jar = await cookies();
  const before = jar.get(ACTOR_COOKIE)?.value;
  if (before === userId) return fn();
  const options = { path: "/", httpOnly: true, sameSite: "lax" } as const;
  jar.set(ACTOR_COOKIE, userId, options);
  try {
    return await fn();
  } finally {
    if (before === undefined) jar.delete(ACTOR_COOKIE);
    else jar.set(ACTOR_COOKIE, before, options);
  }
}

/** Whether the role cookie the in-process routes will read is the mandate's user (checked before every such call). */
export async function actorCookieIs(userId: string): Promise<boolean> {
  return (await cookies()).get(ACTOR_COOKIE)?.value === userId;
}
