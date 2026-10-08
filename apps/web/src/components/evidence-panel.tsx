"use client";

import { useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { gridTheme } from "./ag-grid-theme";

export interface EvidenceItem {
  id: string;
  kind: string;
  criterion?: string;
  status?: string;
  summary: string;
  uri?: string;
  /** Full log text, when the evidence has it. Falls back to the summary. */
  text?: string;
}

type Row = EvidenceItem & { rowKind: "item" | "detail"; rowKey: string };

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
      text: s(o.text) ?? s(o.log) ?? s(o.content),
    });
  }
  return out;
}

function ToggleCell(p: ICellRendererParams<Row> & { onToggle: (id: string) => void; open: Set<string> }) {
  if (!p.data || p.data.rowKind !== "item") return null;
  const id = p.data.id;
  return (
    <button type="button" onClick={() => p.onToggle(id)} aria-expanded={p.open.has(id)} aria-label="Toggle full text">
      {p.open.has(id) ? "▾" : "▸"}
    </button>
  );
}

function DetailRow(p: ICellRendererParams<Row>) {
  return (
    <pre style={{ margin: 0, padding: 8, fontSize: 11, whiteSpace: "pre-wrap", overflow: "auto", height: "100%" }}>
      {p.data?.text ?? p.data?.summary}
    </pre>
  );
}

export function EvidencePanel({ items }: { items: EvidenceItem[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const onToggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const rows = useMemo<Row[]>(
    () =>
      items.flatMap((it) => {
        const base: Row = { ...it, rowKind: "item", rowKey: it.id };
        return open.has(it.id) ? [base, { ...it, rowKind: "detail" as const, rowKey: `${it.id}:detail` }] : [base];
      }),
    [items, open],
  );

  const cols = useMemo<ColDef<Row>[]>(
    () => [
      { headerName: "", width: 50, sortable: false, filter: false, cellRenderer: ToggleCell, cellRendererParams: { onToggle, open } },
      { field: "kind", headerName: "Kind", width: 110 },
      { field: "criterion", headerName: "Criterion", width: 160 },
      { field: "status", headerName: "Status", width: 110 },
      { field: "summary", headerName: "Summary", flex: 1, minWidth: 240 },
      {
        field: "uri",
        headerName: "Link",
        width: 140,
        cellRenderer: (p: ICellRendererParams<Row>) =>
          p.value && /^https?:\/\//.test(String(p.value)) ? (
            <a href={String(p.value)} target="_blank" rel="noreferrer noopener" style={{ textDecoration: "underline" }}>
              open
            </a>
          ) : (
            <span>{p.value ?? ""}</span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open],
  );

  if (items.length === 0) return <p className="text-sm text-zinc-500">No evidence recorded.</p>;
  return (
    <div style={{ height: Math.min(120 + rows.length * 44 + open.size * 160, 560) }}>
      <AgGridReact<Row>
        theme={gridTheme}
        rowData={rows}
        columnDefs={cols}
        defaultColDef={{ sortable: false, filter: false, resizable: true }}
        getRowId={(p) => p.data.rowKey}
        isFullWidthRow={(p) => p.rowNode.data?.rowKind === "detail"}
        fullWidthCellRenderer={DetailRow}
        getRowHeight={(p) => (p.data?.rowKind === "detail" ? 160 : 42)}
      />
    </div>
  );
}
