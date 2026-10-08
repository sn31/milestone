"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { gridTheme } from "./ag-grid-theme";

export interface AuditRow {
  id: string;
  at: string; // ISO
  milestone: string; // "2 Title" or ""
  actor: string;
  event: string;
  detail: unknown;
}

export function ActivityLink({ contractId }: { contractId: string }) {
  return (
    <Link href={`/contracts/${contractId}/activity`} className="text-sm underline">
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
  return parts.join(", ");
}

function DetailCell(p: ICellRendererParams<AuditRow>) {
  const [open, setOpen] = useState(false);
  const detail = p.data?.detail;
  if (detail === null || detail === undefined) return null;
  const json = JSON.stringify(detail, null, 2);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    const lines = json.split("\n").length;
    p.node.setRowHeight(next ? Math.min(40 + lines * 16, 280) : 42);
    p.api.onRowHeightChanged();
  };
  return (
    <div style={{ lineHeight: "16px", paddingTop: 4 }}>
      <button type="button" onClick={toggle} style={{ marginRight: 6 }} aria-expanded={open}>
        {open ? "▾" : "▸"}
      </button>
      {open ? (
        <pre style={{ margin: 0, fontSize: 11, whiteSpace: "pre-wrap" }}>{json}</pre>
      ) : (
        <span style={{ color: "#71717a" }}>{summarize(detail)}</span>
      )}
    </div>
  );
}

export function AuditGrid({ rows }: { rows: AuditRow[] }) {
  const [quick, setQuick] = useState("");
  const cols = useMemo<ColDef<AuditRow>[]>(
    () => [
      { field: "at", headerName: "Time", width: 190, sort: "desc", valueFormatter: (v) => (v.value ? String(v.value).replace("T", " ").slice(0, 19) : "") },
      { field: "milestone", headerName: "Milestone", width: 200 },
      { field: "actor", headerName: "Actor", width: 140 },
      { field: "event", headerName: "Event", width: 220 },
      {
        field: "detail",
        headerName: "Detail",
        flex: 1,
        minWidth: 280,
        sortable: false,
        filter: "agTextColumnFilter",
        filterValueGetter: (p) => summarize(p.data?.detail),
        // detail is an object; a formatter silences AG Grid warning #48 and gives copy/export a readable string.
        valueFormatter: (p) => summarize(p.value),
        cellRenderer: DetailCell,
      },
    ],
    [],
  );
  return (
    <div className="space-y-2">
      <input
        type="search"
        value={quick}
        onChange={(e) => setQuick(e.target.value)}
        placeholder="Quick filter"
        aria-label="Quick filter"
        className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-transparent"
      />
      <div style={{ height: 560 }}>
        <AgGridReact<AuditRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={cols}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          quickFilterText={quick}
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={[10, 20, 50, 100]}
          rowHeight={42}
          getRowId={(p) => p.data.id}
        />
      </div>
    </div>
  );
}
