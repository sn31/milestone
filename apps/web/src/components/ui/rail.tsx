import type { ReactNode } from "react";
import { cx } from "./cx";
import { StateGlyph } from "./state-pill";
import { stateMeta, type GlyphKey, type Phase, type ToneKey } from "./states";
import { Transit, type TransitProps } from "./transit";

/** The vertical milestone rail. Children are <Station>s in order; side tracks are Stations with `branch`. */
export function Rail({ children, className, label = "Milestone progress" }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <ol aria-label={label} className={cx("relative", className)}>
      {children}
    </ol>
  );
}

export interface StationProps {
  /** The station's state colour. Use toneOf(status). */
  tone: ToneKey;
  /** done: passed (solid node, solid connector); current: where the money is now (ringed, glowing); upcoming: hollow, dashed. */
  phase?: Phase;
  title: ReactNode;
  /** Small line(s) under the title: counterparties, timestamps, ids. */
  meta?: ReactNode;
  /** Right-aligned: usually <Money> and/or <StatePill>. */
  aside?: ReactNode;
  /** Text inside the node (e.g. "01"); defaults to the phase's glyph. */
  marker?: string;
  /** Glyph for a done node. Defaults to a check. */
  glyph?: GlyphKey;
  /** A side track (held, needs_client, partial): indented, joined to the main line by an elbow. */
  branch?: boolean;
  /** Money moving down this station's connector, once on mount (funding, release). */
  transit?: Omit<TransitProps, "className">;
  /** Draw the connector to the next station. Default: true on the main track, false on a branch (set true when the next station is on the same side track, e.g. needs_client -> partial_released). */
  connect?: boolean;
  /** Expanded content under the title: LogStream, CountdownRing, receipts. */
  children?: ReactNode;
  className?: string;
}

function Node({ phase, marker, glyph, live }: { phase: Phase; marker?: string; glyph: GlyphKey; live: boolean }) {
  if (phase === "current") {
    return (
      <span className="relative grid size-[22px] place-items-center rounded-full border-[1.5px] border-[color:var(--tone)] bg-bg glow-tone text-tone">
        {marker ? (
          <span className="font-mono text-[9px] leading-none tabular">{marker}</span>
        ) : (
          <span className={cx("size-2 rounded-full bg-tone", live && "animate-pulse-dot")} />
        )}
      </span>
    );
  }
  if (phase === "done") {
    return (
      <span className="grid size-[18px] place-items-center rounded-full bg-tone text-bg">
        {marker ? <span className="font-mono text-[9px] leading-none tabular">{marker}</span> : <StateGlyph glyph={glyph} className="size-[9px]" />}
      </span>
    );
  }
  return (
    <span className="grid size-[14px] place-items-center rounded-full border border-hairline-strong bg-bg text-fg-faint">
      {marker ? <span className="font-mono text-[8px] leading-none tabular">{marker}</span> : null}
    </span>
  );
}

const CONNECTOR: Record<Phase, string> = {
  done: "w-[2px] bg-[color-mix(in_oklab,var(--tone)_60%,transparent)]",
  // The fade is a fixed length at each end, not a share of the station: a tall station (review card, receipt) keeps a
  // readable line all the way down instead of thinning to a hairline halfway.
  current:
    "w-[2px] bg-[linear-gradient(to_bottom,var(--tone)_0px,color-mix(in_oklab,var(--tone)_62%,transparent)_96px,color-mix(in_oklab,var(--tone)_52%,transparent)_calc(100%_-_72px),color-mix(in_oklab,var(--tone)_30%,var(--hairline-strong))_100%)]",
  upcoming: "w-0 border-l border-dashed border-hairline-strong",
};

/**
 * One station on the rail: a node in a 28px gutter, a connector to the next station, and the content on the right.
 * The connector colour encodes the money: solid when it has passed, a fade from the state colour when it is here, dashed
 * when it has not arrived.
 */
