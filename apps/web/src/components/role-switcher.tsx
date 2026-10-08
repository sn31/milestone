import { cookies } from "next/headers";
import { ACTORS, ACTOR_COOKIE, ROLE_LABELS, getActor } from "@/lib/session";

/** Sets the demo identity. Setting a cookie in a Server Action re-renders the current page, so no redirect is needed. */
async function switchRole(formData: FormData) {
  "use server";
  const id = String(formData.get("actor") ?? "");
  if (!ACTORS[id]) return;
  (await cookies()).set(ACTOR_COOKIE, id, { path: "/", sameSite: "lax", httpOnly: true });
}

/** A segmented control: one submit button per role, the current one pressed. Works without client JS. */
export async function RoleSwitcher() {
  const actor = await getActor();
  return (
    <form action={switchRole} className="flex items-center gap-2 text-sm" aria-label="Switch demo role">
      <span className="hidden text-zinc-500 sm:inline dark:text-zinc-400">Acting as</span>
      <div role="group" className="inline-flex rounded-lg bg-zinc-100 p-0.5 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:ring-zinc-800">
        {Object.values(ACTORS).map((a) => {
          const current = a.userId === actor.userId;
          return (
            <button
              key={a.userId}
              type="submit"
              name="actor"
              value={a.userId}
              aria-pressed={current}
              className={
                current
                  ? "rounded-md bg-white px-3 py-1 font-medium text-zinc-900 shadow-sm ring-1 ring-zinc-200 dark:bg-zinc-700 dark:text-white dark:ring-zinc-600"
                  : "rounded-md px-3 py-1 text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-white"
              }
            >
              {ROLE_LABELS[a.role]}
            </button>
          );
        })}
      </div>
    </form>
  );
}
