"use client";

import { useSyncExternalStore } from "react";
import { formatCountdown } from "@/lib/format";
import { cx } from "./cx";

function subscribe(cb: () => void) {
  const id = setInterval(cb, 1000);
  return () => clearInterval(id);
}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const serverNow = () => 0;

/**
 * A one-second clock: the current time in whole epoch seconds. The server snapshot is 0, so the first paint makes no
 * time claims (the ring shows "--:--") and the client fills in the real time right after hydration (no mismatch).
 */
export function useSecondClock(): number {
  return useSyncExternalStore(subscribe, nowSeconds, serverNow);
}

export interface CountdownRingProps {
  /** When the window closes. */
  endsAt: Date | string;
  /** Length of the whole window in seconds (the contract's reviewWindowSeconds). */
  totalSeconds: number;
  /** Diameter in px. Default 124. */
  size?: number;
  /** Mono caption under the time. Default "review window". */
  label?: string;
  /** Caption once the window has closed. */
  closedLabel?: string;
  className?: string;
}

const TICKS = 48;
/** Rounded so server and browser print the same attribute (their Math.cos can differ in the last bit). */
const r2dp = (n: number) => Math.round(n * 100) / 100;

/** The review window as an instrument dial: a teal arc that drains as time runs out, the time left in mono at its centre. */
export function CountdownRing({ endsAt, totalSeconds, size = 124, label = "review window", closedLabel = "window closed", className }: CountdownRingProps) {
  const now = useSecondClock();
  const end = Math.floor(new Date(endsAt).getTime() / 1000);
  const known = now > 0;
  const remaining = known ? Math.max(0, end - now) : totalSeconds;
  const fraction = totalSeconds > 0 ? Math.min(1, remaining / totalSeconds) : 0;
  const closed = known && remaining === 0;
  // Below 100 px the caption does not fit inside the dial: the ring keeps the time and the caption goes to aria-label.
  const compact = size < 100;
  const text = known ? formatCountdown(remaining) : "--:--";
  const stroke = size < 64 ? 2.5 : 3;
  const r = size / 2 - (size < 64 ? 7 : 10);
  const c = 2 * Math.PI * r;
  const mid = size / 2;
  return (
    <div
      data-tone="review"
      role="timer"
      aria-label={known ? (closed ? `Review window closed` : `Review window: ${formatCountdown(remaining)} left`) : "Review window"}
      className={cx("relative inline-grid shrink-0 place-items-center", className)}
      style={{ width: size, height: size }}
    >
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90">
        {Array.from({ length: TICKS }, (_, i) => {
          const a = (i / TICKS) * 2 * Math.PI;
          const lit = i / TICKS < fraction;
          const r1 = mid - (size < 64 ? 1.5 : 3);
          const r2 = r1 - (i % 4 === 0 ? (size < 64 ? 3 : 4) : 2);
          return (
            <line
              key={i}
              x1={r2dp(mid + r1 * Math.cos(a))}
              y1={r2dp(mid + r1 * Math.sin(a))}
              x2={r2dp(mid + r2 * Math.cos(a))}
              y2={r2dp(mid + r2 * Math.sin(a))}
              stroke={lit ? "var(--tone)" : "var(--hairline-strong)"}
              strokeOpacity={lit ? 0.55 : 1}
              strokeWidth={1}
            />
          );
        })}
        <circle cx={mid} cy={mid} r={r} fill="none" stroke="var(--hairline)" strokeWidth={stroke} />
        <circle
          cx={mid}
          cy={mid}
          r={r}
          fill="none"
          stroke="var(--tone)"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={r2dp(c)}
          strokeDashoffset={r2dp(c * (1 - fraction))}
          style={{ transition: "stroke-dashoffset 900ms var(--ease-glide)" }}
        />
      </svg>
      <div className="relative text-center">
        <p className={cx("font-mono leading-none tabular", size < 64 ? (text.length > 5 ? "text-[8.5px] tracking-[-0.04em]" : "text-[10.5px] tracking-[-0.02em]") : compact ? (text.length > 5 ? "text-[11.5px]" : "text-[13.5px]") : "text-[15px]", closed ? "text-fg-muted" : "text-fg")}>
          {text}
        </p>
        {compact ? null : <p className="mt-1 font-mono text-[8.5px] tracking-[0.08em] text-tone uppercase">{closed ? closedLabel : label}</p>}
      </div>
    </div>
  );
}
