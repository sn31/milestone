import { cookies } from "next/headers";
import { ACTORS, ACTOR_COOKIE, ROLE_LABELS, getActor } from "@/lib/session";
import { RoleSwitchKeys } from "./role-switch-keys";

/** Sets the demo identity. Setting a cookie in a Server Action re-renders the current page, so no redirect is needed. */
async function switchRole(formData: FormData) {
  "use server";
  const id = String(formData.get("actor") ?? "");
  if (!ACTORS[id]) return;
  (await cookies()).set(ACTOR_COOKIE, id, { path: "/", sameSite: "lax", httpOnly: true });
}

const SHORT: Record<string, string> = { client: "Client", freelancer: "Freelancer", partner: "Partner" };

/**
 * A physical segmented switch: a recessed track with one key per role; the current key is raised and its indicator lit.
 * One submit button per role, so it works without client JS; with JS the chosen key lights while the switch is in flight
 * and the page stays painted until it re-renders (role-switch-keys.tsx).
 */
export async function RoleSwitcher() {
  const actor = await getActor();
  return (
    <form action={switchRole} className="flex items-center gap-3" aria-label="Switch demo role">
      <span className="type-label hidden text-fg-faint lg:inline">Acting as</span>
      <RoleSwitchKeys current={actor.userId} keys={Object.values(ACTORS).map((a) => ({ userId: a.userId, short: SHORT[a.role] ?? a.role, label: ROLE_LABELS[a.role] }))} />
    </form>
  );
}
