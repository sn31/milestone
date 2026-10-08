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

export type Tone = "neutral" | "info" | "progress" | "attention" | "success" | "warning" | "danger" | "partial";

/** Every contract and milestone status gets its own tone. Unknown statuses fall back to neutral. */
const STATUS_TONE: Record<string, Tone> = {
  // contracts
  draft: "neutral",
  approved: "info",
  active: "success",
  closed: "neutral",
  // milestones
  funded: "info",
  verifying: "progress",
  review: "attention",
  needs_client: "warning",
  held: "danger",
  released: "success",
  partial_released: "partial",
};

export function statusTone(status: string): Tone {
  return STATUS_TONE[status] ?? "neutral";
}

/** Tailwind classes per tone: full class strings so Tailwind's scanner sees them. */
export const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-zinc-100 text-zinc-700 ring-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:ring-zinc-700",
  info: "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800",
  progress: "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-800",
  attention: "bg-indigo-50 text-indigo-800 ring-indigo-200 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-800",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800",
  warning: "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800",
  danger: "bg-rose-50 text-rose-800 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-800",
  partial: "bg-teal-50 text-teal-800 ring-teal-200 dark:bg-teal-950 dark:text-teal-300 dark:ring-teal-800",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-zinc-400",
  info: "bg-sky-500",
  progress: "bg-violet-500",
  attention: "bg-indigo-500",
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  partial: "bg-teal-500",
};
