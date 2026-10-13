"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, IRowNode, PostSortRowsParams } from "ag-grid-community";
import { Panel, StateGlyph, cx, inputClass, type LogLine } from "@/components/ui";
import { DetailLogRow, ToggleCell, detailGridProps, expandRows, logRowHeight, textLines, toggled, useDetailGrid, type DetailCtx, type DetailRow, type ToggleCellParams } from "@/components/ui/detail-grid";
import { auditTime, eventGlyph, eventTone } from "@/lib/events";

export interface AuditRow {
  id: string;
  at: string; // ISO
  milestone: string; // "2 Title" or ""
  actor: string;
  event: string;
  /** The event as one sentence (activity/sentence.ts); the full detail is loaded when the row opens. */
  summary: string;
  /** Whether there is any detail to open. */
  hasDetail: boolean;
}

/** An open row's detail row carries its loaded log lines. */
type AuditItem = AuditRow & { lines?: LogLine[] };
type GridRow = DetailRow<AuditItem>;

/** The detail object as log lines: one `key  value` line per field, nested values pretty-printed underneath. */
function detailLines(detail: unknown): LogLine[] {
  if (detail === null || detail === undefined || (typeof detail === "object" && Object.keys(detail as object).length === 0)) return ["(no detail)"];
  if (typeof detail !== "object") return [String(detail)];
  const entries = Object.entries(detail as Record<string, unknown>);
  const w = Math.min(18, Math.max(...entries.map(([k]) => k.length)));
  const out: LogLine[] = [];
  for (const [k, v] of entries) {
    const key = k.padEnd(w);
    const bad = /^(error|err|failure|failed)$/i.test(k) && v !== null && v !== false && v !== "";
    if (v !== null && typeof v === "object") {
      const json = JSON.stringify(v, null, 2).split("\n");
      if (json.length <= 1 || JSON.stringify(v).length <= 60) out.push({ text: `${key}  ${JSON.stringify(v)}`, tone: bad ? "err" : undefined });
      else {
        out.push({ text: `${key}  ${json[0]}`, tone: bad ? "err" : undefined });
        for (const line of json.slice(1)) out.push(`${" ".repeat(w)}  ${line}`);
      }
    } else {
      out.push({ text: `${key}  ${String(v)}`, tone: bad ? "err" : undefined });
    }
  }
  return out;
}

const LOG_MAX = 260;
const PAGE = 20;
const NOT_LOADED: LogLine[] = [{ text: "could not load this event's detail", tone: "err" }];

const toggleParams: ToggleCellParams<AuditItem> = { label: (r) => `detail for ${r.event}`, expandable: (r) => r.hasDetail };

function AuditLogRow(p: ICellRendererParams<GridRow>) {
  if (!p.data) return null;
  const r = p.data;
  return <DetailLogRow lines={r.lines ?? ["(no detail)"]} maxHeight={LOG_MAX} title={`${r.event} · ${auditTime(r.at)} UTC · ${r.actor}`} />;
}

function EventCell(p: ICellRendererParams<GridRow> & { narrow?: boolean }) {
  const ev = p.data?.event ?? "";
  const tone = eventTone(ev);
  const dot = ev.indexOf(".");
  const name = (
    <span data-tone={tone} className="inline-flex min-w-0 items-center gap-2 font-mono text-[12px]">
      <StateGlyph glyph={eventGlyph(ev)} className="text-tone" />
      <span className="truncate">
        {dot > 0 ? <span className="text-fg-faint">{ev.slice(0, dot + 1)}</span> : null}
        <span className={tone === "danger" ? "text-tone" : "text-fg"}>{dot > 0 ? ev.slice(dot + 1) : ev}</span>
      </span>
    </span>
  );
  // On a phone the sentence column is hidden, so the event carries it underneath.
  if (!p.narrow) return <div className="flex h-full min-w-0 items-center">{name}</div>;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1 leading-tight">
      {name}
      <span className="line-clamp-2 pl-[18px] text-[12.5px] leading-[1.4] whitespace-normal text-fg-muted">{p.data?.summary}</span>
    </div>
  );
}

