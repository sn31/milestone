"use client";

import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { cx } from "./cx";
import { EASE } from "./motion";
import type { ToneKey } from "./states";

/** A log line: plain text, or text with a timestamp and a tone (ok/warn/err map to released/held/danger). */
export type LogLine = string | { text: string; at?: string; tone?: ToneKey | "ok" | "warn" | "err" };

export interface LogStreamProps {
  lines: LogLine[];
  /** Still running: shows a blinking caret and keeps the newest line in view. */
  live?: boolean;
  /** Seconds between lines on first reveal. Long logs are compressed so the whole reveal takes at most ~1.6 s. */
  stagger?: number;
  /** Max height in px before it scrolls. Default 280. */
  maxHeight?: number;
  /** Caption in the well's header, e.g. "verifier · npm test". */
  title?: string;
  className?: string;
}

const TONE_ALIAS: Record<string, ToneKey> = { ok: "released", warn: "held", err: "danger" };

function norm(l: LogLine): { text: string; at?: string; tone?: ToneKey } {
  if (typeof l === "string") return { text: l };
  return { text: l.text, at: l.at, tone: l.tone ? (TONE_ALIAS[l.tone] ?? (l.tone as ToneKey)) : undefined };
}

/**
 * Monospace log in a sunken well; lines reveal one by one. Lines present on mount stagger in; lines appended later
 * (live streams) slide in as they arrive. Violet edge while live.
 */
export function LogStream({ lines, live = false, stagger = 0.06, maxHeight = 280, title, className }: LogStreamProps) {
  const [initial] = useState(lines.length);
  const step = initial > 0 ? Math.min(stagger, 1.6 / initial) : stagger;
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines.length, live]);
  return (
    <div data-tone={live ? "verifying" : "neutral"} className={cx("overflow-hidden rounded-panel border border-hairline bg-surface-sunken", live && "border-tone", className)}>
      {title || live ? (
        <div className="flex items-center justify-between gap-3 border-b border-hairline px-3 py-2">
          <p className="type-label truncate text-fg-faint">{title}</p>
          {live ? (
            <span className="type-label flex items-center gap-1.5 text-tone">
              <span className="size-1.5 animate-pulse-dot rounded-full bg-tone" />
              live
            </span>
          ) : null}
        </div>
      ) : null}
      <div ref={box} className="overflow-y-auto py-2 font-mono text-[12px] leading-[1.65]" style={{ maxHeight }}>
        <ol>
          {lines.map((raw, i) => {
            const l = norm(raw);
            return (
              <motion.li
                key={i}
                data-tone={l.tone}
                initial={{ opacity: 0, x: -4 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.28, ease: EASE.glide, delay: i < initial ? i * step : 0 }}
                className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 px-3 hover:bg-fg/[0.03]"
              >
                <span aria-hidden className="select-none text-right text-fg-faint/70 tabular">{i + 1}</span>
                <span className={cx("break-words whitespace-pre-wrap", l.tone ? "text-tone" : "text-fg-muted")}>
                  {l.at ? <span className="mr-2 text-fg-faint tabular">{l.at}</span> : null}
                  {l.text}
                </span>
              </motion.li>
            );
          })}
        </ol>
        {live ? (
          <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 px-3" aria-hidden>
            <span />
            <span className="inline-block h-[1.1em] w-[0.55em] translate-y-[2px] animate-caret bg-tone" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
