"use client";

import { useFormStatus } from "react-dom";

export interface RoleKey {
  userId: string;
  short: string;
  label: string;
}

/**
 * The role switcher's keys. While the switch is in flight the chosen key lights at once and the others dim, so the click
 * answers within a frame; the page under it stays painted until the server has re-rendered it for the new role (a Server
 * Action re-renders in place, without the route's loading skeleton).
 */
export function RoleSwitchKeys({ keys, current }: { keys: RoleKey[]; current: string }) {
  const { pending, data } = useFormStatus();
  const target = pending ? String(data?.get("actor") ?? current) : current;
  return (
    <div
      role="group"
      aria-busy={pending || undefined}
      className="inline-flex rounded-control border border-hairline bg-surface-sunken p-[3px] [box-shadow:inset_0_1px_3px_rgb(0_0_0/0.22)]"
    >
      {keys.map((k) => {
        const on = k.userId === target;
        return (
          <button
            key={k.userId}
            type="submit"
            name="actor"
            value={k.userId}
            aria-pressed={k.userId === current}
            disabled={pending}
            data-tone="released"
            className={
              "group inline-flex h-7 items-center gap-1.5 rounded-[5px] border px-2 text-[12px] sm:gap-2 sm:px-2.5 sm:text-[13px] transition-[color,background-color,border-color,transform] duration-[120ms] ease-glide active:translate-y-px disabled:cursor-progress " +
              (on
                ? "border-hairline-strong bg-surface-raised text-fg [box-shadow:inset_0_1px_0_0_var(--highlight),0_1px_0_0_rgb(0_0_0/0.25)]"
                : "border-transparent text-fg-faint hover:text-fg-muted")
            }
          >
            <span
              aria-hidden
              className={
                "size-1.5 rounded-full transition-colors duration-200 " +
                (on ? (pending ? "animate-pulse-dot bg-tone" : "bg-tone glow-tone") : "hidden bg-hairline-strong group-hover:bg-fg-faint sm:block")
              }
            />
            <span className="sm:hidden">{k.short}</span>
            <span className="hidden sm:inline">{k.label}</span>
          </button>
        );
      })}
    </div>
  );
}
