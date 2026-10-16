"use client";

import { StatePill, StateGlyph, cx } from "@/components/ui";
import type { ApprovalLink, ToolServer } from "@/lib/agent/protocol";
import { SERVER_LABEL } from "@/lib/agent/protocol";
import { formatArgs } from "@/lib/agent/tools";

export interface ChipState {
  id: string;
  server: ToolServer;
  tool: string;
  args: unknown;
  result?: { ok: boolean; summary: string; status: string | null; links: ApprovalLink[] };
}

/**
 * One MCP tool call: which server and tool, its arguments, and a one-line result. A refusal reads in danger; a
 * result that names a milestone status carries that status's pill. Pending calls show a live dot.
 */
export function ToolChip({ chip }: { chip: ChipState }) {
  const r = chip.result;
  const tone = !r ? "neutral" : r.ok ? "neutral" : "danger";
  const args = formatArgs(chip.args);
  return (
    <div data-tone={tone} className={cx("rounded-chip border bg-surface-sunken px-3 py-2", r && !r.ok ? "border-tone" : "border-hairline")}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono text-[12px] leading-5">
        <span className="shrink-0 text-fg-faint">{SERVER_LABEL[chip.server]} ·</span>
        <span className="shrink-0 text-fg">{chip.tool}</span>
        {args ? <span className="min-w-0 truncate text-fg-faint">{args}</span> : null}
      </div>
      <div className="mt-1 flex min-w-0 items-center gap-2 font-mono text-[12px] leading-5">
        {!r ? (
          <>
            <span aria-hidden className="size-[7px] shrink-0 animate-pulse-dot rounded-full bg-fg-faint" />
            <span className="text-fg-faint">calling…</span>
          </>
        ) : (
          <>
            <StateGlyph glyph={r.ok ? "check" : "cross"} className={r.ok ? "shrink-0 text-fg-faint" : "shrink-0 text-tone"} />
            <span className={cx("min-w-0 truncate", r.ok ? "text-fg-muted" : "text-tone-ink")} title={r.summary}>
              {r.summary}
            </span>
            {r.status ? <StatePill state={r.status} className="ml-auto shrink-0" /> : null}
          </>
        )}
      </div>
    </div>
  );
}
