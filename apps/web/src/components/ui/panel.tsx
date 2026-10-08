import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import type { ToneKey } from "./states";

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  as?: "section" | "div" | "article" | "aside" | "li";
  /** Draws a 2px accent edge on the left in this state's colour and sets data-tone for the subtree. */
  tone?: ToneKey;
  /** glass (default): translucent with hairline; solid: opaque, for grids; sunken: a recessed well; outline: dashed, for empty or pending. */
  variant?: "glass" | "solid" | "sunken" | "outline";
  /** Default padding (p-5 sm:p-6). Set false for edge-to-edge content such as ledgers and grids. */
  padded?: boolean;
  children?: ReactNode;
}

const VARIANT: Record<NonNullable<PanelProps["variant"]>, string> = {
  glass: "glass",
  solid: "border border-hairline bg-surface",
  sunken: "border border-hairline bg-surface-sunken",
  outline: "border border-dashed border-hairline-strong",
};

/** The only bordered container. Do not nest glass in glass; nest sunken or outline. */
export function Panel({ as: Tag = "section", tone, variant = "glass", padded = true, className, children, ...rest }: PanelProps) {
  return (
    <Tag data-tone={tone} className={cx("relative rounded-panel", VARIANT[variant], padded && "p-5 sm:p-6", className)} {...rest}>
      {tone ? <span aria-hidden className="pointer-events-none absolute top-4 bottom-4 -left-px w-[2px] rounded-full bg-tone" /> : null}
      {children}
    </Tag>
  );
}
