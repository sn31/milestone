"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./cx";

/** Header navigation link: the current section is lit, with a 1px rule under it. `exact` matches only the same path. */
export function NavLink({ href, exact = false, children, className }: { href: string; exact?: boolean; children: ReactNode; className?: string }) {
  const path = usePathname();
  const active = exact ? path === href : path === href || path.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cx(
        "relative inline-flex h-8 items-center whitespace-nowrap text-[14px] transition-colors duration-200",
        active ? "text-fg" : "text-fg-muted hover:text-fg",
        className,
      )}
    >
      {children}
      <span aria-hidden className={cx("absolute inset-x-0 -bottom-px h-px origin-left bg-fg transition-transform duration-200 ease-glide", active ? "scale-x-100" : "scale-x-0")} />
    </Link>
  );
}
