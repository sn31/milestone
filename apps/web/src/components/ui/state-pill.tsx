import { cx } from "./cx";
import { stateMeta, type GlyphKey, type ToneKey } from "./states";

/**
 * The 10px glyph for a state, drawn in currentColor (set data-tone + text-tone on an ancestor, or pass a colour class).
 * "pulse" is a live dot that breathes; it is the only animated glyph.
 */
export function StateGlyph({ glyph, className }: { glyph: GlyphKey; className?: string }) {
  if (glyph === "pulse") {
    return (
      <span aria-hidden className={cx("relative inline-grid size-2.5 shrink-0 place-items-center", className)}>
        <span className="size-[7px] animate-pulse-dot rounded-full bg-current" />
      </span>
    );
  }
  return (
    <svg aria-hidden viewBox="0 0 10 10" className={cx("size-2.5 shrink-0", className)} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      {glyph === "ring" ? <circle cx="5" cy="5" r="3.5" /> : null}
      {glyph === "dot" ? <circle cx="5" cy="5" r="3.75" fill="currentColor" stroke="none" /> : null}
      {glyph === "hollow-dot" ? (
        <>
          <circle cx="5" cy="5" r="3.5" />
          <circle cx="5" cy="5" r="1.4" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {glyph === "arc" ? (
        <>
          <circle cx="5" cy="5" r="3.5" opacity="0.35" />
          <path d="M5 1.5 A3.5 3.5 0 1 1 1.5 5" />
        </>
      ) : null}
      {glyph === "check" ? <path d="M1.8 5.3 L4.1 7.5 L8.3 2.6" strokeWidth={1.7} /> : null}
      {glyph === "half" ? (
        <>
          <circle cx="5" cy="5" r="3.5" />
          <path d="M5 1.5 A3.5 3.5 0 0 0 5 8.5 Z" fill="currentColor" stroke="none" />
        </>
      ) : null}
      {glyph === "pause" ? (
        <>
          <path d="M3.4 2 V8" strokeWidth={1.8} />
          <path d="M6.6 2 V8" strokeWidth={1.8} />
        </>
      ) : null}
      {glyph === "query" ? <path d="M5 1.2 L8.8 5 L5 8.8 L1.2 5 Z" /> : null}
      {glyph === "cross" ? <path d="M2.2 2.2 L7.8 7.8 M7.8 2.2 L2.2 7.8" strokeWidth={1.7} /> : null}
    </svg>
  );
}

export interface StatePillProps {
  /** Any contract or milestone status ("verifying", "needs_client", "active", ...). */
  state: string;
  size?: "sm" | "md";
  /** Overrides the label from STATE_META. */
  label?: string;
  /** Overrides the tone, e.g. "danger" for a failed op. */
  tone?: ToneKey;
  className?: string;
}

/**
 * A status, typeset like an instrument tag: mono caps, the state's glyph, its colour on a 10% wash with a 1px edge. The text
 * uses the state's ink (--tone-ink), one step darker on paper so 10px caps clear 4.5:1 on the wash.
 * Verifying shimmers and its dot breathes; nothing else moves.
 */
export function StatePill({ state, size = "sm", label, tone, className }: StatePillProps) {
  const meta = stateMeta(state);
  const t = tone ?? meta.tone;
  const live = state === "verifying";
  return (
    <span
      data-tone={t}
      className={cx(
        "relative inline-flex shrink-0 items-center overflow-hidden rounded-chip border border-tone bg-tone-soft font-mono uppercase text-tone-ink",
        size === "md" ? "h-6 gap-2 px-2 text-[11px] tracking-[0.12em]" : "h-5 gap-1.5 px-1.5 text-[10px] tracking-[0.1em]",
        className,
      )}
    >
      {live ? <span aria-hidden className="shimmer-tone absolute inset-0" /> : null}
      <StateGlyph glyph={meta.glyph} className="relative" />
      <span className="relative leading-none">{label ?? meta.label}</span>
    </span>
  );
}
