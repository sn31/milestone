"use client";

import { Fragment, type ReactNode } from "react";
import { Money, cx } from "@/components/ui";
import { minorDigits } from "@/lib/format";

/**
 * The response as a document: paragraphs in the body face, every bracketed citation ([T2, L1]) as a row of mono chips
 * that light the cited row of the evidence pack on hover and open it on click, and every "100.00 USD" the template
 * prints as a <Money> figure. The text itself is what PayPal receives; this is only how it reads here.
 */

const CITE = /\[([A-Z]\d+(?:\s*,\s*[A-Z]\d+)*)\]/g;
const AMOUNT = /\b(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d+))? ([A-Z]{3})\b/g;

/** The case file (the <article data-case> around this text) holds the pack rows, each marked data-cite="T2" (or a list). */
function targets(from: Element, id: string): HTMLElement[] {
  const scope = from.closest("[data-case]");
  return scope ? [...scope.querySelectorAll<HTMLElement>(`[data-cite~="${id}"]`)] : [];
}

function light(from: Element, ids: string[], on: boolean) {
  for (const id of ids) for (const el of targets(from, id)) el.toggleAttribute("data-hl", on);
}

/** Opens whatever hides the cited row (a folded section, the folded receipt), scrolls it into view and flashes it. */
function reveal(from: Element, ids: string[]) {
  const els = ids.flatMap((id) => targets(from, id));
  for (const el of els) {
    const fold = el.closest("details");
    if (fold && !fold.open) fold.open = true;
    // The folded receipt (VerdictView) opens from its own summary button.
    const unfold = el.matches("[data-cite-unfold]") ? el.querySelector<HTMLButtonElement>("button[aria-expanded='false']") : null;
    unfold?.click();
  }
  // Scroll to the cited row itself rather than a summary figure that also cites it.
  const first = els.find((el) => el.tagName === "LI") ?? els[0];
  if (!first) return;
  requestAnimationFrame(() => first.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" }));
  for (const el of els) {
    el.setAttribute("data-hl", "");
    window.setTimeout(() => el.removeAttribute("data-hl"), 1600);
  }
}

export function CiteChips({ ids }: { ids: string[] }) {
  return (
    <span className="mx-[0.2em] inline-flex translate-y-[-1px] flex-wrap gap-[3px] align-middle">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          title={`Show ${id} in the evidence pack`}
          onMouseEnter={(e) => light(e.currentTarget, [id], true)}
          onMouseLeave={(e) => light(e.currentTarget, [id], false)}
          onFocus={(e) => light(e.currentTarget, [id], true)}
          onBlur={(e) => light(e.currentTarget, [id], false)}
          onClick={(e) => reveal(e.currentTarget, [id])}
          className="inline-flex h-[18px] items-center rounded-chip border border-hairline-strong bg-surface-sunken px-1 font-mono text-[10.5px] leading-none tracking-[0.04em] text-fg-muted tabular transition-colors duration-200 hover:border-[color:var(--focus)] hover:text-fg"
        >
          {id}
        </button>
      ))}
    </span>
  );
}

/** "100.00 USD" as minor units when the decimals match the currency's; null otherwise (the text stays as written). */
function amountMinor(whole: string, frac: string | undefined, currency: string): number | null {
  const digits = minorDigits(currency);
  if ((frac?.length ?? 0) !== digits) return null;
  const n = Number(whole.replace(/,/g, "")) * 10 ** digits + (frac ? Number(frac) : 0);
  return Number.isSafeInteger(n) ? n : null;
}

/** One run of plain text with its amounts set as money. */
function withAmounts(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(AMOUNT)) {
    const minor = amountMinor(m[1]!, m[2], m[3]!);
    if (minor === null) continue;
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<Money key={`${key}-${m.index}`} minor={minor} currency={m[3]!} className="text-[0.93em]" />);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Plain text with its "100.00 USD" amounts set as money (the pack's timeline summaries). */
export function MoneyText({ text }: { text: string }) {
  return <>{withAmounts(text, "m")}</>;
}

/** A paragraph with its citations as chips and its amounts as money. */
function Paragraph({ text, index }: { text: string; index: number }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(CITE)) {
    // The space before a citation belongs to the chip's own margin.
    const before = text.slice(last, m.index).replace(/\s+$/, "");
    parts.push(<Fragment key={`t${m.index}`}>{withAmounts(before, `p${index}-${m.index}`)}</Fragment>);
    parts.push(<CiteChips key={`c${m.index}`} ids={m[1]!.split(/\s*,\s*/)} />);
    last = m.index + m[0].length;
  }
  parts.push(<Fragment key="end">{withAmounts(text.slice(last), `p${index}-end`)}</Fragment>);
  return <p>{parts}</p>;
}

/** The whole response, paragraph by paragraph. */
export function ResponseText({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className={cx("grid gap-4 text-[14.5px] leading-[1.7] text-fg", className)}>
      {paragraphs.map((p, i) => (
        <Paragraph key={i} text={p} index={i} />
      ))}
    </div>
  );
}
