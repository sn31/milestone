import { cookies } from "next/headers";

export type Role = "client" | "freelancer" | "partner";
export interface Actor { userId: string; role: Role }

export const ACTORS: Record<string, Actor> = {
  usr_client: { userId: "usr_client", role: "client" },
  usr_freelancer: { userId: "usr_freelancer", role: "freelancer" },
  usr_partner: { userId: "usr_partner", role: "partner" },
};
export const ACTOR_COOKIE = "milestone_actor";

export async function getActor(): Promise<Actor> {
  const jar = await cookies();
  return ACTORS[jar.get(ACTOR_COOKIE)?.value ?? ""] ?? ACTORS.usr_client;
}
