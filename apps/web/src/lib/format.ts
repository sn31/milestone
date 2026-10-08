// Display helpers. Safe in server and client components (no imports).

/** Same zero-decimal set as toPayPalValue in @milestone/core: minor units are whole units for these. */
const ZERO_DECIMAL = new Set(["JPY", "KRW", "HUF", "TWD"]);

export function minorDigits(currency: string): number {
  return ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
}

/** Integer minor units + currency -> "$1,234.56". */
export function formatMoney(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  const major = minor / 10 ** digits;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(major);
  } catch {
    return `${major.toFixed(digits)} ${currency.toUpperCase()}`;
  }
}

// Dates render on the server; a fixed locale and time zone keep the output stable across machines.
const DATE = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
const DATE_TIME = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/** "Oct 8, 2026", or "none". */
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "none";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "none" : DATE.format(date);
}

/** "Oct 8, 2026, 14:03:22 UTC", or "none". */
export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "none";
  const date = typeof d === "string" ? new Date(d) : d;
  return Number.isNaN(date.getTime()) ? "none" : `${DATE_TIME.format(date)} UTC`;
}

/** "needs_client" -> "needs client", "contract.approved_by_client" -> "contract approved by client". */
export function humanize(s: string): string {
  return s.replace(/[._]+/g, " ").trim();
}

/** Money split for typesetting: the symbol and the fraction are set muted, the integer part at full strength. */
export interface MoneyParts {
  sign: "" | "-";
  /** Currency symbol or code, e.g. "$" or "CHF". */
  symbol: string;
  /** true when the symbol follows the number ("12.00 XYZ"). */
  symbolAfter: boolean;
  /** Grouped whole units, e.g. "1,234". */
  integer: string;
  /** Decimal separator and digits, e.g. ".56", or "" for zero-decimal currencies. */
  fraction: string;
}

export function formatMoneyParts(minor: number, currency: string): MoneyParts {
  const digits = minorDigits(currency);
  const major = Math.abs(minor) / 10 ** digits;
  const sign = minor < 0 ? "-" : "";
  const code = currency.toUpperCase();
  try {
    const parts = new Intl.NumberFormat("en-US", { style: "currency", currency: code, minimumFractionDigits: digits, maximumFractionDigits: digits }).formatToParts(major);
    const symIdx = parts.findIndex((p) => p.type === "currency");
    const intIdx = parts.findIndex((p) => p.type === "integer");
    const integer = parts.filter((p) => p.type === "integer" || p.type === "group").map((p) => p.value).join("");
    const fraction = parts.filter((p) => p.type === "decimal" || p.type === "fraction").map((p) => p.value).join("");
    return { sign, symbol: (parts[symIdx]?.value ?? code).trim(), symbolAfter: symIdx > intIdx, integer, fraction };
  } catch {
    const [i, f] = major.toFixed(digits).split(".");
    return { sign, symbol: code, symbolAfter: true, integer: Number(i).toLocaleString("en-US"), fraction: f ? `.${f}` : "" };
  }
}

/** Integer minor units -> "1,234.56" (no symbol): the number a count-up animates through. */
export function formatAmount(minor: number, currency: string): string {
  const digits = minorDigits(currency);
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(minor / 10 ** digits);
}

/** "1,234" or "12.5" with a fixed number of decimals. */
export function formatNumber(n: number, decimals = 0): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n);
}

/** Seconds -> "19:42", "3:04:05", or "2d 04h" for long windows. Negative values read as zero. */
export function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (d > 0) return `${d}d ${pad(h)}h`;
  if (h > 0) return `${h}:${pad(m)}:${pad(sec)}`;
  return `${pad(m)}:${pad(sec)}`;
}

/** "a1b2c3d4e5f6" -> "a1b2c3…e5f6". Short values are returned unchanged. */
export function truncateMiddle(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}\u2026${value.slice(-tail)}`;
}
