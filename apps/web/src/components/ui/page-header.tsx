import type { ReactNode } from "react";
import { cx } from "./cx";

/** Mono uppercase label with a short leading rule. Above titles and sections. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cx("type-label flex items-center gap-2 text-fg-faint", className)}>
      <span aria-hidden className="h-px w-4 bg-hairline-strong" />
      {children}
    </p>
  );
}

export interface PageHeaderProps {
  eyebrow?: ReactNode;
  /** Serif display title. Plain text; the italic <em> accent is kept for the 404 only (DESIGN.md Review 1). */
  title: ReactNode;
  description?: ReactNode;
  /** Buttons, right-aligned on desktop, below the title on mobile. */
  actions?: ReactNode;
  /** Stats or a countdown shown to the right of the title on desktop. */
  aside?: ReactNode;
  className?: string;
}

/** Top of every page. Left-aligned, one per page. */
export function PageHeader({ eyebrow, title, description, actions, aside, className }: PageHeaderProps) {
  return (
    <header className={cx("flex flex-col gap-6 md:flex-row md:items-end md:justify-between", className)}>
      <div className="min-w-0">
        {eyebrow ? <Eyebrow>{eyebrow}</Eyebrow> : null}
        <h1 className="type-display-xl mt-3 text-fg [&_em]:text-fg-muted">{title}</h1>
        {description ? <p className="mt-3 max-w-[56ch] text-fg-muted">{description}</p> : null}
      </div>
      {aside || actions ? (
        <div className="flex flex-wrap items-end gap-x-8 gap-y-4 md:justify-end">
          {aside}
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
    </header>
  );
}

/** Serif section heading with an optional eyebrow and actions on the right. */
export function SectionTitle({ eyebrow, title, actions, className }: { eyebrow?: ReactNode; title: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cx("mb-4 flex flex-wrap items-end justify-between gap-3", className)}>
      <div>
        {eyebrow ? <Eyebrow className="mb-2">{eyebrow}</Eyebrow> : null}
        <h2 className="type-display-m text-fg">{title}</h2>
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}
