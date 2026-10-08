"use client";

import { useEffect, useMemo, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Hash, Panel, StateGlyph, VERDICT_GLYPH, cx, verdictTone, type LogLine } from "@/components/ui";
import { DetailLogRow, ToggleCell, detailGridProps, expandRows, logRowHeight, toggled, useDetailGrid, type DetailCtx, type DetailRow, type ToggleCellParams } from "@/components/ui/detail-grid";

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

type Row = DetailRow<EvidenceItem>;

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

const LOG_MAX = 240;

const toggleParams: ToggleCellParams<EvidenceItem> = { label: (r) => `the log for ${r.id}` };

function KindCell(p: ICellRendererParams<Row>) {
  if (!p.data) return null;
  return (
    <span data-tone={verdictTone(p.data.status)} className="type-label text-[10px] text-tone">
      {p.data.kind}
    </span>
  );
}

function StatusCell(p: ICellRendererParams<Row>) {
  const s = p.data?.status;
  if (!s) return <span className="font-mono text-[12px] text-fg-faint uppercase">observed</span>;
  const glyph = VERDICT_GLYPH[s as keyof typeof VERDICT_GLYPH];
  return (
    <span data-tone={verdictTone(s)} className="inline-flex items-center gap-1.5 font-mono text-[12px] text-tone uppercase">
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

function EvidenceLogRow(p: ICellRendererParams<Row>) {
  if (!p.data) return null;
  const it = p.data;
  return <DetailLogRow lines={logLines(it)} maxHeight={LOG_MAX} title={`${it.id} · ${it.kind}${it.status ? ` · ${it.status}` : ""}`} />;
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
  const onToggle = onToggleProp ?? ((id: string) => setOpenState((prev) => toggled(prev, id)));
  const { narrow, box, grid, width } = useDetailGrid<EvidenceItem>();
  const rows = useMemo(() => expandRows(items, open), [items, open]);

  const cols = useMemo<ColDef<Row>[]>(
    () => [
      {
        colId: "toggle",
        headerName: "",
        width: narrow ? 40 : 52,
        resizable: false,
        cellRenderer: ToggleCell,
        cellRendererParams: toggleParams,
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
  }, [focusId, focusKey, box, grid]);

  if (items.length === 0) {
    return <p className="font-mono text-[12px] text-fg-faint">No evidence recorded.</p>;
  }
  return (
    <Panel variant="solid" padded={false} className={cx("overflow-hidden", className)}>
      <div ref={box}>
        <AgGridReact<Row>
          ref={grid}
          {...detailGridProps<EvidenceItem>((r) => logRowHeight(logLines(r), width, narrow, LOG_MAX))}
          context={{ onToggle } satisfies DetailCtx}
          rowData={rows}
          columnDefs={cols}
          defaultColDef={{ sortable: false, filter: false, resizable: true, suppressMovable: true }}
          fullWidthCellRenderer={EvidenceLogRow}
          rowClass="group"
        />
      </div>
    </Panel>
  );
}
