"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { gridThemeInset } from "./ag-grid-theme";
import { Hash, LogStream, Panel, StateGlyph, cx, type LogLine, type ToneKey } from "@/components/ui";

export interface EvidenceItem {
  id: string;
  kind: string;
  criterion?: string;
  status?: string;
  summary: string;
  uri?: string;
  sha256?: string;
  /** Full log text, when the evidence has it. Falls back to the summary. */
  text?: string;
}

type Row = EvidenceItem & { rowKind: "item" | "detail"; rowKey: string; expanded: boolean };

/** Normalizes a deliveries.evidence jsonb array into panel items. Unknown shapes are skipped. */
export function toEvidenceItems(evidence: unknown[] | null | undefined): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const e of evidence ?? []) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : undefined);
    out.push({
      id: s(o.id) ?? `ev_${out.length}`,
      kind: s(o.kind) ?? "note",
      criterion: s(o.criterion_id) ?? s(o.criterion),
      status: s(o.status),
      summary: s(o.summary) ?? "",
      uri: s(o.uri),
      sha256: s(o.sha256),
      text: s(o.text) ?? s(o.log) ?? s(o.content),
    });
  }
  return out;
}

/** Tone of an evidence status (the deterministic tool result), matching the receipt's verdict colours. */
export function evidenceTone(status: string | undefined): ToneKey {
  return status === "pass" ? "released" : status === "fail" ? "danger" : status === "unclear" ? "needs" : "neutral";
}
const GLYPH = { pass: "check", fail: "cross", unclear: "query" } as const;

