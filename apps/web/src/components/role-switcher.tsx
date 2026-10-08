import { cookies } from "next/headers";
import { ACTORS, ACTOR_COOKIE, ROLE_LABELS, getActor } from "@/lib/session";

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
 * One submit button per role, so it works without client JS.
 */
export async function RoleSwitcher() {
  const actor = await getActor();
  return (
    <form action={switchRole} className="flex items-center gap-3" aria-label="Switch demo role">
      <span className="type-label hidden text-fg-faint lg:inline">Acting as</span>
      <div
        role="group"
        className="inline-flex rounded-control border border-hairline bg-surface-sunken p-[3px] [box-shadow:inset_0_1px_3px_rgb(0_0_0/0.22)]"
      >
        {Object.values(ACTORS).map((a) => {
          const current = a.userId === actor.userId;
          return (
            <button
              key={a.userId}
              type="submit"
              name="actor"
              value={a.userId}
              aria-pressed={current}
              data-tone="released"
              className={
                "group inline-flex h-7 items-center gap-1.5 rounded-[5px] border px-2 text-[12px] sm:gap-2 sm:px-2.5 sm:text-[13px] transition-[color,background-color,border-color,transform] duration-[120ms] ease-glide active:translate-y-px " +
                (current
                  ? "border-hairline-strong bg-surface-raised text-fg [box-shadow:inset_0_1px_0_0_var(--highlight),0_1px_0_0_rgb(0_0_0/0.25)]"
                  : "border-transparent text-fg-faint hover:text-fg-muted")
              }
            >
              <span
                aria-hidden
                className={"size-1.5 rounded-full transition-colors duration-200 " + (current ? "bg-tone glow-tone" : "hidden bg-hairline-strong group-hover:bg-fg-faint sm:block")}
              />
              <span className="sm:hidden">{SHORT[a.role]}</span>
              <span className="hidden sm:inline">{ROLE_LABELS[a.role]}</span>
            </button>
          );
        })}
      </div>
    </form>
  );
}