function MilestoneCell(p: ICellRendererParams<GridRow>) {
  const v = p.data?.milestone ?? "";
  if (!v) return <span className="font-mono text-[12px] text-fg-faint">contract</span>;
  const m = /^(\d+)\s+(.*)$/.exec(v);
  return (
    <div className="flex h-full min-w-0 items-center" title={v}>
      <span className="truncate">
        {m ? <span className="mr-2 font-mono text-[11px] text-fg-faint tabular">{m[1].padStart(2, "0")}</span> : null}
        <span className="text-fg-muted">{m ? m[2] : v}</span>
      </span>
    </div>
  );
}

function ActorCell(p: ICellRendererParams<GridRow>) {
  return (
    <div className="flex h-full min-w-0 items-center" title={p.data?.actor}>
      <span className="truncate">{p.data?.actor}</span>
    </div>
  );
}

/** The sentence, on up to two lines (the row grows to fit; the tooltip has the rest). */
function SummaryCell(p: ICellRendererParams<GridRow>) {
  return (
    <div className="flex h-full min-w-0 items-center">
      <span className="line-clamp-2 leading-[1.4] whitespace-normal">{p.data?.summary}</span>
    </div>
  );
}

// Plain-text cells centre on rows that grew to two lines (AG Grid's own cell CSS outranks utility classes, so inline).
const CENTER = { display: "flex", alignItems: "center" } as const;

// Column widths at 640px and up; "What happened" takes the rest.
const W = { toggle: 48, at: 140, event: 228, milestone: 168, actor: 108 };

/** Keeps each open detail row directly under its event whatever the sort. */
function keepDetailsUnderParents(p: PostSortRowsParams<GridRow>) {
  const details = new Map<string, IRowNode<GridRow>>();
  const mains: IRowNode<GridRow>[] = [];
  for (const n of p.nodes) {
    if (n.data?.rowKind === "detail") details.set(n.data.id, n);
    else mains.push(n);
  }
  p.nodes.length = 0;
  for (const m of mains) {
    p.nodes.push(m);
    const d = m.data ? details.get(m.data.id) : undefined;
    if (d) p.nodes.push(d);
  }
}

/**
 * The contract's audit log as a grid: newest first, each event in the colour of the state it belongs to. A row's
 * chevron loads its detail (`loadDetail`, once per row) and opens it as a log. The grid takes the height of its page of
 * rows (no empty band below).
 */
