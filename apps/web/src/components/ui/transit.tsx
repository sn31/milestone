"use client";

import { animate, motion } from "motion/react";
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { formatAmount, formatMoneyParts } from "@/lib/format";
import { cx } from "./cx";
import { DUR, EASE, prefersReducedMotion } from "./motion";
import { StateGlyph } from "./state-pill";
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

// ---------- Play once ----------

const played = new Map<string, boolean>();

/** Decides (once per key and page load) whether a fresh moment plays; a moment that is not fresh rests without deciding. */
function decidePlay(key: string, fresh: boolean): boolean {
  // Not fresh: rest, and decide nothing yet (the same key may turn fresh on a later render of this page).
  if (!fresh) return false;
  let p = played.get(key);
  if (p === undefined) {
    let seen = false;
    try {
      seen = window.sessionStorage.getItem(`ms.played.${key}`) === "1";
      window.sessionStorage.setItem(`ms.played.${key}`, "1");
    } catch {
      // storage blocked: play by freshness alone
    }
    p = !seen && !prefersReducedMotion();
    played.set(key, p);
  }
  return p;
}
const noSubscribe = () => () => {};

/**
 * Whether a one-off money moment (`key`, e.g. "release:mst_3") plays on this page load: only when the server says it
 * just happened (`fresh`), it has not played in this tab before (sessionStorage) and motion is allowed. Decided once
 * per key and page load, so the band and the rail's connector agree. null until mounted (the server renders the
 * moment's starting frame when fresh, its resting frame otherwise).
 */
export function usePlayOnce(key: string, fresh: boolean): boolean | null {
  return useSyncExternalStore(
    noSubscribe,
    () => decidePlay(key, fresh),
    () => null,
  );
}

/**
 * The rail connector under a station filling from the node down, once, in the station's tone: the paid segment of the
 * track completing as the release lands. Rendered inside <Station connectorOverlay>; nothing unless it plays.
 */
export function ConnectorFill({ playKey, fresh, delay = 0.2 }: { playKey: string; fresh: boolean; delay?: number }) {
  const play = usePlayOnce(playKey, fresh);
  if (!play && !(play === null && fresh)) return null;
  return (
    <motion.span
      aria-hidden
      className="absolute top-[28px] -bottom-8 left-1/2 z-[1] w-[2px] -translate-x-1/2 origin-top rounded-full bg-tone glow-tone group-last/station:hidden"
      initial={{ scaleY: 0, opacity: 1 }}
      animate={play ? { scaleY: [0, 1, 1], opacity: [1, 1, 0] } : { scaleY: 0 }}
      transition={{ duration: DUR.transit * 2.4, ease: EASE.shift, delay, times: [0, 0.6, 1] }}
    />
  );
}

// ---------- The release moment ----------

export interface ReleaseLeg {
  /** Who receives it, e.g. "Frankie Freelancer". */
  to: string;
  /** Mono note under the name, e.g. "advance repaid". */
  note?: string;
  minor: number;
  tone: ToneKey;
}

export interface ReleaseBandProps {
  /** For play-once: the milestone id. */
  milestoneId: string;
  /** The play-once key when the release has a time of its own (e.g. "release:mst_3@<ms>"); default "release:<milestoneId>". */
  playKey?: string;
  currency: string;
  /** Where the money goes, in the order PayPal pays it (the capital partner's repayment first, then the freelancer, then a refund). */
  legs: ReleaseLeg[];
  /** pending: the payout is with PayPal and its webhook has not confirmed it; done: confirmed. */
  phase: "pending" | "done";
  /** The milestone turned released within the last minute: play the moment (once per tab). */
  fresh?: boolean;
  /** Released on the whole contract before and after this milestone, counted up as it lands. */
  contractTotal?: { before: number; after: number };
  /** Mono reference under the band: the payout op or PayPal batch id. */
  reference?: string | null;
  /** Who confirmed it, e.g. "payout confirmed by PayPal". */
  confirmedLabel?: string;
  className?: string;
}

const LEG_SECONDS = DUR.transit;
const LEG_GAP = 0.25;

/**
 * The release, as a full-width band on the station: escrow on the left draining as each leg crosses to its payee on
 * the right (the capital partner's repayment first, then the freelancer's share, matching the ledger), the contract's
 * released total counting up, and the PayPal confirmation landing last. While the payout waits for PayPal's webhook
 * the bead waits at the middle of the track. Plays once when the release has just happened; otherwise rests at the
 * end state. Reduced motion shows the end state.
 */
