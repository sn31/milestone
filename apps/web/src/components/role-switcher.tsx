import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { ACTORS, ACTOR_COOKIE, getActor } from "@/lib/session";

async function switchRole(formData: FormData) {
  "use server";
  const id = String(formData.get("actor"));
  if (!ACTORS[id]) return;
  (await cookies()).set(ACTOR_COOKIE, id, { path: "/" });
  redirect(String(formData.get("back") || "/"));
}

export async function RoleSwitcher() {
  const actor = await getActor();
  return (
    <form action={switchRole} className="flex items-center gap-2 text-sm">
      <input type="hidden" name="back" value="/" />
      <label htmlFor="actor" className="text-zinc-500">Acting as</label>
      <select id="actor" name="actor" defaultValue={actor.userId} className="rounded border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700">
        {Object.values(ACTORS).map((a) => <option key={a.userId} value={a.userId}>{a.role}</option>)}
      </select>
      <button className="rounded bg-zinc-900 px-3 py-1 text-white dark:bg-zinc-100 dark:text-zinc-900">Switch</button>
    </form>
  );
}
