"use client";

import { animate, motion } from "motion/react";
import { useEffect, useRef, type RefObject } from "react";
import { formatAmount, formatMoneyParts } from "@/lib/format";
import { cx } from "./cx";
import { DUR, EASE, prefersReducedMotion } from "./motion";
import type { ToneKey } from "./states";

export interface TransitProps {
  /** Delay before the bead sets off, seconds. */
  delay?: number;
  /** Replay every few seconds (only for a state that is still moving, e.g. a payout in flight). */
  loop?: boolean;
  className?: string;
}

/**
 * A bead of light that travels down a rail connector once: money moving to the next station. Rendered by
 * <Station transit>, positioned on the station's connector. Hidden under reduced motion.
 */
export function Transit({ delay = 0.5, loop = false, className }: TransitProps) {
  return (
    <motion.span
      aria-hidden
      className={cx("pointer-events-none absolute left-1/2 z-10 -ml-[3px] h-6 w-[6px] motion-reduce:hidden", className)}
      style={{ background: "linear-gradient(to bottom, transparent, var(--tone))", borderRadius: 3 }}
      initial={{ top: "28px", opacity: 0 }}
      animate={{ top: ["28px", "calc(100% + 4px)"], opacity: [0, 1, 1, 0] }}
      transition={{ duration: DUR.transit, ease: EASE.shift, delay, times: [0, 0.15, 0.8, 1], repeat: loop ? Infinity : 0, repeatDelay: 2.2 }}
    >
      <span className="absolute -bottom-[3px] left-0 size-[6px] rounded-full bg-tone glow-tone" />
    </motion.span>
  );
}

export interface MoneyTransitProps {
  minor: number;
  currency: string;
  /** Where the money sits before, e.g. "Escrow". */
  from: string;
  /** Where it ends, e.g. "Frankie Freelancer". */
  to: string;
  /** Colour of the bead and the receiving side. Default released. */
  tone?: ToneKey;
  /** Seconds before it sets off. */
  delay?: number;
  className?: string;
}

/**
 * The held balance sliding across to the payee: the left figure drains to zero while the right one fills, and a bead
 * runs along the track between them. Plays once on mount; reduced motion shows the end state.
 */
export function MoneyTransit({ minor, currency, from, to, tone = "released", delay = 0.4, className }: MoneyTransitProps) {
  const left = useRef<HTMLSpanElement>(null);
  const right = useRef<HTMLSpanElement>(null);
  const bead = useRef<HTMLSpanElement>(null);
  const fill = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const set = (p: number) => {
      if (left.current?.firstChild) left.current.firstChild.nodeValue = formatAmount(Math.round(minor * (1 - p)), currency);
      if (right.current?.firstChild) right.current.firstChild.nodeValue = formatAmount(Math.round(minor * p), currency);
      if (bead.current) bead.current.style.left = `${p * 100}%`;
      if (fill.current) fill.current.style.transform = `scaleX(${p})`;
    };
    if (prefersReducedMotion()) {
      set(1);
      return;
    }
    set(0);
    const c = animate(0, 1, { duration: DUR.transit, ease: EASE.shift, delay, onUpdate: set });
    return () => c.stop();
  }, [minor, currency, delay]);
  const amount = formatAmount(minor, currency);
  const parts = formatMoneyParts(minor, currency);
  const sym = (cls?: string) => <span className={cx("text-[0.78em] text-fg-faint", cls)}>{parts.symbol}</span>;
  const figure = (ref: RefObject<HTMLSpanElement | null>, initial: string) =>
    parts.symbolAfter ? (
      <>
        <span ref={ref}>{initial}</span>
        {sym("ml-[0.3em]")}
      </>
    ) : (
      <>
        {sym("mr-[0.12em]")}
        <span ref={ref}>{initial}</span>
      </>
    );
  return (
    <div data-tone={tone} className={cx("grid grid-cols-[auto_minmax(3rem,1fr)_auto] items-end gap-3 sm:gap-5", className)}>
      <div className="min-w-0">
        <p className="type-label truncate text-fg-faint">{from}</p>
        <p className="type-num-m mt-1.5 text-fg-muted">{figure(left, amount)}</p>
      </div>
      <div className="relative mb-[11px] h-[2px] rounded-full bg-hairline-strong" aria-hidden>
        <span
          ref={fill}
          className="absolute inset-0 origin-left rounded-full bg-[linear-gradient(to_right,color-mix(in_oklab,var(--tone)_20%,transparent),var(--tone))]"
          style={{ transform: "scaleX(0)" }}
        />
        <span ref={bead} className="absolute top-1/2 -ml-1 size-2 -translate-y-1/2 rounded-full bg-tone glow-tone" style={{ left: "0%" }} />
      </div>
      <div className="min-w-0 text-right">
        <p className="type-label truncate text-fg-faint">{to}</p>
        <p className="type-num-m mt-1.5 text-tone sm:type-num-l">{figure(right, formatAmount(0, currency))}</p>
      </div>
      <span className="sr-only">{`${amount} ${currency} moved from ${from} to ${to}`}</span>
    </div>
  );
}