export function ReleaseBand({ milestoneId, playKey, currency, legs, phase, fresh = false, contractTotal, reference, confirmedLabel = "payout confirmed by PayPal", className }: ReleaseBandProps) {
  const total = legs.reduce((s, l) => s + l.minor, 0);
  const play = usePlayOnce(playKey ?? `release:${milestoneId}`, phase === "done" && fresh);
  const box = useRef<HTMLDivElement>(null);
  const escrow = useRef<HTMLSpanElement>(null);
  const counter = useRef<HTMLSpanElement>(null);
  const legRefs = useRef<Array<{ fig: HTMLSpanElement | null; bead: HTMLSpanElement | null; fill: HTMLSpanElement | null }>>([]);
  const [landed, setLanded] = useState(phase === "done" && !fresh);
  const startFrame = phase === "done" && fresh && play !== false;

  useEffect(() => {
    if (phase !== "done") return;
    const setLeg = (i: number, p: number) => {
      const r = legRefs.current[i];
      const leg = legs[i];
      if (!r || !leg) return;
      if (r.fig?.firstChild) r.fig.firstChild.nodeValue = formatAmount(Math.round(leg.minor * p), currency);
      if (r.bead) r.bead.style.left = `${p * 100}%`;
      if (r.fill) r.fill.style.transform = `scaleX(${p})`;
    };
    const setEscrow = (moved: number) => {
      if (escrow.current?.firstChild) escrow.current.firstChild.nodeValue = formatAmount(Math.max(0, total - moved), currency);
      if (counter.current?.firstChild && contractTotal) counter.current.firstChild.nodeValue = formatAmount(contractTotal.before + Math.min(moved, contractTotal.after - contractTotal.before), currency);
    };
    const rest = () => {
      legs.forEach((_, i) => setLeg(i, 1));
      setEscrow(total);
      setLanded(true);
    };
    if (play === null) return;
    if (!play) return rest();
    legs.forEach((_, i) => setLeg(i, 0));
    setEscrow(0);
    // Bring the station into view first: the moment must be on screen when it plays.
    const el = box.current;
    const r = el?.getBoundingClientRect();
    if (el && r && (r.top < 64 || r.bottom > window.innerHeight)) el.scrollIntoView({ block: "center", behavior: "smooth" });
    const controls: Array<{ stop(): void }> = [];
    let moved = 0;
    let cancelled = false;
    (async () => {
      await new Promise((res) => setTimeout(res, 700));
      for (const [i, leg] of legs.entries()) {
        if (cancelled) return;
        const base = moved;
        const c = animate(0, 1, {
          duration: LEG_SECONDS,
          ease: EASE.shift,
          onUpdate: (p) => {
            setLeg(i, p);
            setEscrow(base + leg.minor * p);
          },
        });
        controls.push(c);
        await c.finished;
        moved += leg.minor;
        await new Promise((res) => setTimeout(res, LEG_GAP * 1000));
      }
      if (!cancelled) setLanded(true);
    })();
    return () => {
      cancelled = true;
      for (const c of controls) c.stop();
    };
    // legs are fixed for a milestone's release
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [play, phase]);

  const parts = formatMoneyParts(total, currency);
  const figure = (ref: ((el: HTMLSpanElement | null) => void) | RefObject<HTMLSpanElement | null>, value: string) => (
    <>
      {parts.symbolAfter ? null : <span className="mr-[0.08em] text-[0.62em] text-fg-faint">{parts.symbol}</span>}
      <span ref={ref}>{value}</span>
      {parts.symbolAfter ? <span className="ml-[0.25em] text-[0.62em] text-fg-faint">{parts.symbol}</span> : null}
    </>
  );
  const pending = phase === "pending";
  const shownEscrow = pending || startFrame ? total : 0;
  return (
    <div
      ref={box}
      data-tone={pending ? "review" : "released"}
      aria-live="polite"
      className={cx("relative overflow-hidden rounded-panel border border-hairline bg-surface-sunken", !pending && "border-tone", className)}
    >
      <div className="grid gap-x-6 gap-y-5 px-4 pt-4 pb-5 sm:px-6 sm:pt-5 md:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="type-label text-fg-faint">{pending ? "In escrow · releasing" : "Escrow"}</p>
          <p className="type-num-l mt-2 text-fg-muted md:type-num-xl">{figure(escrow, formatAmount(shownEscrow, currency))}</p>
        </div>
        <ol className="grid min-w-0 content-center gap-4">
          {legs.map((leg, i) => {
            const start = startFrame || pending;
            return (
              <li key={leg.to + i} data-tone={leg.tone} className="grid min-w-0 grid-cols-[minmax(2.5rem,1fr)_auto] items-end gap-4 sm:gap-6">
                <div className="relative mb-[13px] h-[2px] rounded-full bg-hairline-strong" aria-hidden>
                  <span
                    ref={(el) => {
                      (legRefs.current[i] ??= { fig: null, bead: null, fill: null }).fill = el;
                    }}
                    className="absolute inset-0 origin-left rounded-full bg-[linear-gradient(to_right,color-mix(in_oklab,var(--tone)_15%,transparent),var(--tone))]"
                    style={{ transform: `scaleX(${start ? 0 : 1})` }}
                  />
                  <span
                    ref={(el) => {
                      (legRefs.current[i] ??= { fig: null, bead: null, fill: null }).bead = el;
                    }}
                    className={cx("absolute top-1/2 -ml-1 size-2 -translate-y-1/2 rounded-full bg-tone glow-tone", pending && "animate-pulse-dot")}
                    style={{ left: pending ? "50%" : start ? "0%" : "100%" }}
                  />
                  {pending && i === 0 ? (
                    <span className="absolute top-3 left-1/2 -translate-x-1/2 font-mono text-[10px] tracking-[0.12em] whitespace-nowrap text-fg-faint uppercase">PayPal</span>
                  ) : null}
                </div>
                <div className="min-w-0 text-right">
                  <p className="type-label truncate text-fg-faint">
                    {leg.to}
                    {leg.note || pending ? (
                      <span className="ml-2 font-mono text-[10.5px] tracking-normal text-fg-faint/80 normal-case tabular">
                        {/* While PayPal has not confirmed, each payee's figure is still 0: say what is on its way. */}
                        {[leg.note, pending ? `due ${parts.symbolAfter ? "" : parts.symbol}${formatAmount(leg.minor, currency)}${parts.symbolAfter ? ` ${parts.symbol}` : ""}` : null].filter(Boolean).join(" · ")}
                      </span>
                    ) : null}
                  </p>
                  <p className={cx("mt-1.5 text-tone", i === legs.length - 1 || legs.length === 1 ? "type-num-l md:type-num-xl" : "type-num-l")}>
                    {figure((el) => {
                      (legRefs.current[i] ??= { fig: null, bead: null, fill: null }).fig = el;
                    }, formatAmount(start && !pending ? 0 : pending ? 0 : leg.minor, currency))}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-hairline px-4 py-2.5 font-mono text-[11px] text-fg-faint tabular sm:px-6">
        {pending ? (
          <span data-tone="review" className="inline-flex items-center gap-2 text-tone">
            <span aria-hidden className="size-1.5 animate-pulse-dot rounded-full bg-tone" />
            Releasing · waiting for PayPal to confirm the payout
          </span>
        ) : (
          <motion.span
            data-tone="released"
            className="inline-flex items-center gap-1.5 text-tone"
            initial={false}
            animate={{ opacity: landed ? 1 : 0, y: landed ? 0 : 4 }}
            transition={{ duration: DUR.reveal, ease: EASE.glide }}
          >
            <StateGlyph glyph="check" className="size-[9px]" />
            {confirmedLabel}
          </motion.span>
        )}
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
          {reference ? <span className="truncate">{reference}</span> : null}
          {contractTotal ? (
            <span>
              released on this contract{" "}
              <span className="text-fg">
                {parts.symbolAfter ? null : parts.symbol}
                <span ref={counter}>{formatAmount(startFrame || pending ? contractTotal.before : contractTotal.after, currency)}</span>
                {parts.symbolAfter ? ` ${parts.symbol}` : null}
              </span>
            </span>
          ) : null}
        </span>
      </div>
      <span className="sr-only">
        {pending
          ? `${formatAmount(total, currency)} ${currency} is being released; waiting for PayPal to confirm.`
          : `${legs.map((l) => `${formatAmount(l.minor, currency)} ${currency} to ${l.to}`).join(", ")}. ${confirmedLabel}.`}
      </span>
    </div>
  );
}
