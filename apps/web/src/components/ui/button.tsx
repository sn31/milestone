import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

interface Common {
  /** primary: one per view; secondary: glass; ghost: text only; danger: destructive (veto, hold, refund). */
  variant?: ButtonVariant;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}

export type ButtonProps = Common &
  (({ href?: undefined } & ButtonHTMLAttributes<HTMLButtonElement>) | { href: string; prefetch?: boolean; "aria-label"?: string });

const BASE =
  "relative inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-control font-medium " +
  "transition-[transform,background-color,border-color,color,opacity] duration-[120ms] ease-glide " +
  "active:translate-y-px active:scale-[0.985] disabled:pointer-events-none disabled:opacity-45 aria-disabled:pointer-events-none aria-disabled:opacity-45";

const SIZE = { sm: "h-8 px-3 text-[13px]", md: "h-10 px-4 text-sm" } as const;

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-fg text-fg-inverse hover:bg-fg/88 [box-shadow:inset_0_1px_0_0_rgb(255_255_255/0.28),inset_0_-1px_0_0_rgb(0_0_0/0.22)]",
  secondary: "glass text-fg hover:border-hairline-strong hover:bg-surface-raised",
  ghost: "text-fg-muted hover:bg-fg/6 hover:text-fg",
  danger: "border border-state-danger/45 bg-state-danger/8 text-state-danger hover:border-state-danger/70 hover:bg-state-danger/15",
};

/** Every action. Renders a next/link when given href. Press feedback (1px drop, 1.5% shrink) is built in. */
export function Button(props: ButtonProps) {
  const { variant = "secondary", size = "md", className, children } = props;
  const cls = cx(BASE, SIZE[size], VARIANT[variant], className);
  if (props.href !== undefined) {
    return (
      <Link href={props.href} prefetch={props.prefetch} aria-label={props["aria-label"]} className={cls}>
        {children}
      </Link>
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { variant: _v, size: _s, className: _c, children: _ch, href: _h, type = "button", ...rest } = props;
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}
