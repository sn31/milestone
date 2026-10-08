"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, IRowNode, PostSortRowsParams } from "ag-grid-community";
import { gridThemeInset } from "./ag-grid-theme";
import { logRowHeight, useNarrow, useWidth } from "./evidence-panel";
import { LogStream, Panel, StateGlyph, cx, inputClass, type LogLine } from "@/components/ui";
import { auditTime, eventGlyph, eventTone } from "@/lib/events";

export interface AuditRow {
  id: string;
  at: string; // ISO
  milestone: string; // "2 Title" or ""
  actor: string;
  event: string;
  detail: unknown;
}

type GridRow = AuditRow & { rowKind: "item" | "detail"; rowKey: string; expanded: boolean };

export function ActivityLink({ contractId }: { contractId: string }) {
  return (
    <Link href={`/contracts/${contractId}/activity`} className="font-mono text-[12px] text-fg-muted underline decoration-hairline-strong underline-offset-4 hover:text-fg">
      Activity log
    </Link>
  );
}

function summarize(detail: unknown): string {
  if (detail === null || detail === undefined) return "";
  if (typeof detail !== "object") return String(detail);
  const parts = Object.entries(detail as Record<string, unknown>).map(([k, v]) => {
    const s = typeof v === "object" && v !== null ? JSON.stringify(v) : String(v);
    return `${k}=${s}`;
  });
  return parts.join("  ");
}

const hasDetail = (d: unknown) => d !== null && d !== undefined && !(typeof d === "object" && Object.keys(d as object).length === 0);

/** The detail object as log lines: one `key  value` line per field, nested values pretty-printed underneath. */
function detailLines(detail: unknown): LogLine[] {
  if (!hasDetail(detail)) return ["(no detail)"];
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

const fmt = (iso: string, short = false) => auditTime(iso, short);

interface Ctx {
  onToggle: (id: string) => void;
}

function ToggleCell(p: ICellRendererParams<GridRow, unknown, Ctx>) {
  if (!p.data || p.data.rowKind !== "item" || !hasDetail(p.data.detail)) return null;
  const { id, expanded } = p.data;
  return (
    <div className="flex h-full items-center">
      <button
        type="button"
        onClick={() => p.context.onToggle(id)}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} detail for ${p.data.event}`}
        className="grid size-6 place-items-center rounded-chip text-fg-faint transition-colors duration-200 hover:bg-surface-raised hover:text-fg"
      >
        <svg aria-hidden viewBox="0 0 10 10" className={cx("size-2.5 transition-transform duration-200 ease-glide", expanded && "rotate-90")} fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path d="M3.5 1.8 L6.8 5 L3.5 8.2" />
        </svg>
      </button>
    </div>
  );
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

function DetailRow(p: ICellRendererParams<GridRow>) {
  if (!p.data) return null;
  const r = p.data;
  return (
    <div className="h-full px-3 py-3 sm:pl-[52px]">
      <LogStream lines={detailLines(r.detail)} maxHeight={LOG_MAX} stagger={0.03} title={`${r.event} · ${fmt(r.at)} UTC · ${r.actor}`} />
    </div>
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
 * chevron opens its detail as a log. The grid takes the height of its page of rows (no empty band below).
 */
export function AuditGrid({ rows }: { rows: AuditRow[] }) {
  const [quick, setQuick] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const narrow = useNarrow();
  const box = useRef<HTMLDivElement>(null);
  const grid = useRef<AgGridReact<GridRow>>(null);
  const width = useWidth(box);
  useEffect(() => {
    grid.current?.api?.resetRowHeights();
  }, [width, narrow]);
  const onToggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const data = useMemo<GridRow[]>(
    () =>
      rows.flatMap((r) => {
        const expanded = open.has(r.id);
        const base: GridRow = { ...r, rowKind: "item", rowKey: r.id, expanded };
        return expanded ? [base, { ...r, rowKind: "detail" as const, rowKey: `${r.id}:detail`, expanded }] : [base];
      }),
    [rows, open],
  );

  const cols = useMemo<ColDef<GridRow>[]>(
    () => [
      { colId: "toggle", headerName: "", width: narrow ? 40 : 48, resizable: false, sortable: false, filter: false, cellRenderer: ToggleCell },
      {
        field: "at",
        headerName: narrow ? "Time" : "Time (UTC)",
        width: narrow ? 96 : 150,
        sort: "desc",
        valueFormatter: (v) => (v.value ? fmt(String(v.value), narrow) : ""),
        cellClass: "font-mono text-[12px] text-fg-muted tabular",
      },
      { field: "event", headerName: "Event", width: 250, flex: narrow ? 1 : undefined, minWidth: 180, cellRenderer: EventCell },
      { field: "milestone", headerName: "Milestone", width: 210, hide: narrow, cellRenderer: MilestoneCell },
      { field: "actor", headerName: "Actor", width: 150, hide: narrow, cellClass: "text-fg-muted" },
      {
        field: "detail",
        headerName: "Detail",
        flex: 1,
        minWidth: 220,
        hide: narrow,
        sortable: false,
        filter: "agTextColumnFilter",
        filterValueGetter: (p) => summarize(p.data?.detail),
        // detail is an object; a formatter silences AG Grid warning #48 and gives copy/export a readable string.
        valueFormatter: (p) => summarize(p.value),
        tooltipValueGetter: (p) => summarize(p.data?.detail) || undefined,
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
            theme={gridThemeInset}
            rowData={data}
            columnDefs={cols}
            context={{ onToggle } satisfies Ctx}
            domLayout="autoHeight"
            suppressCellFocus
            tooltipShowDelay={400}
            defaultColDef={{ sortable: true, filter: true, resizable: true, suppressMovable: true }}
            quickFilterText={quick}
            pagination={rows.length > pageSize}
            paginationPageSize={pageSize}
            paginationPageSizeSelector={[10, 20, 50, 100]}
            getRowId={(p) => p.data.rowKey}
            isFullWidthRow={(p) => p.rowNode.data?.rowKind === "detail"}
            fullWidthCellRenderer={DetailRow}
            getRowHeight={(p) => (p.data?.rowKind === "detail" ? logRowHeight(detailLines(p.data.detail), width, narrow, LOG_MAX) : 44)}
            postSortRows={keepDetailsUnderParents}
            overlayNoRowsTemplate="<span>No events match.</span>"
          />
        </div>
      </Panel>
    </div>
  );
}
