"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import { gridTheme } from "./ag-grid-theme";
import { formatMoney, formatNumber } from "@/lib/format";
import { EmptyState, Money, Panel, SectionTitle, Stat, StateGlyph, StatePill, cx, inputClass, stateMeta, type ToneKey } from "@/components/ui";

export interface LenderRow {
  id: string;
  contractId: string;
  freelancer: string;
  clientId: string;
  client: string;
  milestone: string;
  milestoneStatus: string;
  currency: string;
  amountMinor: number;
  principalMinor: number;
  feeMinor: number;
  feeBpsPerDay: number;
  status: "offered" | "funded" | "repaid" | "shortfall";
  daysOutstanding: number | null;
  /** From the ledger: the partner receivable's balance for this advance (funded principal minus principal repaid). */
  outstandingMinor: number;
  /** From the ledger: principal and fees actually credited to the partner for this advance. */
  repaidMinor: number;
  /** The part of repaidMinor booked in the last seven days. */
  repaidThisWeekMinor: number;
  pFail: number | null;
  /** pFail x outstandingMinor; null without a pFail. */
  expectedLossMinor: number | null;
  repaymentStatus: string;
  createdAt: string;
  fundedAt: string | null;
  repaidAt: string | null;
}

export interface BookSummary {
  currency: string;
  outstandingMinor: number;
  pendingPayoutMinor: number;
  openCount: number;
  expectedLossMinor: number;
  topClient: { name: string; shareOfOutstanding: number } | null;
  clientCount: number;
  repaidThisWeekMinor: number;
  repaidThisWeekCount: number;
  otherCurrencies: string[];
}

/** Pure. Totals for the book's main currency (the one with the most advances), from the rows' ledger figures. */
export function summarize(rows: LenderRow[]): BookSummary {
  const byCurrency = new Map<string, number>();
  for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + 1);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
  const mine = rows.filter((r) => r.currency === currency);
  const open = mine.filter((r) => r.outstandingMinor > 0);
  const outstandingMinor = open.reduce((s, r) => s + r.outstandingMinor, 0);
  const byClient = clientExposure(open);
  const top = byClient[0];
  const repaid = mine.filter((r) => r.repaidThisWeekMinor > 0);
  return {
    currency,
    outstandingMinor,
    pendingPayoutMinor: mine.filter((r) => r.status === "offered").reduce((s, r) => s + r.principalMinor, 0),
    openCount: open.length,
    expectedLossMinor: open.reduce((s, r) => s + (r.expectedLossMinor ?? 0), 0),
    topClient: top && outstandingMinor > 0 ? { name: top.name, shareOfOutstanding: top.minor / outstandingMinor } : null,
    clientCount: byClient.length,
    repaidThisWeekMinor: repaid.reduce((s, r) => s + r.repaidThisWeekMinor, 0),
    repaidThisWeekCount: repaid.length,
    otherCurrencies: [...byCurrency.keys()].filter((c) => c !== currency),
  };
}

/** Pure. Outstanding principal per client, largest first. */
function clientExposure(open: LenderRow[]): { id: string; name: string; minor: number }[] {
  const byClient = new Map<string, { id: string; name: string; minor: number }>();
  for (const r of open) {
    const c = byClient.get(r.clientId) ?? {
      id: r.clientId,
      name: r.client,
      minor: 0,
    };
    c.minor += r.outstandingMinor;
    byClient.set(r.clientId, c);
  }
  return [...byClient.values()].sort((a, b) => b.minor - a.minor);
}

/** Outstanding principal by the state of the milestone that repays it: where the lender's money waits. */
function exposureByState(open: LenderRow[]): { state: string; minor: number; count: number }[] {
  const order = ["funded", "verifying", "review", "needs_client", "held", "draft", "released", "partial_released"];
  const m = new Map<string, { state: string; minor: number; count: number }>();
  for (const r of open) {
    const e = m.get(r.milestoneStatus) ?? {
      state: r.milestoneStatus,
      minor: 0,
      count: 0,
    };
    e.minor += r.outstandingMinor;
    e.count += 1;
    m.set(r.milestoneStatus, e);
  }
  return [...m.values()].sort((a, b) => (order.indexOf(a.state) >>> 0) - (order.indexOf(b.state) >>> 0));
}

