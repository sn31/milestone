import { cookies } from "next/headers";
import { agentActor, authenticateAgent, bearerToken, userRole, type AgentMandate, type Executor } from "@milestone/core";

/** The users.role enum: the three demo parties plus the platform operator. */
export type Role = (typeof userRole.enumValues)[number];
export interface Actor { userId: string; role: Role }

/** Demo identities: no real auth; the role switcher picks one via a cookie. */
export const ACTORS: Record<string, Actor> = {
  usr_client: { userId: "usr_client", role: "client" },
  usr_freelancer: { userId: "usr_freelancer", role: "freelancer" },
  usr_partner: { userId: "usr_partner", role: "partner" },
};
export const ACTOR_COOKIE = "milestone_actor";

/** Display names matching the seed (packages/core/src/seed.ts); system actors included for the activity log. */
export const ACTOR_NAMES: Record<string, string> = {
  usr_client: "Casey Client",
  usr_freelancer: "Frankie Freelancer",
  usr_partner: "Parker Partner",
  usr_platform: "Milestone Platform",
};

export const ROLE_LABELS: Record<Role, string> = { client: "Client", freelancer: "Freelancer", partner: "Capital partner", platform: "Platform" };

export async function getActor(): Promise<Actor> {
  const jar = await cookies();
  return ACTORS[jar.get(ACTOR_COOKIE)?.value ?? ""] ?? ACTORS.usr_client;
}

// ---------- Agents acting under a mandate ----------

/** An agent acting as its mandate's user; `auditActor` is agentActor(mandate) for every audit row it causes. */
export interface AgentActor extends Actor { mandate: AgentMandate; auditActor: string }

export type AgentResolution =
  | { agent: AgentActor }
  | { refused: { status: 401 | 403; reason: "invalid_token" | "mandate_expired" | "mandate_revoked"; error: string } };

/**
 * Resolves "Authorization: Bearer <token>" to the agent and the user it acts as. Returns null when the request carries
 * no Authorization header (a human: use getActor()). A header that is present but not a valid, live mandate token is
 * refused and never falls back to the cookie identity.
 */
export async function resolveAgentActor(req: Request, db: Executor): Promise<AgentResolution | null> {
  const header = req.headers.get("authorization");
  if (header === null) return null;
  const auth = await authenticateAgent(db, bearerToken(header));
  if (!auth.ok) {
    if (auth.code === "invalid_token") return { refused: { status: 401, reason: auth.code, error: "unknown or malformed agent token" } };
    return { refused: { status: 403, reason: auth.code, error: auth.code === "mandate_revoked" ? "the mandate was revoked" : "the mandate has expired" } };
  }
  const { mandate, user } = auth;
  return { agent: { userId: user.id, role: user.role, mandate, auditActor: agentActor(mandate) } };
}

/** Whether the actor is an agent acting under a mandate. */
export function isAgent(actor: Actor): actor is AgentActor {
  return "mandate" in actor && "auditActor" in actor;
}

// ---------- Who may act on a contract ----------

/** The contract's own client (funds milestones, answers reviews). */
export function isContractClient(actor: Actor, contract: { clientId: string }): boolean {
  return actor.role === "client" && actor.userId === contract.clientId;
}

/** The contract's own freelancer (delivers, takes advances, answers disputes). */
export function isContractFreelancer(actor: Actor, contract: { freelancerId: string }): boolean {
  return actor.role === "freelancer" && actor.userId === contract.freelancerId;
}

/** Either party to the contract, by user id (who may see its delivered files). */
export function isContractParty(actor: Actor, contract: { clientId: string; freelancerId: string }): boolean {
  return actor.userId === contract.clientId || actor.userId === contract.freelancerId;
}

/** Who may resolve an operator flag: the capital partner or the platform. */
export function isOperator(actor: Actor): boolean {
  return actor.role === "partner" || actor.role === "platform";
}
