"use client";

import { animate } from "motion/react";
import { useLayoutEffect, useRef } from "react";
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
 * A number that is always readable. The server renders the final value and the first paint shows it, so a page load, a
 * screenshot or a video frame never catches blank or half-counted digits. While the page is open, a new
 * value counts from the one on screen to the new one; reduced motion, a hidden tab or an off-screen figure jump straight
 * to it. For money use <Money animate>, which counts the whole units and keeps the decimals still.
 */
export function CountUp({ value, decimals = 0, duration = DUR.count, suffix, className }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  /** The value currently on screen (mid-count while a count runs). */
  const shown = useRef(value);
  // Layout effect: React has already written the new value into the text node; reset it to the old one before the browser
  // paints, so the count starts where the eye is instead of flashing the destination first.
  useLayoutEffect(() => {
    const node = ref.current?.firstChild;
    const from = shown.current;
    const set = (v: number) => {
      shown.current = v;
      if (node) node.nodeValue = formatNumber(v, decimals);
    };
    if (!node || from === value || prefersReducedMotion() || document.hidden || !inView(ref.current)) {
      set(value);
      return;
    }
    set(from);
    const controls = animate(from, value, { duration, ease: EASE.glide, onUpdate: set, onComplete: () => set(value) });
    return () => controls.stop();
  }, [value, decimals, duration]);
  return (
    <span className={cx("tabular", className)}>
      <span ref={ref}>{formatNumber(value, decimals)}</span>
      {suffix}
    </span>
  );
}

function inView(el: Element | null): boolean {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0;
}