/** Advance status as a state pill: the vocabulary is the milestone's, relabelled for the lender. */
const ADVANCE_PILL: Record<LenderRow["status"], { state: string; label: string }> = {
  offered: { state: "draft", label: "Offered" },
  funded: { state: "funded", label: "Out" },
  repaid: { state: "released", label: "Repaid" },
  shortfall: { state: "failed", label: "Shortfall" },
};

const pct = (share: number) => `${formatNumber(share * 100, share > 0 && share < 0.1 ? 1 : 0)}%`;

/** Neutral ink steps for client segments: colour on this page means state, so clients are told apart by weight. */
const CLIENT_INK = ["bg-fg/75", "bg-fg/45", "bg-fg/25", "bg-fg/15"];

// The shared quartz theme (ag-grid-theme.ts) dressed in the design tokens. Every value is a CSS variable, so the grid
// switches with the light and dark themes on its own.
const bookTheme = gridTheme.withParams({
  backgroundColor: "var(--surface)",
  foregroundColor: "var(--fg)",
  textColor: "var(--fg)",
  chromeBackgroundColor: "var(--surface)",
  headerBackgroundColor: "var(--surface)",
  headerTextColor: "var(--fg-faint)",
  headerFontFamily: "var(--font-mono)",
  headerFontSize: 10.5,
  headerFontWeight: 400,
  headerHeight: 40,
  headerColumnBorder: false,
  headerRowBorder: { color: "var(--hairline)" },
  headerColumnResizeHandleColor: "transparent",
  fontFamily: "var(--font-sans)",
  fontSize: 13,
  rowHeight: 56,
  borderColor: "var(--hairline)",
  rowBorder: { color: "var(--hairline)" },
  columnBorder: false,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  borderRadius: 4,
  rowHoverColor: "color-mix(in oklab, var(--state-funded) 5%, transparent)",
  selectedRowBackgroundColor: "color-mix(in oklab, var(--state-funded) 10%, transparent)",
  oddRowBackgroundColor: "var(--surface)",
  accentColor: "var(--focus)",
  iconColor: "var(--fg-faint)",
  inputBackgroundColor: "var(--surface-sunken)",
  inputBorder: { color: "var(--hairline-strong)" },
  menuBackgroundColor: "var(--surface-raised)",
  menuBorder: { color: "var(--hairline-strong)" },
  menuShadow: "none",
  popupShadow: "none",
  cardShadow: "none",
  dropdownShadow: "none",
  focusShadow: "none",
});

const numCell = "font-mono tabular text-[12.5px]";

function MoneyCell(p: ICellRendererParams<LenderRow, number | null>) {
  if (p.value === null || p.value === undefined || !p.data) return <span className="text-fg-faint">none</span>;
  return <Money minor={p.value} currency={p.data.currency} className={p.value === 0 ? "opacity-50" : undefined} />;
}

/** An amount with a smaller second figure under it (principal + fee, outstanding + repaid). */
function stackedMoney(second: keyof LenderRow, caption: string, tone?: ToneKey) {
  return function StackedMoneyCell(p: ICellRendererParams<LenderRow, number | null>) {
    if (!p.data) return null;
    const v = p.data[second];
    const n = typeof v === "number" ? v : 0;
    return (
      <div className="flex h-full flex-col items-end justify-center gap-1 leading-tight">
        <MoneyCell {...p} />
        <span data-tone={n > 0 ? tone : undefined} className={cx("font-mono text-[11px] tabular", n > 0 && tone ? "text-tone" : "text-fg-faint")}>
          {caption} {formatMoney(n, p.data.currency)}
        </span>
      </div>
    );
  };
}

