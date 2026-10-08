"use client";

import { useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { createPart, type ColDef, type GridApi, type ICellRendererParams, type IRowNode, type RowClassRules, type ValueGetterParams } from "ag-grid-community";
import { gridThemeInset } from "./ag-grid-theme";
import { useNarrow } from "./evidence-panel";
import { Hash, Money, Panel, StateGlyph, cx, inputClass, type ToneKey } from "@/components/ui";
import { formatMoney, minorDigits } from "@/lib/format";
import { auditTime } from "@/lib/events";

export interface LedgerRow {
  id: string;
  /** ISO time the entry was posted. */
  at: string;
  txnId: string;
  /** "2 Title", or "" when the transaction names no milestone. */
  milestone: string;
  account: string;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: string;
  ref: string;
}

/** Pinned bottom row: the whole ledger's debits and credits in one currency. */
interface Totals {
  currency: string;
  debitMinor: number;
  creditMinor: number;
  entries: number;
  txns: number;
}

type GridRow = LedgerRow & { totals?: Totals };

/** Where a row sits in its transaction group, in the order the grid shows them now. */
interface Group {
  band: boolean;
  first: boolean;
  last: boolean;
}

interface Ctx {
  groups: { current: Map<string, Group> };
}

const PAGE = 50;

/**
 * Account families in the state colour of the money they hold: held escrow is funded blue, the freelancer's account is
 * where released money lands, the client's is money outside escrow (draft). Partner and platform books have no state.
 * DESIGN: no state token means "capital partner"; partner accounts read in neutral ink rather than borrowing a state.
 */
function accountTone(account: string): ToneKey {
  if (account.startsWith("held:")) return "funded";
  if (account.startsWith("freelancer:")) return "released";
  if (account.startsWith("client:")) return "draft";
  return "neutral";
}

/** The ledger's own details on top of the shared theme: txn bands, no divider inside a txn, a sunken totals row. */
const ledgerPart = createPart({
  feature: "milestoneLedger",
  css: `
.ag-row.ledger-band { background-color: color-mix(in oklab, var(--fg) 4%, var(--surface)); }
.ag-row.ledger-inner > .ag-grid-scrolling-cells, .ag-row.ledger-inner > .ag-grid-pinned-left-cells, .ag-row.ledger-inner > .ag-grid-pinned-right-cells { border-bottom-color: transparent; }
`,
});

const ledgerTheme = gridThemeInset.withPart(ledgerPart).withParams({
  pinnedRowBackgroundColor: "var(--surface-sunken)",
  pinnedRowTextColor: "var(--fg)",
  pinnedRowFontWeight: 400,
  pinnedRowBorder: { color: "var(--hairline-strong)" },
});

const isTotal = (p: { node: IRowNode<GridRow>; data?: GridRow }) => p.node.rowPinned === "bottom" && !!p.data?.totals;
const groupOf = (p: { data?: GridRow; context: Ctx }): Group | undefined => (p.data ? p.context.groups.current.get(p.data.id) : undefined);

function TimeCell(p: ICellRendererParams<GridRow, string, Ctx> & { narrow: boolean }) {
  if (isTotal(p)) return <span className="type-label text-fg-faint">Total</span>;
  if (!p.value) return null;
  const g = groupOf(p);
  return <span className={cx("font-mono text-[12px] tabular", g && !g.first ? "text-fg-faint" : "text-fg-muted")}>{auditTime(p.value, p.narrow)}</span>;
}

function TxnCell(p: ICellRendererParams<GridRow, string, Ctx>) {
  if (isTotal(p) || !p.value) return null;
  const g = groupOf(p);
  // One chip per transaction; its other legs hang off a short rule, so the group reads as one entry.
  if (g && !g.first) return <span aria-hidden className="ml-3 block h-full w-px bg-hairline-strong" />;
  return (
    <div className="flex h-full items-center">
      <Hash value={p.value} />
    </div>
  );
}

function MilestoneCell(p: ICellRendererParams<GridRow, string, Ctx>) {
  if (isTotal(p)) return null;
  const v = p.value ?? "";
  if (!v) return <span className="font-mono text-[12px] text-fg-faint">contract</span>;
  const m = /^(\d+)\s+(.*)$/.exec(v);
  const g = groupOf(p);
  return (
    <span className={cx("truncate", g && !g.first && "opacity-60")} title={v}>
      {m ? <span className="mr-2 font-mono text-[11px] text-fg-faint tabular">{m[1].padStart(2, "0")}</span> : null}
      <span className="text-fg-muted">{m ? m[2] : v}</span>
    </span>
  );
}

function AccountCell(p: ICellRendererParams<GridRow, string>) {
  if (isTotal(p)) {
    const t = p.data!.totals!;
    return (
      <span className="font-mono text-[11.5px] text-fg-faint tabular">
        {t.entries} entries · {t.txns} txns
      </span>
    );
  }
  // family:owner[:book]. The family and the book (receivable, cash, fees) always show; the owner id gives way.
  const a = p.value ?? "";
  const [family, ...rest] = a.split(":");
  const book = rest.length > 1 ? rest.pop() : undefined;
  return (
    <span data-tone={accountTone(a)} className="flex h-full min-w-0 items-center gap-2 font-mono text-[12px]" title={a}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-tone" />
      <span className="flex min-w-0">
        <span className="shrink-0 text-tone">{family}</span>
        {rest.length > 0 ? <span className="min-w-0 truncate text-fg-faint">:{rest.join(":")}</span> : null}
        {book ? <span className="shrink-0 text-fg-muted">:{book}</span> : null}
      </span>
    </span>
  );
}

function AmountCell(side: "debit" | "credit") {
  return function LedgerAmountCell(p: ICellRendererParams<GridRow, number | null>) {
    if (isTotal(p)) {
      const t = p.data!.totals!;
      return <Money minor={side === "debit" ? t.debitMinor : t.creditMinor} currency={t.currency} />;
    }
    if (p.value === null || p.value === undefined || !p.data) return null;
    return <Money minor={p.value} currency={p.data.currency} />;
  };
}

function RefCell(p: ICellRendererParams<GridRow, string>) {
  if (isTotal(p)) {
    const t = p.data!.totals!;
    const diff = t.debitMinor - t.creditMinor;
    const ok = diff === 0;
    return (
      <span data-tone={ok ? "released" : "danger"} className="inline-flex items-center gap-2" title={ok ? "Debits minus credits: zero, every transaction balances" : "Debits minus credits is not zero"}>
        <StateGlyph glyph={ok ? "check" : "cross"} className="text-tone" />
        <span className="type-label text-fg-faint">Diff</span>
        <Money minor={diff} currency={t.currency} tone={ok ? "released" : "danger"} />
      </span>
    );
  }
  return <MiddleTruncate value={p.value ?? ""} className="font-mono text-[11.5px] text-fg-faint" />;
}

/**
 * Middle truncation only when needed: the head gives way with an ellipsis, the tail (the part that tells refs apart:
 * "...SHOW110K2F", "...:partner") always shows. A value that fits prints in full.
 */
function MiddleTruncate({ value, className }: { value: string; className?: string }) {
  // Keep the last segment ("…:partner", "…_repaid", "…-SHOW110K2F") when it is short, else the last 8 characters.
  const sep = Math.max(value.lastIndexOf(":"), value.lastIndexOf("_"), value.lastIndexOf("-"));
  const seg = sep > 0 ? value.length - sep : 0;
  const tail = seg >= 4 && seg <= 13 ? seg : 8;
  const cut = value.length > tail + 4 ? value.length - tail : value.length;
  return (
    <span className={cx("flex h-full min-w-0 items-center", className)} title={value}>
      <span className="min-w-0 truncate">{value.slice(0, cut)}</span>
      {cut < value.length ? <span className="shrink-0">{value.slice(cut)}</span> : null}
    </span>
  );
}

/** Debit or credit side of an entry, null on the other side. */
const sideValue = (side: "debit" | "credit") => (p: ValueGetterParams<GridRow>) => (p.data && !p.data.totals && p.data.direction === side ? p.data.amountMinor : null);
/** Column filters work in whole units ("100" matches $100.00), not minor units. */
const sideFilterValue = (side: "debit" | "credit") => (p: ValueGetterParams<GridRow>) =>
  p.data && p.data.direction === side ? p.data.amountMinor / 10 ** minorDigits(p.data.currency) : null;

function totalsOf(rows: LedgerRow[]): GridRow[] {
  const by = new Map<string, Totals & { ids: Set<string> }>();
  for (const r of rows) {
    const t = by.get(r.currency) ?? { currency: r.currency, debitMinor: 0, creditMinor: 0, entries: 0, txns: 0, ids: new Set<string>() };
    if (r.direction === "debit") t.debitMinor += r.amountMinor;
    else t.creditMinor += r.amountMinor;
    t.entries += 1;
    t.ids.add(r.txnId);
    by.set(r.currency, t);
  }
  return [...by.values()].map(({ ids, ...t }) => ({
    id: `total:${t.currency}`,
    at: "",
    txnId: "",
    milestone: "",
    account: "",
    direction: "debit",
    amountMinor: 0,
    currency: t.currency,
    ref: "",
    totals: { ...t, txns: ids.size },
  }));
}

/**
 * The contract's double-entry ledger as a grid. Rows of one transaction share a band (alternating per txn in the order
 * shown) and one txn chip; the pinned foot sums every entry, and debits minus credits must read zero.
 */
export function LedgerGrid({ rows }: { rows: LedgerRow[] }) {
  const [quick, setQuick] = useState("");
  const narrow = useNarrow();
  const groups = useRef(new Map<string, Group>());
  const totals = useMemo(() => totalsOf(rows), [rows]);
  const txnCount = useMemo(() => new Set(rows.map((r) => r.txnId)).size, [rows]);

  /** Re-derives bands from the rows as sorted and filtered now; redraws only when a row's band or edge moved. */
  const regroup = (api: GridApi<GridRow>) => {
    const order: LedgerRow[] = [];
    api.forEachNodeAfterFilterAndSort((n) => {
      if (n.data) order.push(n.data);
    });
    const next = new Map<string, Group>();
    let band = true;
    let changed = order.length !== groups.current.size;
    order.forEach((r, i) => {
      const pageTop = i % PAGE === 0;
      const first = i === 0 || order[i - 1].txnId !== r.txnId;
      const last = i === order.length - 1 || order[i + 1].txnId !== r.txnId || (i + 1) % PAGE === 0;
      if (first) band = !band;
      const g = { band, first: first || pageTop, last };
      const old = groups.current.get(r.id);
      if (!old || old.band !== g.band || old.first !== g.first || old.last !== g.last) changed = true;
      next.set(r.id, g);
    });
    groups.current = next;
    if (changed) api.redrawRows();
  };

  const rowClassRules = useMemo<RowClassRules<GridRow>>(
    () => ({
      "ledger-band": (p) => !p.node.rowPinned && !!p.data && p.context.groups.current.get(p.data.id)?.band === true,
      "ledger-inner": (p) => !p.node.rowPinned && !!p.data && p.context.groups.current.get(p.data.id)?.last === false,
    }),
    [],
  );

  const cols = useMemo<ColDef<GridRow>[]>(
    () => [
      {
        field: "at",
        headerName: "Time",
        width: narrow ? 100 : 136,
        sort: "asc",
        cellRenderer: TimeCell,
        cellRendererParams: { narrow },
        filter: "agTextColumnFilter",
        filterValueGetter: (p) => (p.data?.at ? auditTime(p.data.at) : ""),
        getQuickFilterText: (p) => (p.data?.at ? auditTime(p.data.at) : ""),
      },
      { field: "txnId", headerName: "Txn", width: 124, cellRenderer: TxnCell, filter: "agTextColumnFilter" },
      { field: "milestone", headerName: "Milestone", flex: 1, minWidth: 240, cellRenderer: MilestoneCell, filter: "agTextColumnFilter" },
      { field: "account", headerName: "Account", width: 208, cellRenderer: AccountCell, filter: "agTextColumnFilter", getQuickFilterText: (p) => `${p.data?.account ?? ""} ${p.data?.direction ?? ""}` },
      {
        colId: "debit",
        headerName: "Debit",
        width: 92,
        type: "rightAligned",
        valueGetter: sideValue("debit"),
        cellRenderer: AmountCell("debit"),
        cellClass: "tabular",
        filter: "agNumberColumnFilter",
        filterValueGetter: sideFilterValue("debit"),
        getQuickFilterText: (p) => (typeof p.value === "number" && p.data ? formatMoney(p.value, p.data.currency) : ""),
      },
      {
        colId: "credit",
        headerName: "Credit",
        width: 92,
        type: "rightAligned",
        valueGetter: sideValue("credit"),
        cellRenderer: AmountCell("credit"),
        cellClass: "tabular",
        filter: "agNumberColumnFilter",
        filterValueGetter: sideFilterValue("credit"),
        getQuickFilterText: (p) => (typeof p.value === "number" && p.data ? formatMoney(p.value, p.data.currency) : ""),
      },
      { field: "ref", headerName: "Ref", flex: 1, minWidth: 150, cellRenderer: RefCell, filter: "agTextColumnFilter" },
    ],
    [narrow],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Filter entries</span>
          <svg aria-hidden viewBox="0 0 16 16" className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-faint" fill="none" stroke="currentColor" strokeWidth={1.4}>
            <circle cx="7" cy="7" r="4.5" />
            <path d="M10.5 10.5 L14 14" />
          </svg>
          <input
            type="search"
            value={quick}
            onChange={(e) => setQuick(e.target.value)}
            placeholder="Filter entries"
            className={cx(inputClass, "h-9 py-1 pl-9 font-mono text-[13px]")}
          />
        </label>
        <p className="font-mono text-[11px] text-fg-faint tabular">
          {rows.length} {rows.length === 1 ? "entry" : "entries"} · {txnCount} {txnCount === 1 ? "transaction" : "transactions"} · times in UTC
        </p>
      </div>
      <Panel variant="solid" padded={false} className="overflow-hidden">
        <AgGridReact<GridRow>
          // Remount across the breakpoint so every row uses the same time format.
          key={narrow ? "narrow" : "wide"}
          theme={ledgerTheme}
          rowData={rows}
          columnDefs={cols}
          context={{ groups } satisfies Ctx}
          rowClassRules={rowClassRules}
          pinnedBottomRowData={totals}
          domLayout="autoHeight"
          suppressCellFocus
          defaultColDef={{ sortable: true, filter: true, resizable: true, suppressMovable: true }}
          quickFilterText={quick}
          pagination={rows.length > PAGE}
          paginationPageSize={PAGE}
          paginationPageSizeSelector={false}
          getRowId={(p) => p.data.id}
          onModelUpdated={(e) => regroup(e.api)}
          overlayNoRowsTemplate="<span>No entries match.</span>"
        />
      </Panel>
    </div>
  );
}
