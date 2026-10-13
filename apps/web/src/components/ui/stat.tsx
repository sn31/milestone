import type { ReactNode } from "react";
import { CountUp } from "./count-up";
import { cx } from "./cx";
import { Money } from "./money";
import type { ToneKey } from "./states";

export type StatProps = {
  label: ReactNode;
  /** l: 32px figure (page headers, ledgers); xl: 48px (instrument panels). */
  size?: "l" | "xl";
  /** Colours the figure and draws a tone tick before the label. */
  tone?: ToneKey;
  /** One short line under the figure. */
  hint?: ReactNode;
  /** Count from the old figure to the new one when the value changes while the page is open (default true). The first
   *  paint always shows the final figure. */
  animate?: boolean;
  className?: string;
} & ({ minor: number; currency: string; value?: never; decimals?: never; suffix?: never } | { value: number; decimals?: number; suffix?: string; minor?: never; currency?: never });

/** A label and one big mono figure, final on first paint, counting when it changes live. Money when given minor + currency,
 *  otherwise a plain number. */
export function Stat(props: StatProps) {
  const { label, size = "l", tone, hint, animate = true, className } = props;
  return (
    <div data-tone={tone} className={cx("min-w-0", className)}>
      <p className="type-label flex items-center gap-2 text-fg-faint">
        {tone ? <span aria-hidden className="size-1.5 rounded-full bg-tone" /> : null}
        {label}
      </p>
      <p className="mt-2">
        {props.minor !== undefined ? (
          <Money minor={props.minor} currency={props.currency} size={size} animate={animate} tone={tone} />
        ) : (
          <span className={cx(size === "xl" ? "type-num-xl" : "type-num-l", tone ? "text-tone" : "text-fg")}>
            {animate ? <CountUp value={props.value} decimals={props.decimals} suffix={props.suffix} /> : `${props.value}${props.suffix ?? ""}`}
          </span>
        )}
      </p>
      {hint ? <p className="mt-1.5 text-[13px] text-fg-muted">{hint}</p> : null}
    </div>
  );
}