/** The log a detail row prints: the evidence's own text, or its summary, location and digest. */
function logLines(it: EvidenceItem): LogLine[] {
  if (it.text) {
    return it.text.split("\n").map((text) => {
      if (/^#?\s*(fail|failed)\s+[1-9]|error|ERR!|✗/i.test(text)) return { text, tone: "err" as const };
      if (/^#?\s*pass\s+\d+|\bpassed\b|^ok\b/i.test(text)) return { text, tone: "ok" as const };
      return text;
    });
  }
  const lines: LogLine[] = [it.summary || "(no summary)"];
  if (it.uri) lines.push({ text: `uri     ${it.uri}` });
  if (it.sha256) lines.push({ text: `sha256  ${it.sha256}` });
  if (it.criterion) lines.push({ text: `cites   ${it.criterion}` });
  return lines;
}

const LINE = 19.8;
const LOG_MAX = 240;
/** Geist Mono at 12px advances 0.6em per character; a little slack for word wrapping. */
const CHAR = 7.2 * 1.03;

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

const subscribeNarrow = (cb: () => void) => {
  const mq = window.matchMedia("(max-width: 639px)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
};
const getNarrow = () => window.matchMedia("(max-width: 639px)").matches;
/** true below the sm breakpoint; false during SSR (the grid only renders in the browser anyway). */
export function useNarrow(): boolean {
  return useSyncExternalStore(subscribeNarrow, getNarrow, () => false);
}

interface Ctx {
  onToggle: (id: string) => void;
}

function ToggleCell(p: ICellRendererParams<Row, unknown, Ctx>) {
  if (!p.data || p.data.rowKind !== "item") return null;
  const { id, expanded } = p.data;
  return (
    <div className="flex h-full items-center">
      <button
        type="button"
        onClick={() => p.context.onToggle(id)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} the log for ${id}`}
        className="grid size-6 place-items-center rounded-chip text-fg-faint transition-colors duration-200 hover:bg-surface-raised hover:text-fg"
      >
        <svg aria-hidden viewBox="0 0 10 10" className={cx("size-2.5 transition-transform duration-200 ease-glide", expanded && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3.5 1.8 L6.8 5 L3.5 8.2" />
        </svg>
      </button>
    </div>
  );
}

function KindCell(p: ICellRendererParams<Row>) {
  if (!p.data) return null;
  return (
    <span data-tone={evidenceTone(p.data.status)} className="type-label text-[10px] text-tone">
      {p.data.kind}
    </span>
  );
}

function StatusCell(p: ICellRendererParams<Row>) {
  const s = p.data?.status;
  if (!s) return <span className="font-mono text-[12px] text-fg-faint uppercase">observed</span>;
  const glyph = GLYPH[s as keyof typeof GLYPH];
  return (
    <span data-tone={evidenceTone(s)} className="inline-flex items-center gap-1.5 font-mono text-[12px] text-tone uppercase">
      {glyph ? <StateGlyph glyph={glyph} /> : null}
      {s}
    </span>
  );
}

function LinkCell(p: ICellRendererParams<Row>) {
  const v = p.data?.uri;
  if (!v) return null;
  if (/^https?:\/\//.test(v)) {
    return (
      <a href={v} target="_blank" rel="noreferrer noopener" className="font-mono text-[12px] text-fg-muted underline decoration-hairline-strong underline-offset-4 hover:text-fg">
        open
      </a>
    );
  }
  return (
    <span title={v} className="font-mono text-[12px] text-fg-muted">
      {v}
    </span>
  );
}

function DetailRow(p: ICellRendererParams<Row>) {
  if (!p.data) return null;
  const it = p.data;
  return (
    <div className="h-full px-3 py-3 sm:pl-[52px]">
      <LogStream lines={logLines(it)} maxHeight={LOG_MAX} stagger={0.03} title={`${it.id} · ${it.kind}${it.status ? ` · ${it.status}` : ""}`} />
    </div>
  );
}

export interface EvidencePanelProps {
  items: EvidenceItem[];
  /** Expanded rows (controlled). Leave out to let the panel manage it. */
  open?: ReadonlySet<string>;
  onToggle?: (id: string) => void;
  /** Scrolls to this evidence row and flashes it; change `focusKey` to repeat for the same id. */
  focusId?: string | null;
  focusKey?: number;
  /** Plain-words criterion descriptions by criterion id. */
  criterionLabels?: Record<string, string>;
  className?: string;
}

/**
 * The delivery's evidence as a ledger grid. A row's chevron opens its full-width log (the evidence text in a
 * LogStream well). The grid takes the height of its rows, so there is no empty band under the last row.
 */
export function EvidencePanel({ items, open: openProp, onToggle: onToggleProp, focusId, focusKey, criterionLabels = {}, className }: EvidencePanelProps) {
  const [openState, setOpenState] = useState<Set<string>>(new Set());
  const open = openProp ?? openState;
  const onToggle =
    onToggleProp ??
    ((id: string) =>
      setOpenState((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }));
  const narrow = useNarrow();
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<AgGridReact<Row>>(null);
  const width = useWidth(box);
  useEffect(() => {
    grid.current?.api?.resetRowHeights();
  }, [width, narrow]);

  const rows = useMemo<Row[]>(
    () =>
      items.flatMap((it) => {
        const expanded = open.has(it.id);
        const base: Row = { ...it, rowKind: "item", rowKey: it.id, expanded };
        return expanded ? [base, { ...it, rowKind: "detail" as const, rowKey: `${it.id}:detail`, expanded }] : [base];
      }),
    [items, open],
  );

  const cols = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: "toggle",
        headerName: "",
        width: narrow ? 40 : 52,
        resizable: false,
        cellRenderer: ToggleCell,
      },
      { field: "kind", headerName: "Kind", width: 104, hide: narrow, cellRenderer: KindCell },
      {
        field: "id",
        headerName: "Id",
        width: 132,
        hide: narrow,
        cellRenderer: (p: ICellRendererParams<Row>) => (p.data ? <Hash value={p.data.id} head={14} tail={0} /> : null),
      },
      {
        field: "criterion",
        headerName: "Cites",
        width: 196,
        hide: narrow,
        valueFormatter: (p) => (p.value ? (criterionLabels[p.value] ?? p.value) : ""),
        tooltipValueGetter: (p) => (p.data?.criterion ? (criterionLabels[p.data.criterion] ?? p.data.criterion) : undefined),
        cellClass: "text-fg-muted",
      },
      { field: "status", headerName: "Result", width: narrow ? 104 : 100, cellRenderer: StatusCell },
      { field: "summary", headerName: "Summary", flex: 1, minWidth: narrow ? 120 : 200, tooltipField: "summary" },
      { field: "uri", headerName: "Source", width: 128, hide: narrow, cellRenderer: LinkCell },
    ],
    [narrow, criterionLabels],
  );

  // Bring a cited row into view (from a receipt chip) and flash it once.
  useEffect(() => {
    if (!focusId) return;
    const t = window.setTimeout(() => {
      const el = box.current?.querySelector<HTMLElement>(`.ag-center-cols-container [row-id="${CSS.escape(focusId)}"]`) ?? box.current;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
      const node = grid.current?.api?.getRowNode(focusId);
      if (node) grid.current?.api.flashCells({ rowNodes: [node], flashDuration: 900, fadeDuration: 900 });
    }, 80);
    return () => window.clearTimeout(t);
  }, [focusId, focusKey]);

  if (items.length === 0) {
    return <p className="font-mono text-[12px] text-fg-faint">No evidence recorded.</p>;
  }
  return (
    <Panel variant="solid" padded={false} className={cx("overflow-hidden", className)}>
      <div ref={box}>
        <AgGridReact<Row>
          ref={grid}
          context={{ onToggle } satisfies Ctx}
          theme={gridThemeInset}
          rowData={rows}
          columnDefs={cols}
          domLayout="autoHeight"
          suppressCellFocus
          tooltipShowDelay={400}
          defaultColDef={{ sortable: false, filter: false, resizable: true, suppressMovable: true }}
          getRowId={(p) => p.data.rowKey}
          isFullWidthRow={(p) => p.rowNode.data?.rowKind === "detail"}
          fullWidthCellRenderer={DetailRow}
          getRowHeight={(p) => (p.data?.rowKind === "detail" ? logRowHeight(logLines(p.data), width, narrow, LOG_MAX) : 44)}
          rowClass="group"
        />
      </div>
    </Panel>
  );
}
