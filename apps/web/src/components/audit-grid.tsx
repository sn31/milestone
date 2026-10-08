"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, IRowNode, PostSortRowsParams } from "ag-grid-community";
import { Panel, StateGlyph, cx, inputClass, type LogLine } from "@/components/ui";
import { DetailLogRow, ToggleCell, detailGridProps, expandRows, logRowHeight, toggled, useDetailGrid, type DetailCtx, type DetailRow, type ToggleCellParams } from "@/components/ui/detail-grid";
import { auditTime, eventGlyph, eventTone } from "@/lib/events";

export interface AuditRow {
  id: string;
  at: string; // ISO
  milestone: string; // "2 Title" or ""
  actor: string;
  event: string;
  /** The detail as one short `key=value` line (the server cuts it); the full detail is loaded when the row opens. */
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
const NOT_LOADED: LogLine[] = [{ text: "could not load this event's detail", tone: "err" }];

const toggleParams: ToggleCellParams<AuditItem> = { label: (r) => `detail for ${r.event}`, expandable: (r) => r.hasDetail };

function AuditLogRow(p: ICellRendererParams<GridRow>) {
  if (!p.data) return null;
  const r = p.data;
  return <DetailLogRow lines={r.lines ?? ["(no detail)"]} maxHeight={LOG_MAX} title={`${r.event} · ${auditTime(r.at)} UTC · ${r.actor}`} />;
}

function EventCell(p: ICellRendererParams<GridRow>) {
  const ev = p.data?.event ?? "";
  const tone = eventTone(ev);
  const dot = ev.indexOf(".");
  return (
    <span data-tone={tone} className="inline-flex min-w-0 items-center gap-2 font-mono text-[12px]">
      <StateGlyph glyph={eventGlyph(ev)} className="text-tone" />
      <span className="truncate">
        {dot > 0 ? <span className="text-fg-faint">{ev.slice(0, dot + 1)}</span> : null}
        <span className={tone === "danger" ? "text-tone" : "text-fg"}>{dot > 0 ? ev.slice(dot + 1) : ev}</span>
      </span>
    </span>
  );
}

function MilestoneCell(p: ICellRendererParams<GridRow>) {
  const v = p.data?.milestone ?? "";
  if (!v) return <span className="font-mono text-[12px] text-fg-faint">contract</span>;
  const m = /^(\d+)\s+(.*)$/.exec(v);
  return (
    <span className="truncate" title={v}>
      {m ? <span className="mr-2 font-mono text-[11px] text-fg-faint tabular">{m[1].padStart(2, "0")}</span> : null}
      <span className="text-fg-muted">{m ? m[2] : v}</span>
    </span>
  );
}

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
      { colId: "toggle", headerName: "", width: narrow ? 40 : 48, resizable: false, sortable: false, filter: false, cellRenderer: ToggleCell, cellRendererParams: toggleParams },
      {
        field: "at",
        headerName: narrow ? "Time" : "Time (UTC)",
        width: narrow ? 96 : 150,
        sort: "desc",
        valueFormatter: (v) => (v.value ? auditTime(String(v.value), narrow) : ""),
        cellClass: "font-mono text-[12px] text-fg-muted tabular",
      },
      { field: "event", headerName: "Event", width: 250, flex: narrow ? 1 : undefined, minWidth: 180, cellRenderer: EventCell },
      { field: "milestone", headerName: "Milestone", width: 210, hide: narrow, cellRenderer: MilestoneCell },
      { field: "actor", headerName: "Actor", width: 150, hide: narrow, cellClass: "text-fg-muted" },
      {
        field: "summary",
        headerName: "Detail",
        flex: 1,
        minWidth: 220,
        hide: narrow,
        sortable: false,
        filter: "agTextColumnFilter",
        // The search box filters events, as it did when this column held the detail object.
        getQuickFilterText: () => "",
        tooltipValueGetter: (p) => p.data?.summary || undefined,
        cellClass: "font-mono text-[11.5px] text-fg-faint",
      },
    ],
    [narrow],
  );

  const pageSize = 20;
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
          {rows.length} {rows.length === 1 ? "event" : "events"} · newest first · times in UTC
        </p>
      </div>
      <Panel variant="solid" padded={false} className="overflow-hidden">
        <div ref={box}>
          <AgGridReact<GridRow>
            // Remount across the breakpoint: rows rendered before it would keep the other time format.
            key={narrow ? "narrow" : "wide"}
            ref={grid}
            {...detailGridProps<AuditItem>((r) => logRowHeight(r.lines ?? ["(no detail)"], width, narrow, LOG_MAX))}
            rowData={data}
            columnDefs={cols}
            context={{ onToggle } satisfies DetailCtx}
            defaultColDef={{ sortable: true, filter: true, resizable: true, suppressMovable: true }}
            quickFilterText={quick}
            pagination={rows.length > pageSize}
            paginationPageSize={pageSize}
            paginationPageSizeSelector={[10, 20, 50, 100]}
            fullWidthCellRenderer={AuditLogRow}
            postSortRows={keepDetailsUnderParents}
            overlayNoRowsTemplate="<span>No events match.</span>"
          />
        </div>
      </Panel>
    </div>
  );
}
