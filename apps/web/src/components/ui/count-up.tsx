"use client";

import { animate } from "motion/react";
import { useEffect, useRef } from "react";
import { formatNumber } from "@/lib/format";
import { cx } from "./cx";
import { DUR, EASE, prefersReducedMotion } from "./motion";

export interface CountUpProps {
  value: number;
  /** Fixed decimals shown while counting and at rest. */
  decimals?: number;
  /** Seconds. Default DUR.count (0.9). */
  duration?: number;
  /** Rendered after the number, e.g. "%". Not animated. */
  suffix?: string;
  className?: string;
}

/**
 * A number that counts up from 0 on first mount, and from its previous value when it changes. The server renders the
 * final value (hidden by .countup-pending until the client takes over, with a CSS failsafe); reduced motion shows it at once.
 * For money use <Money animate>, which counts the whole units and keeps the decimals still.
 */
export function CountUp({ value, decimals = 0, duration = DUR.count, suffix, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const from = useRef(0);
  useEffect(() => {
    const el = ref.current;
    const node = el?.firstChild;
    if (!el || !node) return;
    el.classList.remove("countup-pending");
    const set = (v: number) => {
      node.nodeValue = formatNumber(v, decimals);
    };
    if (prefersReducedMotion() || from.current === value) {
      set(value);
      from.current = value;
      return;
    }
    set(from.current);
    const controls = animate(from.current, value, { duration, ease: EASE.glide, onUpdate: set });
    from.current = value;
    return () => controls.stop();
  }, [value, decimals, duration]);
  return (
    <span className={cx("tabular", className)}>
      <span ref={ref} className="countup-pending">{formatNumber(value, decimals)}</span>
      {suffix}
    </span>
  );
}
