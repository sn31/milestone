import { formatMoney, formatMoneyParts, minorDigits } from "@/lib/format";
import { CountUp } from "./count-up";
import { cx } from "./cx";
import type { ToneKey } from "./states";

export interface MoneyProps {
  /** Integer minor units. */
  minor: number;
  currency: string;
  /** s 14px (inline), m 20px (row totals), l 32px (stats), xl 48px (instrument panel). */
  size?: "s" | "m" | "l" | "xl";
  /** Count the whole units up on first mount. */
  animate?: boolean;
  /** Colours the integer part in a state's colour. */
  tone?: ToneKey;
  /** Prefix "+" for positive amounts (ledger movements). */
  signed?: boolean;
  className?: string;
}

const SIZE = { s: "type-num-s", m: "type-num-m", l: "type-num-l", xl: "type-num-xl" } as const;

/**
 * Every amount on screen. Geist Mono, tabular figures; the symbol and decimals are muted so the eye lands on the whole
 * units. Screen readers get the plain formatted amount.
 */
export function Money({ minor, currency, size = "s", animate = false, tone, signed = false, className }: MoneyProps) {
  const p = formatMoneyParts(minor, currency);
  const whole = Math.trunc(Math.abs(minor) / 10 ** minorDigits(currency));
  const sign = p.sign || (signed && minor > 0 ? "+" : "");
  const symbol = <span className="text-fg-faint text-[0.78em]">{p.symbol}</span>;
  return (
    <span data-tone={tone} className={cx("inline-flex items-baseline whitespace-nowrap", SIZE[size], className)}>
      <span className="sr-only">{`${sign === "+" ? "+" : ""}${formatMoney(minor, currency)}`}</span>
      <span aria-hidden className="inline-flex items-baseline">
        {sign ? <span className={tone ? "text-tone" : "text-fg"}>{sign === "-" ? "−" : sign}</span> : null}
        {p.symbolAfter ? null : <span className="mr-[0.12em]">{symbol}</span>}
        <span className={tone ? "text-tone" : "text-fg"}>{animate ? <CountUp value={whole} /> : p.integer}</span>
        <span className="text-fg-faint">{p.fraction}</span>
        {p.symbolAfter ? <span className="ml-[0.3em]">{symbol}</span> : null}
      </span>
    </span>
  );
}