export function AuditGrid({ rows, loadDetail }: { rows: AuditRow[]; loadDetail: (id: string) => Promise<unknown> }) {
  const [quick, setQuick] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  // Detail log lines by row id, filled the first time a row is opened.
  const [lines, setLines] = useState<ReadonlyMap<string, LogLine[]>>(new Map());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const { narrow, box, grid, width } = useDetailGrid<AuditItem>();

  const onToggle = (id: string) => {
    if (open.has(id) || lines.has(id)) return setOpen((prev) => toggled(prev, id));
    if (loading.has(id)) return;
    setLoading((prev) => new Set(prev).add(id));
    loadDetail(id)
      .then(detailLines, () => NOT_LOADED)
      .then((l) => {
        setLines((prev) => new Map(prev).set(id, l));
        setOpen((prev) => new Set(prev).add(id));
        setLoading((prev) => toggled(prev, id));
      });
  };
  const data = useMemo<GridRow[]>(() => expandRows<AuditItem>(rows, open).map((r) => (r.rowKind === "detail" ? { ...r, lines: lines.get(r.id) } : r)), [rows, open, lines]);

  const cols = useMemo<ColDef<GridRow>[]>(
    () => [
      { colId: "toggle", headerName: "", width: narrow ? 40 : W.toggle, resizable: false, sortable: false, filter: false, cellRenderer: ToggleCell, cellRendererParams: toggleParams },
      {
        field: "at",
        headerName: narrow ? "Time" : "Time (UTC)",
        width: narrow ? 96 : W.at,
        sort: "desc",
        valueFormatter: (v) => (v.value ? auditTime(String(v.value), narrow) : ""),
        cellClass: "font-mono text-[12px] text-fg-muted tabular",
        cellStyle: CENTER,
      },
      { field: "event", headerName: "Event", width: W.event, flex: narrow ? 1 : undefined, minWidth: 180, cellRenderer: EventCell, cellRendererParams: { narrow } },
      { field: "milestone", headerName: "Milestone", width: W.milestone, hide: narrow, cellRenderer: MilestoneCell },
      { field: "actor", headerName: "Actor", width: W.actor, hide: narrow, cellClass: "text-fg-muted", cellRenderer: ActorCell },
      {
        field: "summary",
        headerName: "What happened",
        flex: 1,
        minWidth: 240,
        hide: narrow,
        sortable: false,
        filter: "agTextColumnFilter",
        tooltipValueGetter: (p) => p.data?.summary || undefined,
        cellRenderer: SummaryCell,
        cellClass: "text-[13px] text-fg-muted",
      },
    ],
    [narrow],
  );

  // Rows grow to two lines when the sentence needs them, so nothing that tells the
  // story is cut off mid-word. Widths are the columns' own, measured from the grid box.
  const rowHeight = (r: GridRow): number => {
    const w = width || 1050;
    if (narrow) return textLines(r.summary, w - 40 - 96 - 18) > 1 ? 78 : 60;
    const summaryW = Math.max(240, w - W.toggle - W.at - W.event - W.milestone - W.actor);
    return textLines(r.summary, summaryW) > 1 ? 62 : 44;
  };

  // No stock pager: the newest events first, then a mono "Show 20 more" row (the search looks through every event).
  const q = quick.trim().toLowerCase();
  const matching = useMemo(
    () => (q ? rows.filter((r) => q.split(/\s+/).every((w) => `${r.event} ${r.summary} ${r.actor} ${r.milestone} ${auditTime(r.at)}`.toLowerCase().includes(w))) : rows),
    [rows, q],
  );
  const shownRows = useMemo(() => {
    const ids = new Set(matching.slice(0, limit).map((r) => r.id));
    return data.filter((r) => ids.has(r.id));
  }, [matching, limit, data]);
  const left = matching.length - Math.min(limit, matching.length);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Filter events</span>
          <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-faint" fill="none" stroke="currentColor" strokeWidth={1.4}>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" />
          </svg>
          <input
            type="search"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Filter events"
            className={cx(inputClass, "h-9 py-1 pl-9 font-mono text-[13px]")}
          />
        </label>
        <p className="font-mono text-[11px] text-fg-faint tabular">
          {q ? `${matching.length} of ${rows.length}` : rows.length} {rows.length === 1 ? "event" : "events"} · newest first · times in UTC
        </p>
      </div>
      <Panel variant="solid" padded={false} className="overflow-hidden">
        <div ref={box}>
          <AgGridReact<GridRow>
            // Remount across the breakpoint: rows rendered before it would keep the other time format.
            key={narrow ? "narrow" : "wide"}
            ref={grid}
            {...detailGridProps<AuditItem>((r) => logRowHeight(r.lines ?? ["(no detail)"], width, narrow, LOG_MAX), rowHeight)}
            rowData={shownRows}
            columnDefs={cols}
            context={{ onToggle } satisfies DetailCtx}
            defaultColDef={{ sortable: true, filter: true, resizable: true, suppressMovable: true }}
            fullWidthCellRenderer={AuditLogRow}
            postSortRows={keepDetailsUnderParents}
            overlayNoRowsTemplate="<span>No events match.</span>"
          />
        </div>
        {matching.length > PAGE ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-2.5 font-mono text-[11px] text-fg-faint tabular sm:px-5">
            <span>
              {Math.min(limit, matching.length)} of {matching.length} {matching.length === 1 ? "event" : "events"}
            </span>
            {left > 0 ? (
              <button
                type="button"
                onClick={() => setLimit((n) => n + PAGE)}
                className="rounded-chip px-2 py-1 tracking-[0.08em] text-fg-muted uppercase transition-colors duration-200 hover:bg-surface-raised hover:text-fg"
              >
                Show {Math.min(PAGE, left)} more
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setLimit(PAGE)}
                className="rounded-chip px-2 py-1 tracking-[0.08em] text-fg-faint uppercase transition-colors duration-200 hover:bg-surface-raised hover:text-fg"
              >
                Show fewer
              </button>
            )}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