export function Station({ tone, phase = "upcoming", title, meta, aside, marker, glyph = "check", branch = false, connect = !branch, transit, children, className }: StationProps) {
  const live = tone === "verifying" && phase === "current";
  return (
    <li data-tone={tone} className={cx("group/station relative pb-8 last:pb-0", branch && "pl-7", className)}>
      {branch ? (
        <>
          {/* The main line passes by; the elbow leads into the side track. */}
          <span aria-hidden className="absolute top-0 bottom-0 left-[13.5px] border-l border-dashed border-hairline-strong" />
          <svg aria-hidden className="absolute top-[-2px] left-[13px] h-[16px] w-[30px] overflow-visible" viewBox="0 0 30 16" fill="none">
            <path d="M1 0 C1 10, 6 12, 22 12" stroke="var(--tone)" strokeWidth="1.5" strokeLinecap="round" opacity={phase === "upcoming" ? 0.4 : 0.8} />
          </svg>
        </>
      ) : null}
      <div className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-4">
        <div className="relative flex justify-center pt-[3px]">
          <Node phase={phase} marker={marker} glyph={glyph} live={live} />
          {connect ? <span aria-hidden className={cx("absolute top-[28px] -bottom-8 left-1/2 -translate-x-1/2 group-last/station:hidden", CONNECTOR[phase])} /> : null}
          {transit ? <Transit {...transit} /> : null}
        </div>
        <div className="min-w-0">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
            <div className="min-w-0">
              <div className={cx("type-display-s", phase === "upcoming" ? "text-fg-muted" : "text-fg")}>{title}</div>
              {meta ? <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-fg-muted">{meta}</div> : null}
            </div>
            {aside ? <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end sm:gap-1.5">{aside}</div> : null}
          </div>
          {children ? <div className="mt-4">{children}</div> : null}
        </div>
      </div>
    </li>
  );
}

export interface RailCapProps {
  /** start: where the money enters (signed, funded into escrow); end: where it leaves (paid out). */
  at: "start" | "end";
  /** Mono label, e.g. "Escrow opens". */
  label: ReactNode;
  /** Right-hand detail: a date, an amount. */
  detail?: ReactNode;
  /** The cap's state colour. */
  tone: ToneKey;
  /** Filled once reached (the contract is signed / every milestone paid); hollow otherwise. */
  reached?: boolean;
  /** start only: how the line runs down to the first station: solid in the tone when money is on the main track, dashed when not. */
  line?: "solid" | "dashed";
  className?: string;
}

/**
 * The two ends of a contract's rail: where the client's money enters escrow and where it leaves to the freelancer. They
 * give side tracks a main line to branch from and give the rail a destination, so it reads as one track, not a list.
 */
export function RailCap({ at, label, detail, tone, reached = false, line = "dashed", className }: RailCapProps) {
  return (
    <li data-tone={tone} className={cx("relative grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-4", at === "start" ? "pb-7" : "pt-1", className)}>
      {at === "start" ? (
        <span
          aria-hidden
          className={cx(
            "absolute top-[14px] bottom-0 left-[13px]",
            line === "solid" ? "w-[2px] bg-[color-mix(in_oklab,var(--tone)_60%,transparent)]" : "w-0 border-l border-dashed border-hairline-strong",
          )}
        />
      ) : null}
      <span className="relative flex justify-center">
        <span
          className={cx(
            "grid size-[10px] place-items-center rounded-[3px] border-[1.5px]",
            reached ? "border-[color:var(--tone)] bg-tone" : "border-hairline-strong bg-bg",
          )}
        />
      </span>
      <p className="flex min-w-0 flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <span className={cx("type-label", reached ? "text-tone" : "text-fg-faint")}>{label}</span>
        {detail ? <span className="font-mono text-[11.5px] text-fg-muted tabular">{detail}</span> : null}
      </p>
    </li>
  );
}

export interface MiniRailItem {
  /** Milestone status. */
  state: string;
  /** Accessible name, e.g. "Signup form". */
  label?: string;
}

/**
 * A milestone rail in one line, for lists: one glyph per milestone in its state colour, joined by hairlines that turn
 * solid once the money before them has been paid out.
 */
export function MiniRail({ items, className }: { items: MiniRailItem[]; className?: string }) {
  if (items.length === 0) return <span className={cx("type-label text-fg-faint", className)}>No milestones</span>;
  return (
    <ol className={cx("flex items-center", className)} aria-label="Milestones">
      {items.map((it, i) => {
        const meta = stateMeta(it.state);
        const paid = it.state === "released" || it.state === "partial_released";
        return (
          <li key={i} data-tone={meta.tone} className="flex items-center" title={`${it.label ? `${it.label}: ` : ""}${meta.label}`}>
            {i > 0 ? <span aria-hidden className={cx("h-px w-4 sm:w-5", paid ? "bg-tone" : "bg-hairline-strong")} /> : null}
            <span className={cx("grid size-5 place-items-center rounded-chip text-tone", it.state !== "draft" && "bg-tone-soft")}>
              <StateGlyph glyph={meta.glyph} />
            </span>
            <span className="sr-only">{`${i + 1}. ${it.label ?? "Milestone"}: ${meta.label}`}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Where a contract's money is, as one 3px bar: a segment per milestone, its width the milestone's share of the total,
 * its colour the milestone's state (unfunded drafts are a hairline).
 */
export function MoneyBar({ items, className }: { items: { state: string; minor: number }[]; className?: string }) {
  const total = items.reduce((s, i) => s + Math.max(0, i.minor), 0);
  if (total <= 0) return null;
  return (
    <div aria-hidden className={cx("flex h-[3px] w-full gap-[2px]", className)}>
      {items.map((it, i) => {
        const meta = stateMeta(it.state);
        return (
          <span
            key={i}
            data-tone={meta.tone}
            className={cx("h-full rounded-full", it.state === "draft" ? "bg-hairline-strong" : "bg-tone", it.state === "verifying" && "animate-pulse")}
            style={{ width: `${(Math.max(0, it.minor) / total) * 100}%` }}
          />
        );
      })}
    </div>
  );
}