function AdvanceCell(p: ICellRendererParams<LenderRow, string>) {
  if (!p.data) return null;
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <Link
        href={`/contracts/${p.data.contractId}`}
        className="truncate text-fg underline decoration-hairline-strong underline-offset-[3px] transition-colors hover:decoration-fg-muted"
      >
        {p.value}
      </Link>
      <span className="mt-1 truncate text-[12px] text-fg-faint">
        {p.data.freelancer}
        {p.data.daysOutstanding !== null ? <span className="font-mono tabular"> · {p.data.daysOutstanding}d out</span> : null}
      </span>
    </div>
  );
}

function StatusCell(p: ICellRendererParams<LenderRow, LenderRow["status"]>) {
  if (!p.value) return null;
  const pill = ADVANCE_PILL[p.value];
  return <StatePill state={pill.state} label={pill.label} />;
}

function MilestoneStateCell(p: ICellRendererParams<LenderRow, string>) {
  if (!p.data) return null;
  const atRisk = p.data.milestoneStatus === "held";
  return (
    <div className="flex h-full min-w-0 flex-col justify-center gap-1 leading-tight">
      <StatePill state={p.data.milestoneStatus} className="self-start" />
      <span data-tone={atRisk ? "held" : undefined} className={cx("truncate text-[12px]", atRisk ? "text-tone" : "text-fg-faint")}>
        {p.data.repaymentStatus}
      </span>
    </div>
  );
}

