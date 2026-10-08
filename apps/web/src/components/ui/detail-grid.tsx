"use client";

// The expandable AG Grid ledgers (the evidence panel, the audit log): one item row per record, and under an open one a
// full-width row holding its log. Client only (AG Grid), so it is imported directly rather than through the ui barrel.
import { useEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { AgGridReact } from "ag-grid-react";
import type { GetRowIdParams, ICellRendererParams, IsFullWidthRowParams, RowHeightParams } from "ag-grid-community";
import { gridThemeInset } from "../ag-grid-theme";
import { cx } from "./cx";
import { LogStream, type LogLine } from "./log-stream";

/** A record as a grid row: the item itself, or the full-width detail row under it while it is open. */
export type DetailRow<T> = T & { rowKind: "item" | "detail"; rowKey: string; expanded: boolean };

/** Grid context: the chevron calls onToggle with the record id. */
export interface DetailCtx {
  onToggle: (id: string) => void;
}

/** Pure: each record as an item row, followed by its detail row when it is open. */
export function expandRows<T extends { id: string }>(items: readonly T[], open: ReadonlySet<string>): DetailRow<T>[] {
  return items.flatMap((it) => {
    const expanded = open.has(it.id);
    const base: DetailRow<T> = { ...it, rowKind: "item", rowKey: it.id, expanded };
    return expanded ? [base, { ...it, rowKind: "detail" as const, rowKey: `${it.id}:detail`, expanded }] : [base];
  });
}

/** Pure: a copy of `set` with `id` added or removed. */
export function toggled(set: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(set);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Extra cellRendererParams for ToggleCell: the button's label, and whether a row can open at all (default yes). */
export interface ToggleCellParams<T> {
  label: (row: DetailRow<T>) => string;
  expandable?: (row: DetailRow<T>) => boolean;
}

/** The chevron that opens and closes an item row's detail. */
export function ToggleCell<T extends { id: string }>(p: ICellRendererParams<DetailRow<T>, unknown, DetailCtx> & ToggleCellParams<T>) {
  if (!p.data || p.data.rowKind !== "item" || (p.expandable && !p.expandable(p.data))) return null;
  const { id, expanded } = p.data;
  return (
    <div className="flex h-full items-center">
      <button
        type="button"
        onClick={() => p.context.onToggle(id)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${p.label(p.data)}`}
        className="grid size-6 place-items-center rounded-chip text-fg-faint transition-colors duration-200 hover:bg-surface-raised hover:text-fg"
      >
        <svg aria-hidden viewBox="0 0 10 10" className={cx("size-2.5 transition-transform duration-200 ease-glide", expanded && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3.5 1.8 L6.8 5 L3.5 8.2" />
        </svg>
      </button>
    </div>
  );
}

/** The full-width detail row: the record's log in a sunken well, indented under the chevron column from sm. */
export function DetailLogRow({ lines, title, maxHeight }: { lines: LogLine[]; title: string; maxHeight: number }) {
  return (
    <div className="h-full px-3 py-3 sm:pl-[52px]">
      <LogStream lines={lines} maxHeight={maxHeight} stagger={0.03} title={title} />
    </div>
  );
}

/** Geist Mono at 12px advances 0.6em per character; a little slack for word wrapping. */
const CHAR = 7.2 * 1.03;
const LINE = 19.8;

/**
 * Height of a full-width log row (a LogStream well inside 12px of row padding): the well's header, its padding and the
 * lines as they wrap at this grid width, capped where the well starts to scroll.
 */
export function logRowHeight(lines: LogLine[], gridWidth: number, narrow: boolean, max: number): number {
  // row padding (12 + 12, or 52 + 12 from sm), well borders, line padding (12 + 12), line-number gutter and gap
  const text = Math.max(120, (gridWidth || 1000) - (narrow ? 24 : 64) - 2 - 24 - 36 - 8);
  const perLine = Math.max(8, Math.floor(text / CHAR));
  let n = 0;
  for (const l of lines) {
    const t = typeof l === "string" ? l : `${l.at ? `${l.at}  ` : ""}${l.text}`;
    n += Math.max(1, Math.ceil(t.length / perLine));
  }
  return Math.round(24 + 33 + Math.min(16 + n * LINE, max) + 2);
}

/** Width of an element in px, kept current with a ResizeObserver; 0 until measured. */
export function useWidth(ref: RefObject<HTMLElement | null>): number {
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

const NARROW = "(max-width: 639px)";
const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia(NARROW);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getNarrow = () => window.matchMedia(NARROW).matches;
/** true below the sm breakpoint; false during SSR (the grids only render in the browser anyway). */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getNarrow, () => false);
}

/**
 * The measuring box and grid ref of a detail grid, its width and the breakpoint. Detail rows wrap with the width, so
 * their heights are recomputed whenever it changes.
 */
export function useDetailGrid<T>() {
  const narrow = useNarrow();
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<AgGridReact<DetailRow<T>>>(null);
  const width = useWidth(box);
  useEffect(() => {
    grid.current?.api?.resetRowHeights();
  }, [width, narrow]);
  return { narrow, box, grid, width };
}

/** The AG Grid props every detail grid shares: inset theme, auto height, row ids, full-width detail rows and their heights. */
export function detailGridProps<T>(detailHeight: (row: DetailRow<T>) => number, rowHeight = 44) {
  return {
    theme: gridThemeInset,
    domLayout: "autoHeight" as const,
    suppressCellFocus: true,
    tooltipShowDelay: 400,
    getRowId: (p: GetRowIdParams<DetailRow<T>>) => p.data.rowKey,
    isFullWidthRow: (p: IsFullWidthRowParams<DetailRow<T>>) => p.rowNode.data?.rowKind === "detail",
    getRowHeight: (p: RowHeightParams<DetailRow<T>>) => (p.data?.rowKind === "detail" ? detailHeight(p.data) : rowHeight),
  };
}
