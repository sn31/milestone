import type { ReactNode } from "react";
import { cx } from "./cx";

export interface EmptyStateProps {
  title: ReactNode;
  body?: ReactNode;
  /** Usually a <Button>. */
  action?: ReactNode;
  className?: string;
}

/** Nothing here yet: a ghost rail with no stations lit, a serif line, and the next step. Left-aligned. */
export function EmptyState({ title, body, action, className }: EmptyStateProps) {
  return (
    <div className={cx("flex gap-5 rounded-panel border border-dashed border-hairline-strong p-6 sm:p-8", className)}>
      <svg aria-hidden viewBox="0 0 16 76" className="h-[76px] w-4 shrink-0 text-fg-faint" fill="none" stroke="currentColor">
        <circle cx="8" cy="7" r="5" strokeWidth="1.2" />
        <path d="M8 14 V31" strokeDasharray="2 3" strokeWidth="1.2" />
        <circle cx="8" cy="38" r="5" strokeWidth="1.2" opacity="0.6" />
        <path d="M8 45 V62" strokeDasharray="2 3" strokeWidth="1.2" opacity="0.6" />
        <circle cx="8" cy="69" r="5" strokeWidth="1.2" opacity="0.3" />
      </svg>
      <div className="min-w-0">
        <p className="type-display-s text-fg">{title}</p>
        {body ? <p className="mt-2 max-w-[52ch] text-fg-muted">{body}</p> : null}
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}