/** The lender's book as an instrument panel, then one AG Grid row per advance. */
export function LenderBook({ rows }: { rows: LenderRow[]; /** Render time, ISO; kept for callers, the book reads only the ledger figures. */ now?: string }) {
  const [quick, setQuick] = useState("");
  const s = useMemo(() => summarize(rows), [rows]);
  const open = useMemo(() => rows.filter((r) => r.currency === s.currency && r.outstandingMinor > 0), [rows, s.currency]);
  const clients = useMemo(() => clientExposure(open), [open]);
  const states = useMemo(() => exposureByState(open), [open]);
  const share = useMemo(() => new Map(clients.map((c) => [c.id, s.outstandingMinor > 0 ? c.minor / s.outstandingMinor : 0])), [clients, s.outstandingMinor]);
  const concentrated = !!s.topClient && s.topClient.shareOfOutstanding > 0.5 && s.clientCount > 1;
  const lossShare = s.outstandingMinor > 0 ? s.expectedLossMinor / s.outstandingMinor : 0;

  const cols = useMemo<ColDef<LenderRow>[]>(() => {
    const money = (field: keyof LenderRow, headerName: string, width: number): ColDef<LenderRow> => ({
      field,
      headerName,
      width,
      type: "rightAligned",
      cellClass: numCell,
      cellRenderer: MoneyCell,
      filter: "agNumberColumnFilter",
      getQuickFilterText: (p) => (typeof p.value === "number" && p.data ? formatMoney(p.value, p.data.currency) : ""),
    });
    return [
      {
        field: "milestone",
        headerName: "Advance on",
        flex: 1,
        minWidth: 190,
        cellRenderer: AdvanceCell,
        getQuickFilterText: (p) => `${p.value} ${p.data?.freelancer ?? ""}`,
      },
      {
        field: "client",
        headerName: "Client exposure",
        width: 152,
        cellRenderer: (p: ICellRendererParams<LenderRow, string>) => {
          if (!p.data) return null;
          const sh = share.get(p.data.clientId) ?? 0;
          const heavy = sh > 0.5 && clients.length > 1;
          return (
            <div data-tone={heavy ? "held" : "neutral"} className="flex h-full min-w-0 flex-col justify-center gap-1.5 leading-tight">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-fg-muted">{p.value}</span>
                <span className={cx(numCell, "text-[11.5px]", heavy ? "text-tone" : "text-fg-faint")}>{sh > 0 ? pct(sh) : "0%"}</span>
              </div>
              <span aria-hidden className="relative h-[3px] w-full overflow-hidden rounded-full bg-hairline">
                <span
                  className={cx("absolute inset-y-0 left-0 rounded-full", heavy ? "bg-tone" : "bg-fg/45")}
                  style={{ width: `${Math.round(sh * 1000) / 10}%` }}
                />
              </span>
            </div>
          );
        },
      },
      {
        field: "status",
        headerName: "Advance",
        width: 112,
        cellRenderer: StatusCell,
        getQuickFilterText: (p) => (p.value ? ADVANCE_PILL[p.value as LenderRow["status"]].label : ""),
      },
      {
        ...money("principalMinor", "Principal", 115),
        cellRenderer: stackedMoney("feeMinor", "fee"),
      },
      {
        ...money("outstandingMinor", "Outstanding", 125),
        cellRenderer: stackedMoney("repaidMinor", "back", "released"),
      },
      {
        field: "pFail",
        headerName: "pFail",
        width: 75,
        type: "rightAligned",
        cellClass: numCell,
        filter: "agNumberColumnFilter",
        valueFormatter: (p: ValueFormatterParams<LenderRow, number | null>) => (typeof p.value === "number" ? `${(p.value * 100).toFixed(1)}%` : ""),
      },
      money("expectedLossMinor", "Exp. loss", 105),
      {
        field: "milestoneStatus",
        headerName: "Repays from",
        width: 165,
        cellRenderer: MilestoneStateCell,
        getQuickFilterText: (p) => `${stateMeta(String(p.value)).label} ${p.data?.repaymentStatus ?? ""}`,
      },
      // Sortable and filterable from the column menu, folded into the cells above on screen.
      { ...money("repaidMinor", "Repaid", 110), hide: true },
      { ...money("feeMinor", "Fee", 95), hide: true },
      {
        field: "daysOutstanding",
        headerName: "Days out",
        hide: true,
        filter: "agNumberColumnFilter",
      },
    ];
  }, [share, clients.length]);

  const cell = "p-5 sm:p-6";

  return (
    <>
      {/* Instrument panel: the headline figure and where it waits, then three readouts. */}
      <Panel padded={false} aria-label="Book summary">
        <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className={cx(cell, "border-b border-hairline md:border-r")}>
            <Stat
              size="xl"
              tone="funded"
              label="Outstanding principal"
              minor={s.outstandingMinor}
              currency={s.currency}
              hint={
                <>
                  <span className="font-mono tabular">{s.openCount}</span> open advance{s.openCount === 1 ? "" : "s"}
                  {s.pendingPayoutMinor > 0 ? (
                    <>
                      , <span className="font-mono tabular">{formatMoney(s.pendingPayoutMinor, s.currency)}</span> awaiting payout
                    </>
                  ) : null}
                </>
              }
            />
          </div>
          <div className={cx(cell, "border-b border-hairline")}>
            <p className="type-label text-fg-faint">Waiting on</p>
            {states.length === 0 ? (
              <p className="mt-4 text-[13px] text-fg-muted">Nothing outstanding. Every advance is repaid or still on offer.</p>
            ) : (
              <>
                <div aria-hidden className="mt-4 flex h-2 w-full gap-[2px]">
                  {states.map((e) => (
                    <span
                      key={e.state}
                      data-tone={stateMeta(e.state).tone}
                      className="h-full rounded-full bg-tone"
                      style={{
                        width: `${Math.round((e.minor / s.outstandingMinor) * 1000) / 10}%`,
                      }}
                    />
                  ))}
                </div>
                <ul className="mt-4 grid gap-x-6 gap-y-2 sm:grid-cols-2">
                  {states.map((e) => {
                    const meta = stateMeta(e.state);
                    return (
                      <li key={e.state} data-tone={meta.tone} className="flex items-baseline gap-2 text-[13px]">
                        <StateGlyph glyph={meta.glyph} className="translate-y-[1px] text-tone" />
                        <span className="text-fg-muted">{meta.label}</span>
                        <span aria-hidden className="leader" />
                        <Money minor={e.minor} currency={s.currency} />
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>
        <div className="grid md:grid-cols-3">
          <div className={cx(cell, "border-b border-hairline md:border-r md:border-b-0")}>
            <Stat
              tone={s.expectedLossMinor > 0 ? "held" : undefined}
              label="Expected loss"
              minor={s.expectedLossMinor}
              currency={s.currency}
              hint={
                s.outstandingMinor > 0 ? (
                  <>
                    <span className="font-mono tabular">{pct(lossShare)}</span> of outstanding, pFail × balance
                  </>
                ) : (
                  "Nothing outstanding"
                )
              }
            />
            <Meter share={lossShare} tone="held" className="mt-4" />
          </div>
          <div className={cx(cell, "border-b border-hairline md:border-r md:border-b-0")}>
            <Stat
              tone={concentrated ? "held" : undefined}
              label="Top client concentration"
              value={s.topClient ? Math.round(s.topClient.shareOfOutstanding * 100) : 0}
              suffix="%"
              hint={
                s.topClient ? (
                  <>
                    {s.topClient.name}, across <span className="font-mono tabular">{s.clientCount}</span> client{s.clientCount === 1 ? "" : "s"}
                  </>
                ) : (
                  "No outstanding advances"
                )
              }
            />
            {clients.length > 0 ? (
              <div className="mt-4" data-tone={concentrated ? "held" : "neutral"}>
                <div aria-hidden className="flex h-[3px] w-full gap-[2px]">
                  {clients.map((c, i) => (
                    <span
                      key={c.id}
                      className={cx("h-full rounded-full", i === 0 && concentrated ? "bg-tone" : CLIENT_INK[Math.min(i, CLIENT_INK.length - 1)])}
                      style={{
                        width: `${Math.round((c.minor / s.outstandingMinor) * 1000) / 10}%`,
                      }}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <Meter share={0} tone="neutral" className="mt-4" />
            )}
          </div>
          <div className={cell}>
            <Stat
              tone="released"
              label="Repaid this week"
              minor={s.repaidThisWeekMinor}
              currency={s.currency}
              hint={
                <>
                  <span className="font-mono tabular">{s.repaidThisWeekCount}</span> advance{s.repaidThisWeekCount === 1 ? "" : "s"}, principal and fees
                </>
              }
            />
          </div>
        </div>
      </Panel>
      {s.otherCurrencies.length > 0 ? (
        <p className="mt-3 font-mono text-[11px] text-fg-faint">
          Totals are in {s.currency}; advances in {s.otherCurrencies.join(", ")} are listed below but not totalled.
        </p>
      ) : null}

      <section className="mt-12" aria-label="Advances">
        <SectionTitle
          eyebrow={
            <>
              Advances <span className="font-mono tabular text-fg-muted">{rows.length}</span>
            </>
          }
          title="Every advance, one line"
          actions={
            rows.length > 0 ? (
              <input
                type="search"
                value={quick}
                onChange={(e) => setQuick(e.target.value)}
                placeholder="Filter the book"
                aria-label="Filter the book"
                className={cx(inputClass, "h-9 w-56 py-1 text-[13px] sm:w-64")}
              />
            ) : null
          }
        />
        {rows.length === 0 ? (
          <EmptyState
            title="No advances yet"
            body="When a freelancer takes an advance on a funded milestone, it lands here: paid out from your PayPal account, repaid first out of that milestone's release."
          />
        ) : (
          <>
            {/* Phones: the same book as a stacked ledger; the grid's columns need a desktop width. */}
            <Panel variant="solid" padded={false} className="md:hidden">
              <ol className="divide-y divide-hairline">
                {rows
                  .filter(
                    (r) => !quick || `${r.milestone} ${r.freelancer} ${r.client} ${r.repaymentStatus} ${r.status}`.toLowerCase().includes(quick.toLowerCase()),
                  )
                  .map((r) => {
                    const sh = share.get(r.clientId) ?? 0;
                    const pill = ADVANCE_PILL[r.status];
                    return (
                      <li key={r.id} className="grid grid-cols-[minmax(0,1fr)] gap-3 px-4 py-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Link
                              href={`/contracts/${r.contractId}`}
                              className="block truncate text-fg underline decoration-hairline-strong underline-offset-[3px]"
                            >
                              {r.milestone}
                            </Link>
                            <p className="mt-1 truncate text-[12px] text-fg-faint">
                              {r.freelancer}
                              {r.daysOutstanding !== null ? <span className="font-mono tabular"> · {r.daysOutstanding}d out</span> : null}
                            </p>
                          </div>
                          <StatePill state={pill.state} label={pill.label} />
                        </div>
                        <dl className="grid grid-cols-3 gap-3 font-mono text-[12px] tabular">
                          <div>
                            <dt className="type-label text-[10px] text-fg-faint">Principal</dt>
                            <dd className="mt-1">
                              <Money minor={r.principalMinor} currency={r.currency} />
                            </dd>
                          </div>
                          <div>
                            <dt className="type-label text-[10px] text-fg-faint">Out</dt>
                            <dd className="mt-1">
                              <Money minor={r.outstandingMinor} currency={r.currency} className={r.outstandingMinor === 0 ? "opacity-50" : undefined} />
                            </dd>
                          </div>
                          <div className="text-right">
                            <dt className="type-label text-[10px] text-fg-faint">pFail</dt>
                            <dd className="mt-1 text-fg">{typeof r.pFail === "number" ? `${(r.pFail * 100).toFixed(1)}%` : "none"}</dd>
                          </div>
                        </dl>
                        <div className="flex items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-2">
                            <StatePill state={r.milestoneStatus} />
                            <span
                              data-tone={r.milestoneStatus === "held" ? "held" : undefined}
                              className={cx("truncate text-[12px]", r.milestoneStatus === "held" ? "text-tone" : "text-fg-faint")}
                            >
                              {r.repaymentStatus}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-fg-faint tabular">
                            <span aria-hidden className="relative block h-[3px] w-10 overflow-hidden rounded-full bg-hairline">
                              <span
                                className="absolute inset-y-0 left-0 rounded-full bg-fg/45"
                                style={{
                                  width: `${Math.round(sh * 1000) / 10}%`,
                                }}
                              />
                            </span>
                            {pct(sh)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
              </ol>
            </Panel>
            <Panel
              variant="solid"
              padded={false}
              className="hidden overflow-hidden md:block [&_.ag-header-cell-text]:tracking-[0.12em] [&_.ag-header-cell-text]:uppercase [&_.ag-paging-panel]:font-mono [&_.ag-paging-panel]:text-[11.5px] [&_.ag-paging-panel]:text-fg-faint"
            >
              <AgGridReact<LenderRow>
                theme={bookTheme}
                rowData={rows}
                columnDefs={cols}
                defaultColDef={{
                  sortable: true,
                  filter: true,
                  resizable: true,
                  suppressHeaderFilterButton: true,
                }}
                quickFilterText={quick}
                domLayout="autoHeight"
                pagination={rows.length > 20}
                paginationPageSize={20}
                paginationPageSizeSelector={[10, 20, 50, 100]}
                getRowId={(p) => p.data.id}
                overlayNoRowsTemplate="No advances match."
              />
            </Panel>
          </>
        )}
      </section>
    </>
  );
}

/** A 3px gauge: share of a whole, filled in a state's colour. */
function Meter({ share, tone, className }: { share: number; tone: ToneKey; className?: string }) {
  const w = Math.max(0, Math.min(1, share));
  return (
    <span aria-hidden data-tone={tone} className={cx("relative block h-[3px] w-full overflow-hidden rounded-full bg-hairline", className)}>
      <span className="absolute inset-y-0 left-0 rounded-full bg-tone" style={{ width: `${Math.round(w * 1000) / 10}%` }} />
    </span>
  );
}
