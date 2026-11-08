"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import { createPart, type ColDef, type GridApi, type ICellRendererParams, type IRowNode, type RowClassRules, type ValueGetterParams } from "ag-grid-community";
import { gridThemeInset } from "./ag-grid-theme";
import { useNarrow } from "@/components/ui/detail-grid";
import { Money, Panel, StateGlyph, cx, inputClass, type ToneKey } from "@/components/ui";
import { accountLabel, refShort, type TxnKind } from "./ledger-labels";
import { formatMoney, minorDigits } from "@/lib/format";
import { auditTime } from "@/lib/events";

export interface LedgerRow {
  id: string;
  /** ISO time the entry was posted. */
  at: string;
  txnId: string;
  /** The transaction's place in this contract's ledger, 1-based, in posting order. */
  txnSeq: number;
  /** What the transaction did, from its legs (fund, release, repayment, refund, advance). */
  txnKind: TxnKind;
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

/**
 * A transaction as its number on this contract and what it did ("03 fund"): two transactions never print alike, which a
 * middle-truncated id could not promise. The full id is in the title and is what a click copies.
 */
export function TxnChip({ seq, kind, txnId, className }: { seq: number; kind: string; txnId: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      title={`${txnId} (click to copy)`}
      aria-label={`Transaction ${seq}, ${kind}: copy ${txnId}`}
      onClick={() =>
        navigator.clipboard?.writeText(txnId).then(
          () => setCopied(true),
          () => undefined,
        )
      }
      className={cx(
        "inline-flex h-6 items-center gap-1.5 rounded-chip border border-hairline bg-surface-sunken px-1.5 font-mono text-[11.5px] whitespace-nowrap tabular",
        "transition-colors duration-200 hover:border-hairline-strong active:translate-y-px",
        className,
      )}
    >
      <span className="text-fg-faint">{String(seq).padStart(2, "0")}</span>
      <span className={copied ? "text-state-released" : "text-fg"}>{copied ? "copied" : kind}</span>
    </button>
  );
}

function TxnCell(p: ICellRendererParams<GridRow, string, Ctx>) {
  if (isTotal(p) || !p.value || !p.data) return null;
  const g = groupOf(p);
  // One chip per transaction; its other legs hang off a short rule, so the group reads as one entry.
  if (g && !g.first) return <span aria-hidden className="ml-3 block h-full w-px bg-hairline-strong" />;
  return (
    <div className="flex h-full items-center">
      <TxnChip seq={p.data.txnSeq} kind={p.data.txnKind} txnId={p.value} />
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
  // family · book: the owner id gives way to the role it names ("partner · receivable", "held · mst_3").
  const a = p.value ?? "";
  const { family, rest } = accountLabel(a);
  return (
    <span data-tone={accountTone(a)} className="flex h-full min-w-0 items-center gap-2 font-mono text-[12px]" title={a}>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-tone" />
      <span className="flex min-w-0">
        <span className="shrink-0 text-tone">{family}</span>
        {rest ? <span className="min-w-0 truncate text-fg-muted">&nbsp;· {rest}</span> : null}
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
      <span
        data-tone={ok ? "released" : "danger"}
        className="inline-flex items-center gap-2"
        title={ok ? "Debits minus credits: zero, every transaction balances" : "Debits minus credits is not zero"}
      >
        <StateGlyph glyph={ok ? "check" : "cross"} className="text-tone" />
        <span className="type-label text-fg-faint">Diff</span>
        <Money minor={diff} currency={t.currency} tone={ok ? "released" : "danger"} />
      </span>
    );
  }
  return <MiddleTruncate value={refShort(p.value ?? "")} title={p.value ?? ""} className="font-mono text-[11.5px] text-fg-faint" />;
}

/**
 * Middle truncation only when needed: the head gives way with an ellipsis, the tail (the part that tells refs apart:
 * "...SHOW110K2F", "...:partner") always shows. A value that fits prints in full.
 */
function MiddleTruncate({ value, title, className }: { value: string; title?: string; className?: string }) {
  // Keep the last segment ("…:partner", "…_repaid", "…-SHOW110K2F") when it is short, else the last 8 characters.
  const sep = Math.max(value.lastIndexOf(" "), value.lastIndexOf("_"), value.lastIndexOf("-"));
  const seg = sep > 0 ? value.length - sep : 0;
  const tail = seg >= 4 && seg <= 13 ? seg : 8;
  const cut = value.length > tail + 4 ? value.length - tail : value.length;
  return (
    <span className={cx("flex h-full min-w-0 items-center", className)} title={title ?? value}>
      <span className="min-w-0 truncate whitespace-pre">{value.slice(0, cut)}</span>
      {cut < value.length ? <span className="shrink-0 whitespace-pre">{value.slice(cut)}</span> : null}
    </span>
  );
}

/** Debit or credit side of an entry, null on the other side. */
const sideValue = (side: "debit" | "credit") => (p: ValueGetterParams<GridRow>) =>
  p.data && !p.data.totals && p.data.direction === side ? p.data.amountMinor : null;
/** Column filters work in whole units ("100" matches $100.00), not minor units. */
const sideFilterValue = (side: "debit" | "credit") => (p: ValueGetterParams<GridRow>) =>
  p.data && p.data.direction === side ? p.data.amountMinor / 10 ** minorDigits(p.data.currency) : null;

function totalsOf(rows: LedgerRow[]): GridRow[] {
  const by = new Map<string, Totals & { ids: Set<string> }>();
  for (const r of rows) {
    const t = by.get(r.currency) ?? {
      currency: r.currency,
      debitMinor: 0,
      creditMinor: 0,
      entries: 0,
      txns: 0,
      ids: new Set<string>(),
    };
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
    txnSeq: 0,
    txnKind: "entry",
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
      {
        field: "txnId",
        headerName: "Txn",
        width: 132,
        cellRenderer: TxnCell,
        filter: "agTextColumnFilter",
        filterValueGetter: (p) => (p.data ? `${p.data.txnSeq} ${p.data.txnKind} ${p.data.txnId}` : ""),
        getQuickFilterText: (p) => (p.data ? `${p.data.txnKind} ${p.data.txnId}` : ""),
      },
      {
        field: "milestone",
        headerName: "Milestone",
        flex: 1,
        minWidth: 240,
        cellRenderer: MilestoneCell,
        filter: "agTextColumnFilter",
      },
      {
        field: "account",
        headerName: "Account",
        width: 200,
        cellRenderer: AccountCell,
        filter: "agTextColumnFilter",
        getQuickFilterText: (p) => `${p.data?.account ?? ""} ${p.data?.direction ?? ""}`,
      },
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
      {
        field: "ref",
        headerName: "Ref",
        flex: 1,
        minWidth: 148,
        cellRenderer: RefCell,
        filter: "agTextColumnFilter",
      },
    ],
    [narrow],
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="relative block w-full sm:w-72">
          <span className="sr-only">Filter entries</span>
          <svg
            aria-hidden
            viewBox="0 0 16 16"
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-fg-faint"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
          >
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
      {narrow ? (
        <LedgerList rows={rows} totals={totals} quick={quick} />
      ) : (
        <Panel variant="solid" padded={false} className="overflow-hidden">
          <AgGridReact<GridRow>
            theme={ledgerTheme}
            rowData={rows}
            columnDefs={cols}
            context={{ groups } satisfies Ctx}
            rowClassRules={rowClassRules}
            pinnedBottomRowData={totals}
            domLayout="autoHeight"
            // Every row in the DOM from the first paint (a bounded grid): full-page captures never see
            // an empty band where the rows below the viewport belong.
            suppressRowVirtualisation={rows.length <= 400}
            suppressColumnVirtualisation
            suppressCellFocus
            defaultColDef={{
              sortable: true,
              filter: true,
              resizable: true,
              suppressMovable: true,
            }}
            quickFilterText={quick}
            pagination={rows.length > PAGE}
            paginationPageSize={PAGE}
            paginationPageSizeSelector={false}
            getRowId={(p) => p.data.id}
            onModelUpdated={(e) => regroup(e.api)}
            overlayNoRowsTemplate="<span>No entries match.</span>"
          />
        </Panel>
      )}
    </div>
  );
}

