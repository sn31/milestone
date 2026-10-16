import { asNumber as num, asRecord as obj, asString as str } from "@milestone/core";
import { Hash, Panel, StatePill, cx, type ToneKey } from "@/components/ui";
import { formatDateTime, formatMoney } from "@/lib/format";
import { ReconcileButton } from "./reconcile-button";

/** The audit events the worker's reconcile job writes (apps/worker/src/jobs/reconcile.ts). */
export const RECONCILE_EVENTS = { reconciled: "ops.reconciled", failed: "ops.reconcile_failed" } as const;

export interface ReconcileRow {
  id: string;
  event: string;
  detail: unknown;
  createdAt: Date;
}

const when = (iso: string | null) => (iso ? formatDateTime(iso) : "?");
const amount = (minor: unknown, currency: unknown) => (num(minor) !== null && str(currency) ? formatMoney(Math.abs(num(minor)!), str(currency)!) : "no amount");
const list = (v: unknown) => (Array.isArray(v) ? v.map(obj) : []);

/**
 * The latest reconciliation of PayPal's transactions against Milestone's records, read through PayPal's MCP server.
 * A card of its own, apart from the operator cases: a mismatch flags it for a person, and no milestone changes state.
 */
export function ReconciliationCard({ row, canAct }: { row: ReconcileRow | null; canAct: boolean }) {
  const d = obj(row?.detail);
  const failed = row?.event === RECONCILE_EVENTS.failed;
  const simulated = d.simulated === true;
  const counts = obj(d.counts);
  const missingInLedger = num(counts.missingInLedger) ?? 0;
  const missingInPayPal = num(counts.missingInPayPal) ?? 0;
  const mismatched = num(counts.amountMismatches) ?? 0;
  const flagged = missingInLedger + missingInPayPal + mismatched;
  const tone: ToneKey | undefined = !row ? undefined : failed || flagged > 0 ? "danger" : "released";
  const window = obj(d.window);

  const figures: Array<{ label: string; value: number | null; tone?: ToneKey }> = [
    { label: "PayPal rows", value: num(d.paypalCount) },
    { label: "Matched", value: num(d.matched), tone: "released" },
    { label: "Not in ledger", value: missingInLedger, tone: missingInLedger ? "danger" : undefined },
    { label: "Not on PayPal", value: missingInPayPal, tone: missingInPayPal ? "danger" : undefined },
    { label: "Amount differs", value: mismatched, tone: mismatched ? "danger" : undefined },
  ];

  const lines = [
    ...list(d.missingInLedger).map((t) => ({ key: `l${str(t.id)}`, label: "not in ledger", id: str(t.id) ?? "?", text: `${str(t.eventCode) ?? "?"} · ${amount(t.amountMinor, t.currency)} · ${when(str(t.at))}` })),
    ...list(d.missingInPayPal).map((t) => ({ key: `p${str(t.opKey)}${str(t.party)}${str(t.kind)}`, label: "not on PayPal", id: (Array.isArray(t.ids) ? str(t.ids[0]) : null) ?? str(t.opKey) ?? "?", text: `${str(t.kind) ?? "?"}${str(t.party) ? ` ${str(t.party)}` : ""} · ${str(t.opKey) ?? ""} · ${amount(t.amountMinor, t.currency)}` })),
    ...list(d.amountMismatches).map((t) => ({ key: `a${str(t.id)}`, label: "amount differs", id: str(t.id) ?? "?", text: `${str(t.kind) ?? "?"} · PayPal ${amount(t.paypalMinor, t.paypalCurrency)} · ledger ${num(t.ledgerMinor) === null ? "nothing booked" : amount(t.ledgerMinor, t.ledgerCurrency)}` })),
  ].slice(0, 8);

  return (
    <Panel as="article" variant="solid" tone={tone} padded={false} aria-label="Reconciliation">
      <header className="flex flex-col gap-4 border-b border-hairline px-5 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-[11px] text-fg-faint tabular">
            <span className="text-tone">RECONCILIATION</span>
            {row ? <StatePill state={failed ? "failed" : flagged ? "held" : "released"} label={failed ? "Failed" : flagged ? `${flagged} to check` : "Matched"} /> : null}
            {simulated ? <StatePill state="draft" label="Simulated" /> : null}
            <span>via PayPal MCP · list_transactions</span>
          </div>
          <h2 className="type-display-s mt-2 text-fg">{row ? `${when(str(window.start))} to ${when(str(window.end))}` : "Not reconciled yet"}</h2>
          <p className="mt-1 max-w-[70ch] text-[13px] leading-relaxed text-fg-muted">
            {row
              ? failed
                ? "PayPal did not answer the transaction search. Nothing was compared; the next run covers this window again."
                : (str(d.summary) ?? "")
              : "Reads PayPal's transactions for a window that ends a few hours back (Transaction Search lags) and matches every id and amount against the payouts, refunds, captures and ledger Milestone recorded. It moves no money."}
          </p>
          {row ? (
            <p className="mt-1 font-mono text-[11px] text-fg-faint tabular">
              ran {formatDateTime(row.createdAt)}
              {num(window.lagHours) ? ` · lag ${num(window.lagHours)}h` : ""}
              {num(d.ignored) ? ` · ${num(d.ignored)} balance holds set aside` : ""}
            </p>
          ) : null}
        </div>
        <ReconcileButton latestId={row?.id ?? null} disabled={!canAct} />
      </header>

      {row && failed ? (
        <div data-tone="danger" className="px-5 py-4 sm:px-6">
          <p className="type-label text-tone">PayPal said</p>
          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded-panel border border-hairline bg-surface-sunken p-3 font-mono text-[12px] text-fg">
            {str(d.error) ?? "unknown error"}
            {d.body ? `\n${JSON.stringify(d.body, null, 2)}` : ""}
          </pre>
        </div>
      ) : row ? (
        <>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 px-5 py-4 sm:grid-cols-5 sm:px-6">
            {figures.map((f) => (
              <div key={f.label} data-tone={f.tone} className="min-w-0">
                <dt className="type-label flex items-center gap-2 text-fg-faint">
                  <span aria-hidden className={cx("size-1.5 rounded-full", f.tone ? "bg-tone" : "border border-hairline-strong")} />
                  {f.label}
                </dt>
                <dd className={cx("mt-1 font-mono text-[22px] tabular", f.tone ? "text-tone" : "text-fg")}>{f.value ?? "?"}</dd>
              </div>
            ))}
          </dl>
          {lines.length ? (
            <ul className="divide-y divide-hairline border-t border-hairline px-5 sm:px-6">
              {lines.map((l) => (
                <li key={l.key} data-tone="danger" className="grid grid-cols-[minmax(0,1fr)] gap-1 py-2.5 sm:grid-cols-[8.5rem_auto_minmax(0,1fr)] sm:items-center sm:gap-3">
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-tone">{l.label}</span>
                  <Hash value={l.id} label="id" />
                  <span className="min-w-0 font-mono text-[12px] text-fg-muted">{l.text}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
