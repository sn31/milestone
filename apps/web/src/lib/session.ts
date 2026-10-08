import { cookies } from "next/headers";
import { userRole } from "@milestone/core";

/** The users.role enum: the three demo parties plus the platform operator. */
export type Role = (typeof userRole.enumValues)[number];
export interface Actor { userId: string; role: Role }

/** Demo identities: no real auth for the hackathon, the role switcher picks one via a cookie. */
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
