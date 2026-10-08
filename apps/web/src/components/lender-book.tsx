"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams, ValueFormatterParams } from "ag-grid-community";
import { gridTheme } from "./ag-grid-theme";
import { formatMoney } from "@/lib/format";

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
  pFail: number | null;
  expectedLossMinor: number | null;
  repaymentStatus: string;
  createdAt: string;
  fundedAt: string | null;
  repaidAt: string | null;
}

const WEEK_MS = 7 * 86_400_000;

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

/** Pure. Totals for the book's main currency (the one with the most advances); funded advances are outstanding. */
export function summarize(rows: LenderRow[], now: Date): BookSummary {
  const byCurrency = new Map<string, number>();
  for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + 1);
  const currency = [...byCurrency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "USD";
  const mine = rows.filter((r) => r.currency === currency);
  const open = mine.filter((r) => r.status === "funded");
  const outstandingMinor = open.reduce((s, r) => s + r.principalMinor, 0);
  const byClient = new Map<string, { name: string; minor: number }>();
  for (const r of open) {
    const c = byClient.get(r.clientId) ?? { name: r.client, minor: 0 };
    c.minor += r.principalMinor;
    byClient.set(r.clientId, c);
  }
  const top = [...byClient.values()].sort((a, b) => b.minor - a.minor)[0];
  const weekAgo = now.getTime() - WEEK_MS;
  const repaid = mine.filter((r) => r.status === "repaid" && r.repaidAt && new Date(r.repaidAt).getTime() >= weekAgo);
  return {
    currency,
    outstandingMinor,
    pendingPayoutMinor: mine.filter((r) => r.status === "offered").reduce((s, r) => s + r.principalMinor, 0),
    openCount: open.length,
    expectedLossMinor: open.reduce((s, r) => s + (r.expectedLossMinor ?? 0), 0),
    topClient: top && outstandingMinor > 0 ? { name: top.name, shareOfOutstanding: top.minor / outstandingMinor } : null,
    clientCount: byClient.size,
    repaidThisWeekMinor: repaid.reduce((s, r) => s + r.principalMinor + r.feeMinor, 0),
    repaidThisWeekCount: repaid.length,
    otherCurrencies: [...byCurrency.keys()].filter((c) => c !== currency),
  };
}

function Card({ label, value, note, tone = "default" }: { label: string; value: string; note: string; tone?: "default" | "warn" }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-amber-700 dark:text-amber-400" : ""}`}>{value}</p>
      <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{note}</p>
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  offered: "bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-300",
  funded: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300",
  repaid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  shortfall: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

function StatusCell(p: ICellRendererParams<LenderRow, string>) {
  if (!p.value) return null;
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[p.value] ?? ""}`}>{p.value}</span>;
}

function MilestoneCell(p: ICellRendererParams<LenderRow, string>) {
  if (!p.data) return null;
  return (
    <Link href={`/contracts/${p.data.contractId}`} className="underline decoration-zinc-300 underline-offset-2 hover:decoration-zinc-600">
      {p.value}
    </Link>
  );
}

const moneyFmt = (p: ValueFormatterParams<LenderRow, number | null>) => (p.value === null || p.value === undefined || !p.data ? "" : formatMoney(p.value, p.data.currency));

/** The capital partner's book: summary cards and one AG Grid row per advance. */
export function LenderBook({ rows, now }: { rows: LenderRow[]; now: string }) {
  const [quick, setQuick] = useState("");
  const s = useMemo(() => summarize(rows, new Date(now)), [rows, now]);
  const money = (minor: number) => formatMoney(minor, s.currency);

  const cols = useMemo<ColDef<LenderRow>[]>(
    () => [
      { field: "freelancer", headerName: "Freelancer", width: 150 },
      { field: "client", headerName: "Client", width: 140 },
      { field: "milestone", headerName: "Milestone", flex: 1, minWidth: 200, cellRenderer: MilestoneCell },
      { field: "principalMinor", headerName: "Principal", width: 115, type: "rightAligned", valueFormatter: moneyFmt, filter: "agNumberColumnFilter" },
      { field: "feeMinor", headerName: "Fee", width: 95, type: "rightAligned", valueFormatter: moneyFmt, filter: "agNumberColumnFilter" },
      { field: "status", headerName: "Status", width: 110, cellRenderer: StatusCell },
      { field: "daysOutstanding", headerName: "Days out", width: 100, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => (p.value === null || p.value === undefined ? "" : String(p.value)) },
      { field: "pFail", headerName: "pFail", width: 90, type: "rightAligned", filter: "agNumberColumnFilter", valueFormatter: (p) => (typeof p.value === "number" ? `${(p.value * 100).toFixed(1)}%` : "") },
      { field: "expectedLossMinor", headerName: "Expected loss", width: 125, type: "rightAligned", valueFormatter: moneyFmt, filter: "agNumberColumnFilter" },
      { field: "repaymentStatus", headerName: "Repayment", width: 170 },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card
          label="Outstanding principal"
          value={money(s.outstandingMinor)}
          note={`${s.openCount} funded advance${s.openCount === 1 ? "" : "s"}${s.pendingPayoutMinor > 0 ? `, ${money(s.pendingPayoutMinor)} awaiting payout` : ""}`}
        />
        <Card
          label="Expected loss"
          value={money(s.expectedLossMinor)}
          note={s.outstandingMinor > 0 ? `${((s.expectedLossMinor / s.outstandingMinor) * 100).toFixed(1)}% of outstanding` : "nothing outstanding"}
        />
        <Card
          label="Top client concentration"
          value={s.topClient ? `${Math.round(s.topClient.shareOfOutstanding * 100)}%` : "none"}
          note={s.topClient ? `${s.topClient.name}, across ${s.clientCount} client${s.clientCount === 1 ? "" : "s"}` : "no outstanding advances"}
          tone={s.topClient && s.topClient.shareOfOutstanding > 0.5 && s.clientCount > 1 ? "warn" : "default"}
        />
        <Card label="Repaid this week" value={money(s.repaidThisWeekMinor)} note={`${s.repaidThisWeekCount} advance${s.repaidThisWeekCount === 1 ? "" : "s"}, principal and fees`} />
      </div>
      {s.otherCurrencies.length > 0 ? <p className="text-xs text-zinc-500">Totals are in {s.currency}; advances in {s.otherCurrencies.join(", ")} are listed below but not totalled.</p> : null}

      <input
        type="search"
        value={quick}
        onChange={(e) => setQuick(e.target.value)}
        placeholder="Quick filter"
        aria-label="Quick filter"
        className="w-64 rounded border border-zinc-300 px-2 py-1 text-sm dark:border-zinc-700 dark:bg-transparent"
      />
      <div style={{ height: 480 }}>
        <AgGridReact<LenderRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={cols}
          defaultColDef={{ sortable: true, filter: true, resizable: true }}
          quickFilterText={quick}
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={[10, 20, 50, 100]}
          getRowId={(p) => p.data.id}
          overlayNoRowsTemplate="No advances yet."
        />
      </div>
    </div>
  );
}
