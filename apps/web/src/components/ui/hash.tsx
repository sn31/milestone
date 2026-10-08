"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState, type ReactNode } from "react";
import { truncateMiddle } from "@/lib/format";
import { cx } from "./cx";

export interface HashProps {
  /** The full id or hash. Copied on click. */
  value: string;
  /** Characters kept at the start. Default 6. */
  head?: number;
  /** Characters kept at the end. Default 4. */
  tail?: number;
  /** Mono prefix inside the chip, e.g. "sha" or "capture". */
  label?: string;
  className?: string;
}

/** An id or hash as a mono chip, middle-truncated; click copies the full value and confirms in place. */
export function Hash({ value, head = 6, tail = 4, label, className }: HashProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // clipboard blocked (insecure origin); the full value is still in the title
    }
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={`${value} (click to copy)`}
      aria-label={`Copy ${label ? `${label} ` : ""}${value}`}
      className={cx(
        "inline-flex h-6 max-w-full items-center gap-1.5 rounded-chip border border-hairline bg-surface-sunken px-1.5 font-mono text-[11.5px] text-fg-muted tabular",
        "transition-colors duration-200 hover:border-hairline-strong hover:text-fg active:translate-y-px",
        className,
      )}
    >
      {label ? <span className="text-[10px] tracking-[0.1em] text-fg-faint uppercase">{label}</span> : null}
      <span className="relative inline-grid overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          <motion.span
            key={copied ? "c" : "v"}
            initial={{ y: 8, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: -8, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className={cx("truncate", copied && "text-state-released")}
          >
            {copied ? "copied" : truncateMiddle(value, head, tail)}
          </motion.span>
        </AnimatePresence>
      </span>
    </button>
  );
}

/** A keyboard key or a literal token, in mono on a raised keycap. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cx(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-chip border border-hairline-strong bg-surface-raised px-1 font-mono text-[11px] text-fg-muted",
        "[box-shadow:inset_0_-1px_0_0_var(--hairline-strong)]",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
