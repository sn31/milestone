import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "./cx";
import { StateGlyph } from "./state-pill";
import { VERDICT_GLYPH, verdictTone, type ToneKey } from "./states";

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
}

/** One criterion on the receipt: label, dotted leader, gauge and status in mono; rationale and evidence underneath. */
export function ReceiptRow({ label, status, confidence, kind, detail, required, meter, children }: ReceiptRowProps) {
  const tone = verdictTone(status);
  return (
    <div data-tone={tone} className="border-b border-dashed border-hairline py-3.5 last:border-b-0">
      <div className="flex items-baseline gap-3">
        <span className="mt-[3px] grid size-4 shrink-0 place-items-center self-start rounded-chip bg-tone-soft text-tone">
          <StateGlyph glyph={VERDICT_GLYPH[status]} className="size-[9px]" />
        </span>
        <span className="min-w-0 text-[14px] text-fg">
          {kind ? <span className="type-label mr-2 text-[10px] text-fg-faint">{kind}</span> : null}
          {label}
          {required === false ? <span className="ml-2 text-[12px] text-fg-faint">optional</span> : null}
        </span>
        <span aria-hidden className="leader hidden sm:block" />
        {meter ? <span className="hidden shrink-0 self-center sm:block">{meter}</span> : null}
        <span className="ml-auto w-[4.5ch] shrink-0 text-right font-mono text-[12px] uppercase tracking-[0.08em] text-tone tabular sm:ml-0">
          {status}
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
  /** The policy action: release, partial, hold, ask_client. */
  action: string;
  /** Rule ids, e.g. ["P6"]. */
  ruleIds?: string[];
  /** A short line under the action, e.g. the amount or "on Oct 8, 14:03 UTC". */
  note?: ReactNode;
  /** md: the receipt's foot (two lines, pressed in on mount). sm: one inked line for a folded receipt's summary. */
  size?: "sm" | "md";
  className?: string;
}

const ACTION_TONE: Record<string, ToneKey> = { release: "released", partial: "partial", hold: "held", ask_client: "needs" };
const ACTION_LABEL: Record<string, string> = { release: "Release", partial: "Partial", hold: "Hold", ask_client: "Ask client" };

/** The policy decision, inked like a rubber stamp: double-ruled, tilted 4 degrees, pressed in once on mount. */
export function Stamp({ action, ruleIds, note, size = "md", className }: StampProps) {
  const tone = ACTION_TONE[action] ?? "neutral";
  if (size === "sm") {
    return (
      <span
        data-tone={tone}
        className={cx("inline-flex -rotate-2 rounded-chip border-[1.5px] border-[color:var(--tone)] p-[2px] opacity-90", className)}
      >
        <span className="flex items-center gap-2 rounded-[2px] border border-[color:var(--tone)] px-2 py-[3px] font-mono text-[10.5px] leading-none tracking-[0.16em] whitespace-nowrap text-tone uppercase tabular">
          <span className="text-[11.5px] tracking-[0.2em]">{ACTION_LABEL[action] ?? action}</span>
          {ruleIds?.length ? <span className="opacity-80">{ruleIds.join(" · ")}</span> : null}
          {/* The amount is on the station already; on a phone the stamp keeps to the action and rule. */}
          {note ? <span className="opacity-80 max-sm:hidden">{note}</span> : null}
        </span>
      </span>
    );
  }
  return (
    <div data-tone={tone} className={cx("inline-block animate-stamp rounded-chip border-2 border-[color:var(--tone)] p-[3px] opacity-90", className)}>
      <div className="rounded-[2px] border border-[color:var(--tone)] px-3 py-2 text-tone">
        <p className="font-mono text-[15px] leading-none tracking-[0.22em] uppercase">{ACTION_LABEL[action] ?? action}</p>
        {ruleIds?.length || note ? (
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[10px] tracking-[0.12em] uppercase opacity-80">
            {ruleIds?.length ? <span>rule {ruleIds.join(" · ")}</span> : null}
            {note ? <span>{note}</span> : null}
          </p>
        ) : null}
      </div>
    </div>
  );
}
