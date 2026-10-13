"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import { gridThemeInset } from "./ag-grid-theme";
import { useNarrow } from "@/components/ui/detail-grid";
import { formatMoney, formatNumber } from "@/lib/format";
import { EmptyState, Money, Panel, SectionTitle, Stat, StateGlyph, StatePill, cx, inputClass, stateMeta, type ToneKey } from "@/components/ui";

export interface LenderRow {
  id: string;
  contractId: string;
  freelancer: string;
  /** The capital partner who funded the advance; concentration is measured within a partner's own book. */
  partnerId: string;
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

/** Outstanding principal owed through one client. */
export interface ClientExposure {
  id: string;
  name: string;
  minor: number;
}

/** Outstanding principal waiting on milestones in one state. */
export interface StateExposure {
  state: string;
  minor: number;
  count: number;
}

export interface BookSummary {
  currency: string;
  /** The main currency's advances with principal still outstanding. */
  open: LenderRow[];
  /** Their outstanding principal per client, largest first. */
  clients: ClientExposure[];
  /** And by the state of the milestone that repays it. */
  states: StateExposure[];
  outstandingMinor: number;
  pendingPayoutMinor: number;
  openCount: number;
  expectedLossMinor: number;
  /** expectedLossMinor as a share of outstandingMinor (0 with nothing outstanding). */
  lossShare: number;
  topClient: { name: string; shareOfOutstanding: number } | null;
  clientCount: number;
  repaidThisWeekMinor: number;
  repaidThisWeekCount: number;
  /** Principal ever paid out (every advance that left the partner's account), and principal + fees ever repaid. */
  lifetimeAdvancedMinor: number;
  lifetimeAdvancedCount: number;
  lifetimeRepaidMinor: number;
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
  const expectedLossMinor = open.reduce((s, r) => s + (r.expectedLossMinor ?? 0), 0);
  const clients = clientExposure(open);
  const top = clients[0];
  const repaid = mine.filter((r) => r.repaidThisWeekMinor > 0);
  return {
    currency,
    open,
    clients,
    states: exposureByState(open),
    outstandingMinor,
    pendingPayoutMinor: mine.filter((r) => r.status === "offered").reduce((s, r) => s + r.principalMinor, 0),
    openCount: open.length,
    expectedLossMinor,
    lossShare: outstandingMinor > 0 ? expectedLossMinor / outstandingMinor : 0,
    topClient: top && outstandingMinor > 0 ? { name: top.name, shareOfOutstanding: top.minor / outstandingMinor } : null,
    clientCount: clients.length,
    repaidThisWeekMinor: repaid.reduce((s, r) => s + r.repaidThisWeekMinor, 0),
    repaidThisWeekCount: repaid.length,
    lifetimeAdvancedMinor: mine.filter((r) => r.status !== "offered").reduce((t, r) => t + r.principalMinor, 0),
    lifetimeAdvancedCount: mine.filter((r) => r.status !== "offered").length,
    lifetimeRepaidMinor: mine.reduce((t, r) => t + r.repaidMinor, 0),
    otherCurrencies: [...byCurrency.keys()].filter((c) => c !== currency),
  };
}

/** Pure. Outstanding principal per client, largest first. */
function clientExposure(open: LenderRow[]): ClientExposure[] {
  const byClient = new Map<string, ClientExposure>();
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
function exposureByState(open: LenderRow[]): StateExposure[] {
  const order = ["funded", "verifying", "review", "needs_client", "held", "draft", "released", "partial_released"];
  const m = new Map<string, StateExposure>();
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

// The shared inset theme (ag-grid-theme.ts): every value a design token, so the grid follows light and dark on its own.
// Taller rows for the stacked cells; the pinned book total sits in a sunken well above the advances.
const bookTheme = gridThemeInset.withParams({
  rowHeight: 56,
  pinnedRowBackgroundColor: "var(--surface-sunken)",
  pinnedRowTextColor: "var(--fg)",
  pinnedRowFontWeight: 400,
  pinnedRowBorder: { color: "var(--hairline-strong)" },
});

const numCell = "font-mono tabular text-[12.5px]";

/** A client holding more than this share of its partner's outstanding principal reads amber. */
const CONCENTRATION_LIMIT = 0.6;

/** The pinned top row's extras: what the totals cover. */
interface BookTotals {
  count: number;
  clients: number;
  lossShare: number;
  otherCurrencies: boolean;
}

/** The pinned book total: the money columns summed over the main currency's advances. */
interface TotalRow {
  kind: "total";
  id: "book-total";
  currency: string;
  principalMinor: number;
  feeMinor: number;
  outstandingMinor: number;
  repaidMinor: number;
  expectedLossMinor: number;
  totals: BookTotals;
}

type GridRow = (LenderRow & { kind: "advance" }) | TotalRow;

interface Ctx {
  share: Map<string, number>;
}

const partnerKey = (r: { partnerId: string; currency: string }) => `${r.partnerId}|${r.currency}`;
const shareKey = (r: { partnerId: string; currency: string; clientId: string }) => `${partnerKey(r)}|${r.clientId}`;

/** Pure. Each client's share of its own partner's outstanding principal (per currency), keyed by shareKey. */
function partnerShares(rows: LenderRow[]): Map<string, number> {
  const partner = new Map<string, number>();
  const client = new Map<string, number>();
  for (const r of rows) {
    if (r.outstandingMinor <= 0) continue;
    partner.set(partnerKey(r), (partner.get(partnerKey(r)) ?? 0) + r.outstandingMinor);
    client.set(shareKey(r), (client.get(shareKey(r)) ?? 0) + r.outstandingMinor);
  }
  const out = new Map<string, number>();
  for (const r of rows) {
    const total = partner.get(partnerKey(r)) ?? 0;
    out.set(shareKey(r), total > 0 ? (client.get(shareKey(r)) ?? 0) / total : 0);
  }
  return out;
}

function MoneyCell(p: ICellRendererParams<GridRow, number | null>) {
  if (p.value === null || p.value === undefined || !p.data) return <span className="text-fg-faint">none</span>;
  return <Money minor={p.value} currency={p.data.currency} className={p.value === 0 ? "opacity-50" : undefined} />;
}

/** An amount with a smaller second figure under it (principal + fee). */
function stackedMoney(second: "feeMinor", caption: string) {
  return function StackedMoneyCell(p: ICellRendererParams<GridRow, number | null>) {
    if (!p.data) return null;
    const n = p.data[second];
    return (
      <div className="flex h-full flex-col items-end justify-center gap-1 leading-tight">
        <MoneyCell {...p} />
        <span className="font-mono text-[11px] text-fg-faint tabular">
          {caption} {formatMoney(n, p.data.currency)}
        </span>
      </div>
    );
  };
}

function AdvanceCell(p: ICellRendererParams<GridRow, string>) {
  if (!p.data) return null;
  if (p.data.kind === "total") {
    const t = p.data.totals;
    return (
      <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
        <span className="type-label text-fg-muted">Book total</span>
        <span className="mt-1 truncate text-[12px] text-fg-faint">
          <span className="font-mono tabular">{t.count}</span> advance
          {t.count === 1 ? "" : "s"}
          {t.otherCurrencies ? <span className="font-mono"> · {p.data.currency} only</span> : null}
        </span>
      </div>
    );
  }
  return (
    <div className="flex h-full min-w-0 flex-col justify-center leading-tight">
      <Link
        href={`/contracts/${p.data.contractId}`}
        className="truncate text-fg underline decoration-hairline-strong underline-offset-[3px] transition-colors hover:decoration-fg-muted"
      >
        {p.value}
      </Link>
      <span className="mt-1 truncate text-[12px] text-fg-faint">
        {/* On a phone the pinned column keeps the age; the freelancer is one swipe away in the filter. */}
        <span className="max-sm:hidden">
          {p.data.freelancer}
          {p.data.daysOutstanding !== null ? " · " : ""}
        </span>
        {p.data.daysOutstanding !== null ? <span className="font-mono tabular">{p.data.daysOutstanding}d out</span> : null}
      </span>
    </div>
  );
}

/** The client, and its share of this partner's outstanding principal as a bar: amber once it passes 60%. */
function ExposureCell(p: ICellRendererParams<GridRow, string, Ctx>) {
  if (!p.data) return null;
  if (p.data.kind === "total") {
    const n = p.data.totals.clients;
    return (
      <span className="text-[12px] text-fg-faint">
        <span className="font-mono tabular">{n}</span> client
        {n === 1 ? "" : "s"} owing
      </span>
    );
  }
  const sh = p.context.share.get(shareKey(p.data)) ?? 0;
  const heavy = sh > CONCENTRATION_LIMIT;
  return (
    <div
      data-tone={heavy ? "held" : "neutral"}
      className="flex h-full min-w-0 flex-col justify-center gap-1.5 leading-tight"
      title={`${p.value}: ${pct(sh)} of this partner's outstanding principal`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-fg-muted">{p.value}</span>
        <span className={cx(numCell, "text-[11.5px]", heavy ? "text-tone" : "text-fg-faint")}>{pct(sh)}</span>
      </div>
      <Meter share={sh} fill={heavy ? "bg-tone" : "bg-fg/45"} />
    </div>
  );
}

/** Repaid so far against what the advance must bring back (principal + fee). */
function RepaymentCell(p: ICellRendererParams<GridRow, number>) {
  if (!p.data) return null;
  const r = p.data;
  const due = r.principalMinor + r.feeMinor;
  const share = due > 0 ? Math.min(1, r.repaidMinor / due) : 0;
  const shortfall = r.kind === "advance" && r.status === "shortfall";
  const done = share >= 1;
  return (
    <div
      data-tone={shortfall ? "danger" : "released"}
      className="flex h-full min-w-0 flex-col justify-center gap-1.5 leading-tight"
      title={`${formatMoney(r.repaidMinor, r.currency)} of ${formatMoney(due, r.currency)} repaid`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <Money minor={r.repaidMinor} currency={r.currency} className={cx("text-[12.5px]", r.repaidMinor === 0 && "opacity-50")} />
        <span className={cx(numCell, "text-[11.5px]", shortfall || done ? "text-tone" : r.repaidMinor > 0 ? "text-fg-muted" : "text-fg-faint")}>
          {pct(share)}
        </span>
      </div>
      {/* A shortfall keeps its unpaid remainder visible in the danger tone. */}
      <Meter share={share} tone="released" track={shortfall ? "bg-tone-soft" : undefined} />
    </div>
  );
}

/** Expected loss with the pFail it comes from; on the total, its share of outstanding. */
function LossCell(p: ICellRendererParams<GridRow, number | null>) {
  if (!p.data) return null;
  const caption =
    p.data.kind === "total"
      ? `${pct(p.data.totals.lossShare)} of out`
      : typeof p.data.pFail === "number"
        ? `pFail ${(p.data.pFail * 100).toFixed(1)}%`
        : "no pFail";
  return (
    <div className="flex h-full flex-col items-end justify-center gap-1 leading-tight">
      <MoneyCell {...p} />
      <span className="font-mono text-[11px] text-fg-faint tabular">{caption}</span>
    </div>
  );
}

function StatusCell(p: ICellRendererParams<GridRow, LenderRow["status"]>) {
  if (p.data?.kind !== "advance" || !p.value) return null;
  const pill = ADVANCE_PILL[p.value];
  return (
    <div className="flex h-full items-center">
      <StatePill state={pill.state} label={pill.label} />
    </div>
  );
}

function MilestoneStateCell(p: ICellRendererParams<GridRow, string>) {
  if (p.data?.kind !== "advance") return null;
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

/** The lender's book as an instrument panel, then one AG Grid row per advance under a pinned book total. */
export function LenderBook({ rows }: { rows: LenderRow[] }) {
  const [quick, setQuick] = useState("");
  const narrow = useNarrow();
  const s = useMemo(() => summarize(rows), [rows]);
  const { clients, states, lossShare } = s;
  const share = useMemo(() => partnerShares(rows), [rows]);
  const advances = useMemo<GridRow[]>(() => rows.map((r) => ({ ...r, kind: "advance" as const })), [rows]);
  // Same rule as the grid's exposure bars: a client past CONCENTRATION_LIMIT of the outstanding principal reads amber.
  const concentrated = !!s.topClient && s.topClient.shareOfOutstanding > CONCENTRATION_LIMIT;

  // Totals for the book's main currency; other currencies are listed but not added in (as in the stats above).
  const pinned = useMemo<TotalRow[]>(() => {
    const mine = rows.filter((r) => r.currency === s.currency);
    if (mine.length === 0) return [];
    const sum = (f: (r: LenderRow) => number) => mine.reduce((t, r) => t + f(r), 0);
    return [
      {
        kind: "total",
        id: "book-total",
        currency: s.currency,
        principalMinor: sum((r) => r.principalMinor),
        feeMinor: sum((r) => r.feeMinor),
        outstandingMinor: s.outstandingMinor,
        repaidMinor: sum((r) => r.repaidMinor),
        expectedLossMinor: s.expectedLossMinor,
        totals: {
          count: mine.length,
          clients: s.clientCount,
          lossShare,
          otherCurrencies: s.otherCurrencies.length > 0,
        },
      },
    ];
  }, [rows, s, lossShare]);

  const cols = useMemo<ColDef<GridRow>[]>(() => {
    const money = (
      field: "principalMinor" | "outstandingMinor" | "expectedLossMinor" | "repaidMinor" | "feeMinor",
      headerName: string,
      width: number,
    ): ColDef<GridRow> => ({
      field,
      headerName,
      width,
      type: "rightAligned",
      cellClass: numCell,
      cellRenderer: MoneyCell,
      filter: "agNumberColumnFilter",
      getQuickFilterText: (p) => (typeof p.value === "number" && p.data ? formatMoney(p.value, p.data.currency) : ""),
    });
    const all: ColDef<GridRow>[] = [
      {
        field: "milestone",
        headerName: "Advance on",
        flex: narrow ? undefined : 1,
        width: narrow ? 172 : undefined,
        minWidth: narrow ? 172 : 200,
        // Phones scroll the grid sideways; the advance stays in view.
        pinned: narrow ? "left" : undefined,
        cellRenderer: AdvanceCell,
        getQuickFilterText: (p) => `${p.value} ${p.data?.kind === "advance" ? p.data.freelancer : ""}`,
      },
      {
        field: "client",
        headerName: "Client",
        width: 150,
        cellRenderer: ExposureCell,
      },
      {
        field: "status",
        headerName: "Advance",
        width: 96,
        cellRenderer: StatusCell,
        getQuickFilterText: (p) => (p.value ? ADVANCE_PILL[p.value as LenderRow["status"]].label : ""),
      },
      {
        ...money("principalMinor", "Principal", 108),
        cellRenderer: stackedMoney("feeMinor", "fee"),
      },
      money("outstandingMinor", "Outstanding", 124),
      {
        colId: "repayment",
        headerName: "Repaid",
        width: 124,
        // Sorts and filters by the share repaid, 0 to 100.
        valueGetter: (p) => (p.data ? Math.round((p.data.repaidMinor / Math.max(1, p.data.principalMinor + p.data.feeMinor)) * 100) : 0),
        cellRenderer: RepaymentCell,
        filter: "agNumberColumnFilter",
      },
      {
        ...money("expectedLossMinor", "Exp. loss", 100),
        cellRenderer: LossCell,
      },
      {
        field: "milestoneStatus",
        headerName: "Repays from",
        width: 140,
        cellRenderer: MilestoneStateCell,
        getQuickFilterText: (p) => `${stateMeta(String(p.value)).label} ${p.data?.kind === "advance" ? p.data.repaymentStatus : ""}`,
      },
      // Sortable and filterable from the column menu, folded into the cells above on screen.
      {
        field: "pFail",
        headerName: "pFail",
        width: 75,
        hide: true,
        type: "rightAligned",
        filter: "agNumberColumnFilter",
        valueFormatter: (p: ValueFormatterParams<GridRow, number | null>) => (typeof p.value === "number" ? `${(p.value * 100).toFixed(1)}%` : ""),
      },
      { ...money("repaidMinor", "Repaid amount", 110), hide: true },
      { ...money("feeMinor", "Fee", 95), hide: true },
      {
        field: "daysOutstanding",
        headerName: "Days out",
        hide: true,
        filter: "agNumberColumnFilter",
      },
    ];
    if (!narrow) return all;
    // On a phone the money comes first: beside the pinned advance, what is still out, then its state and principal;
    // the client's exposure bar is a swipe away.
    const first = ["milestone", "outstandingMinor", "status", "principalMinor", "repayment"];
    const key = (c: ColDef<GridRow>) => String(c.field ?? c.colId ?? "");
    const rank = (c: ColDef<GridRow>) => (first.includes(key(c)) ? first.indexOf(key(c)) : first.length);
    return [...all].sort((a, b) => rank(a) - rank(b));
  }, [narrow]);

  const cell = "p-5 sm:p-6";
  const idle = s.outstandingMinor === 0 && rows.length > 0;

  return (
    <>
      {/* Instrument panel: the headline figure and where it waits, then three readouts. */}
      <Panel padded={false} aria-label="Book summary">
        {idle ? (
          // Nothing out: the book leads with what came back and what it has lent, not a row of zeros.
          <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            <div className={cx(cell, "border-b border-hairline md:border-r")}>
              <Stat
                size="xl"
                tone="released"
                label={s.repaidThisWeekMinor > 0 ? "Repaid this week" : "Repaid, lifetime"}
                minor={s.repaidThisWeekMinor > 0 ? s.repaidThisWeekMinor : s.lifetimeRepaidMinor}
                currency={s.currency}
                hint={
                  s.repaidThisWeekMinor > 0 ? (
                    <>
                      <span className="font-mono tabular">{s.repaidThisWeekCount}</span> advance{s.repaidThisWeekCount === 1 ? "" : "s"} back in full, principal
                      and fees
                    </>
                  ) : (
                    "Principal and fees, every advance"
                  )
                }
              />
            </div>
            <div className={cx(cell, "border-b border-hairline")}>
              <Stat
                label="Advanced, lifetime"
                minor={s.lifetimeAdvancedMinor}
                currency={s.currency}
                hint={
                  <>
                    <span className="font-mono tabular">{s.lifetimeAdvancedCount}</span> advance{s.lifetimeAdvancedCount === 1 ? "" : "s"} paid out
                    {s.pendingPayoutMinor > 0 ? (
                      <>
                        , <span className="font-mono tabular">{formatMoney(s.pendingPayoutMinor, s.currency)}</span> awaiting payout
                      </>
                    ) : null}
                  </>
                }
              />
              <p data-tone="released" className="mt-4 flex items-baseline gap-2 text-[13px] text-fg-muted">
                <StateGlyph glyph="check" className="translate-y-[1px] text-tone" />
                Nothing outstanding: every advance is repaid or still on offer.
              </p>
            </div>
          </div>
        ) : (
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
        )}
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
            {idle ? (
              <Stat label="Outstanding principal" minor={0} currency={s.currency} hint="Nothing waiting on a release" />
            ) : (
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
            )}
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
          <Panel variant="solid" padded={false} className="overflow-hidden">
            <AgGridReact<GridRow>
              // Remount across the breakpoint: the first column pins on phones only.
              key={narrow ? "narrow" : "wide"}
              theme={bookTheme}
              rowData={advances}
              columnDefs={cols}
              context={{ share } satisfies Ctx}
              pinnedTopRowData={pinned}
              defaultColDef={{
                sortable: true,
                filter: true,
                resizable: true,
                suppressHeaderFilterButton: true,
              }}
              quickFilterText={quick}
              domLayout="autoHeight"
              suppressRowVirtualisation
              suppressColumnVirtualisation
              suppressCellFocus
              pagination={rows.length > 20}
              paginationPageSize={20}
              paginationPageSizeSelector={[10, 20, 50, 100]}
              getRowId={(p) => p.data.id}
              overlayNoRowsTemplate="No advances match."
            />
          </Panel>
        )}
      </section>
    </>
  );
}

/**
 * A 3px gauge: share of a whole. The fill is in `tone` (else the surrounding tone), or in `fill` classes; the track is
 * a hairline unless `track` says otherwise.
 */
function Meter({
  share,
  tone,
  fill = "bg-tone",
  track = "bg-hairline",
  className,
}: {
  share: number;
  tone?: ToneKey;
  fill?: string;
  track?: string;
  className?: string;
}) {
  const w = Math.max(0, Math.min(1, share));
  return (
    <span aria-hidden className={cx("relative block h-[3px] w-full overflow-hidden rounded-full", track, className)}>
      <span data-tone={tone} className={cx("absolute inset-y-0 left-0 rounded-full", fill)} style={{ width: `${Math.round(w * 1000) / 10}%` }} />
    </span>
  );
}
