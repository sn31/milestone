import { cx, StateGlyph } from "@/components/ui";

export interface CriterionItem {
  id: string;
  kind: string;
  description: string;
  required: boolean;
}

/**
 * The release conditions of a milestone, printed like the spec side of a receipt: a box per check, its kind in mono,
 * the condition, a dotted leader and whether it is required. `checking` marks every box as being worked on (verifying).
 */
export function CriteriaList({ items, checking = false, className }: { items: CriterionItem[]; checking?: boolean; className?: string }) {
  const required = items.filter((c) => c.required).length;
  return (
    <div className={cx("overflow-hidden rounded-panel border border-hairline bg-surface-sunken", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-dashed border-hairline-strong px-4 py-2.5">
        <p className="type-label text-fg-faint">Release conditions</p>
        <p className="shrink-0 font-mono text-[11px] whitespace-nowrap text-fg-faint tabular">
          {items.length} {items.length === 1 ? "check" : "checks"} · {required} required
        </p>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-3 text-[13px] text-fg-muted">No checks on this milestone; the client releases it by hand.</p>
      ) : (
        <ol className="divide-y divide-dashed divide-hairline">
          {items.map((c, i) => (
            <li key={c.id} data-tone={checking ? "verifying" : "neutral"} className="grid grid-cols-[16px_minmax(0,1fr)] gap-x-3 px-4 py-3">
              <span
                aria-hidden
                className={cx(
                  "mt-[3px] grid size-4 place-items-center rounded-chip border",
                  checking ? "border-tone bg-tone-soft text-tone" : "border-hairline-strong text-fg-faint",
                )}
              >
                {checking ? <StateGlyph glyph="pulse" className="size-[9px]" /> : <span className="font-mono text-[8.5px] leading-none tabular">{i + 1}</span>}
              </span>
              <div className="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
                <span className="min-w-0 text-[14px] leading-snug text-fg">
                  <span className="type-label mr-2 text-[10px] text-fg-faint">{c.kind}</span>
                  {c.description}
                </span>
                <span aria-hidden className="leader hidden sm:block" />
                <span className={cx("shrink-0 font-mono text-[10.5px] tracking-[0.1em] uppercase", c.required ? "text-fg-muted" : "text-fg-faint")}>
                  {checking ? <span className="text-tone">checking</span> : c.required ? "required" : "optional"}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
