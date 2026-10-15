import Link from "next/link";
import type { ReactNode } from "react";
import { policyRule } from "@/lib/policy-rules";
import { cx } from "./cx";
import { StateGlyph } from "./state-pill";
import { VERDICT_GLYPH, verdictTone, type GlyphKey, type ToneKey } from "./states";

export interface ReceiptProps {
  /** Serif heading, e.g. "Verdict". */
  title: ReactNode;
  /** Mono line under the title: delivery id, model, time. */
  meta?: ReactNode;
  /** <ReceiptRow>s. */
  children: ReactNode;
  /** Below a dashed rule at the foot: totals and the <Stamp>. */
  footer?: ReactNode;
  className?: string;
}

/** A verdict printed as a till receipt: paper surface, perforated top and bottom edges, dashed rules. */
export function Receipt({ title, meta, children, footer, className }: ReceiptProps) {
  return (
    <div className={cx("receipt-edge relative border-x border-hairline bg-paper px-5 pt-7 pb-8 sm:px-7", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-dashed border-hairline-strong pb-4">
        <h3 className="type-display-s text-fg">{title}</h3>
        {meta ? <div className="font-mono text-[11px] text-fg-faint tabular">{meta}</div> : null}
      </div>
      <div>{children}</div>
      {footer ? <div className="mt-2 border-t border-dashed border-hairline-strong pt-5">{footer}</div> : null}
    </div>
  );
}

export type CriterionStatus = "pass" | "fail" | "unclear";

export interface ReceiptRowProps {
  /** The criterion, in plain words. */
  label: ReactNode;
  status: CriterionStatus;
  /** 0..1, printed as "0.92". */
  confidence?: number;
  /** Mono tag before the label: criterion kind ("test", "file", "judgment"). */
  kind?: string;
  /** Why: the verifier's rationale. */
  detail?: ReactNode;
  required?: boolean;
  /** A small gauge printed beside the status (e.g. the confidence bar). On mobile it drops under the label. */
  meter?: ReactNode;
  /** <EvidenceChip>s torn off under the row. */
  children?: ReactNode;
  /** The word printed in the status column instead of the status (e.g. "clean", "client"). */
  statusLabel?: string;
  /** The row's tone instead of the status's (e.g. needs for a judgment left to the client). */
  tone?: ToneKey;
  /** The glyph instead of the status's. */
  glyph?: GlyphKey;
}

/**
 * One criterion on the receipt: label, dotted leader, gauge and status in mono; rationale and evidence underneath. The
 * status sits in a fixed 8ch column so PASS, FAIL, UNCLEAR and CLIENT line up down the receipt.
 */
export function ReceiptRow({ label, status, confidence, kind, detail, required, meter, children, statusLabel, tone: toneOverride, glyph }: ReceiptRowProps) {
  const tone = toneOverride ?? verdictTone(status);
  return (
    <div data-tone={tone} className="border-b border-dashed border-hairline py-3.5 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <span className="mt-[3px] grid size-4 shrink-0 place-items-center self-start rounded-chip bg-tone-soft text-tone">
          <StateGlyph glyph={glyph ?? VERDICT_GLYPH[status]} className="size-[9px]" />
        </span>
        <span className="min-w-0 text-[14px] text-fg">
          {kind ? <span className="type-label mr-2 text-[10px] text-fg-faint">{kind}</span> : null}
          {label}
          {required === false ? <span className="ml-2 text-[12px] text-fg-faint">optional</span> : null}
        </span>
        <span aria-hidden className="leader hidden sm:block" />
        {meter ? <span className="hidden shrink-0 self-center sm:block">{meter}</span> : null}
        <span className="ml-auto w-[8.5ch] shrink-0 text-right font-mono text-[12px] uppercase tracking-[0.08em] whitespace-nowrap text-tone tabular sm:ml-0">
          {statusLabel ?? status}
          {confidence !== undefined ? <span className="ml-2 text-fg-muted">{confidence.toFixed(2)}</span> : null}
        </span>
      </div>
      {meter ? <div className="mt-1.5 pl-7 sm:hidden">{meter}</div> : null}
      {detail ? <p className="mt-1.5 pl-7 text-[13px] leading-relaxed text-fg-muted">{detail}</p> : null}
      {children ? <div className="mt-2.5 flex flex-wrap gap-2 pl-7">{children}</div> : null}
    </div>
  );
}

export interface EvidenceChipProps {
  /** log, diff, file, screenshot, replay, note. */
  kind: string;
  /** Evidence id. */
  id: string;
  /** Deterministic status of the evidence when it came from a tool. */
  status?: CriterionStatus;
  href?: string;
  /** Hover title, e.g. the evidence summary. */
  title?: string;
}

/** A tear-off evidence stub: the kind on a perforated stub, the id on the body. Links to the evidence when given href. */
export function EvidenceChip({ kind, id, status, href, title }: EvidenceChipProps) {
  const tone = verdictTone(status);
  const body = (
    <>
      <span className="relative flex items-center border-r border-dashed border-hairline-strong bg-tone-soft px-1.5 text-[10px] tracking-[0.1em] text-tone uppercase">
        {kind}
        <span aria-hidden className="absolute -top-[4px] -right-[4px] size-[7px] rounded-full border border-hairline-strong bg-paper" />
        <span aria-hidden className="absolute -right-[4px] -bottom-[4px] size-[7px] rounded-full border border-hairline-strong bg-paper" />
      </span>
      <span className="px-1.5 text-fg-muted tabular">{id}</span>
    </>
  );
  const cls =
    "inline-flex h-6 items-stretch overflow-hidden rounded-chip border border-hairline-strong bg-surface font-mono text-[11px] leading-6 " +
    "transition-transform duration-200 ease-glide hover:-translate-y-px hover:-rotate-1";
  return href ? (
    <Link data-tone={tone} href={href} title={title} className={cls}>
      {body}
    </Link>
  ) : (
    <span data-tone={tone} title={title} className={cls}>
      {body}
    </span>
  );
}

export interface StampProps {
  /** The policy action: release, partial, hold, ask_client; client_approved once the client approved an ask_client decision and the payout landed. */
  action: string;
  /** Rule ids, e.g. ["P6"]. */
  ruleIds?: string[];
  /** A short line under the action, e.g. the amount or "on Oct 8, 14:03 UTC". */
  note?: ReactNode;
  /** md: the receipt's foot (two lines, pressed in on mount). sm: one inked line for a folded receipt's summary. */
  size?: "sm" | "md";
  /** What happened after the decision, inked under it (e.g. "Approved by Casey · Oct 8 15:13"). */
  countersign?: ReactNode;
  className?: string;
}

const ACTION_TONE: Record<string, ToneKey> = { release: "released", partial: "partial", hold: "held", ask_client: "needs", client_approved: "released" };
const ACTION_LABEL: Record<string, string> = { release: "Release", partial: "Partial", hold: "Hold", ask_client: "Ask client", client_approved: "Client approved" };

/**
 * A rule id on the stamp with its one-sentence meaning: the sentence is the title, and a small "?" shows it on hover or
 * keyboard focus (CSS only). Inside a folded receipt's summary button the "?" is not focusable (no nested controls).
 */
export function RuleChip({ id, focusable = true, className }: { id: string; focusable?: boolean; className?: string }) {
  const sentence = policyRule(id);
  if (!sentence) return <span className={className}>{id}</span>;
  return (
    <span className={cx("group/rule relative inline-flex items-center gap-1 whitespace-nowrap", className)} title={`${id}: ${sentence}`}>
      {id}
      <span
        tabIndex={focusable ? 0 : undefined}
        aria-label={`What rule ${id} means`}
        className="grid size-[13px] cursor-help place-items-center rounded-full border border-current text-[8.5px] leading-none tracking-normal opacity-70 outline-none group-hover/rule:opacity-100 focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-current"
      >
        ?
      </span>
      <span
        role="tooltip"
        className={cx(
          "pointer-events-none absolute right-0 bottom-full z-20 mb-1.5 hidden w-[30ch] max-w-[80vw] rounded-chip border border-hairline-strong bg-paper px-2.5 py-2 text-left font-mono text-[10.5px] leading-snug tracking-normal normal-case text-fg shadow-md",
          "group-hover/rule:block group-focus-within/rule:block",
        )}
      >
        <span className="text-tone-ink">{id}</span> {sentence}
      </span>
    </span>
  );
}

/** The policy decision, inked like a rubber stamp: double-ruled, tilted 4 degrees, pressed in once on mount. */
export function Stamp({ action, ruleIds, note, size = "md", countersign, className }: StampProps) {
  const tone = ACTION_TONE[action] ?? "neutral";
  if (size === "sm") {
    return (
      <span
        data-tone={tone}
        className={cx("inline-flex -rotate-2 rounded-chip border-[1.5px] border-[color:var(--tone)] p-[2px]", className)}
      >
        <span className="flex items-center gap-2 rounded-[2px] border border-[color:var(--tone)] px-2 py-[3px] font-mono text-[10.5px] leading-none tracking-[0.16em] whitespace-nowrap text-tone-ink uppercase tabular">
          <span className="text-[11.5px] tracking-[0.2em]">{ACTION_LABEL[action] ?? action}</span>
          {ruleIds?.length ? (
            <span className="inline-flex items-center gap-1.5">
              {ruleIds.map((id, i) => (
                <span key={id} className="inline-flex items-center gap-1.5">
                  {i > 0 ? <span aria-hidden>·</span> : null}
                  <RuleChip id={id} focusable={false} />
                </span>
              ))}
            </span>
          ) : null}
          {/* The amount is on the station already; on a phone the stamp keeps to the action and rule. */}
          {note ? <span className="max-sm:hidden">{note}</span> : null}
        </span>
      </span>
    );
  }
  return (
    <div data-tone={tone} className={cx("inline-block animate-stamp rounded-chip border-2 border-[color:var(--tone)] p-[3px]", className)}>
      <div className="rounded-[2px] border border-[color:var(--tone)] px-3 py-2 text-tone">
        <p className="font-mono text-[15px] leading-none tracking-[0.22em] uppercase">{ACTION_LABEL[action] ?? action}</p>
        {ruleIds?.length || note ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] tracking-[0.12em] uppercase text-tone-ink">
            {ruleIds?.length ? (
              <span className="inline-flex items-center gap-1.5">
                rule
                {ruleIds.map((id, i) => (
                  <span key={id} className="inline-flex items-center gap-1.5">
                    {i > 0 ? <span aria-hidden>·</span> : null}
                    <RuleChip id={id} />
                  </span>
                ))}
              </span>
            ) : null}
            {note ? <span>{note}</span> : null}
          </p>
        ) : null}
        {countersign ? <p className="mt-2 border-t border-dashed border-[color:var(--tone)] pt-1.5 font-mono text-[10px] tracking-[0.1em] text-tone-ink uppercase">{countersign}</p> : null}
      </div>
    </div>
  );
}
