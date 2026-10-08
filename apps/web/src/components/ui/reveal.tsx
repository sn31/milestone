import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx";

/**
 * Rises into place on first paint (CSS only, server-safe). `index` staggers siblings by 50 ms, capped at 8.
 * Disabled under prefers-reduced-motion by globals.css.
 */
export function Reveal({ index = 0, as: Tag = "div", className, children }: { index?: number; as?: "div" | "li" | "section"; className?: string; children: ReactNode }) {
  const style: CSSProperties = { animationDelay: `${Math.min(index, 8) * 50}ms` };
  return (
    <Tag className={cx("animate-reveal", className)} style={style}>
      {children}
    </Tag>
  );
}