/** The quick filter's haystack for one entry (the grid's own quick filter on wide screens). */
const haystack = (r: LedgerRow) =>
  [r.txnKind, r.txnId, r.milestone, r.account, r.direction, r.ref, auditTime(r.at), formatMoney(r.amountMinor, r.currency)].join(" ").toLowerCase();

/**
 * The ledger on a phone: one block per transaction (its chip, time and milestone), each leg as account and amount on
 * one line, debits and credits marked, so the money is on screen without a sideways scroll.
 */
function LedgerList({ rows, totals, quick }: { rows: LedgerRow[]; totals: GridRow[]; quick: string }) {
  const q = quick.trim().toLowerCase();
  const groups = useMemo(() => {
    const out: Array<{ txnId: string; legs: LedgerRow[] }> = [];
    const sorted = [...rows].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.txnSeq - b.txnSeq));
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && last.txnId === r.txnId) last.legs.push(r);
      else out.push({ txnId: r.txnId, legs: [r] });
    }
    return out;
  }, [rows]);
  const shown = q ? groups.filter((g) => g.legs.some((l) => q.split(/\s+/).every((w) => haystack(l).includes(w)))) : groups;
  return (
    <Panel variant="solid" padded={false} className="overflow-hidden">
      {shown.length === 0 ? <p className="px-4 py-6 font-mono text-[12px] text-fg-faint">No entries match.</p> : null}
      <ol className="divide-y divide-hairline">
        {shown.map((g) => {
          const head = g.legs[0]!;
          const m = /^(\d+)\s+(.*)$/.exec(head.milestone);
          return (
            <li key={g.txnId} className="px-4 py-3">
              <div className="flex items-center justify-between gap-3">
                <TxnChip seq={head.txnSeq} kind={head.txnKind} txnId={g.txnId} />
                <span className="font-mono text-[11px] text-fg-faint tabular">{auditTime(head.at)}</span>
              </div>
              <p className="mt-1.5 truncate text-[12.5px] text-fg-muted" title={head.milestone}>
                {m ? <span className="mr-1.5 font-mono text-[11px] text-fg-faint tabular">{m[1]!.padStart(2, "0")}</span> : null}
                {m ? m[2] : head.milestone || "contract"}
              </p>
              <ul className="mt-2 grid gap-1 border-l border-hairline-strong pl-3">
                {g.legs.map((l) => {
                  const a = accountLabel(l.account);
                  return (
                    <li
                      key={l.id}
                      data-tone={accountTone(l.account)}
                      className="flex items-baseline gap-2 font-mono text-[12px]"
                      title={`${l.account} · ${l.ref}`}
                    >
                      <span className="w-5 shrink-0 text-[10px] tracking-[0.08em] text-fg-faint uppercase">{l.direction === "debit" ? "dr" : "cr"}</span>
                      <span className="min-w-0 flex-1 truncate">
                        <span className="text-tone">{a.family}</span>
                        {a.rest ? <span className="text-fg-muted"> · {a.rest}</span> : null}
                      </span>
                      <Money minor={l.amountMinor} currency={l.currency} />
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
      {totals.map((t) => {
        const x = t.totals!;
        const diff = x.debitMinor - x.creditMinor;
        return (
          <div key={t.id} className="grid gap-1.5 border-t border-hairline-strong bg-surface-sunken px-4 py-3 font-mono text-[12px] tabular">
            <div className="flex items-baseline justify-between gap-3">
              <span className="type-label text-fg-faint">Total</span>
              <span className="text-[11px] text-fg-faint">
                {x.entries} entries · {x.txns} txns
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-fg-faint">debits</span>
              <Money minor={x.debitMinor} currency={x.currency} />
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-fg-faint">credits</span>
              <Money minor={x.creditMinor} currency={x.currency} />
            </div>
            <div data-tone={diff === 0 ? "released" : "danger"} className="flex items-baseline justify-between gap-3">
              <span className="flex items-center gap-2 text-fg-faint">
                <StateGlyph glyph={diff === 0 ? "check" : "cross"} className="text-tone" />
                diff
              </span>
              <Money minor={diff} currency={x.currency} tone={diff === 0 ? "released" : "danger"} />
            </div>
          </div>
        );
      })}
    </Panel>
  );
}
