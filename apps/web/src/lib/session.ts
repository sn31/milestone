import { cookies } from "next/headers";

export type Role = "client" | "freelancer" | "partner";
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

export const ROLE_LABELS: Record<Role, string> = { client: "Client", freelancer: "Freelancer", partner: "Capital partner" };

export async function getActor(): Promise<Actor> {
  const jar = await cookies();
  return ACTORS[jar.get(ACTOR_COOKIE)?.value ?? ""] ?? ACTORS.usr_client;
}
